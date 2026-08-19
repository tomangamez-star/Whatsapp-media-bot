'use strict'

/**
 * WhatsApp connection manager (Baileys).
 *
 * Responsibilities:
 *   • lazy-start socket, auto-reconnect with exponential backoff
 *   • QR code generation (base64, for the dashboard) and pairing-code flow
 *   • session persistence in ./data/session (auth-state files)
 *   • emit lifecycle events to the bus (session.qr, session.connected, …)
 *   • session controls: disconnect / reconnect / logout
 *
 * Pairing reliability notes (root causes of "QR/pairing won't connect"):
 *   1. The WhatsApp Web version advertised by the socket MUST be one that
 *      WhatsApp's servers currently accept. fetchLatestBaileysVersion() hits
 *      GitHub's raw master file; if the fetch fails (or the master version is
 *      newer than what WA accepts / older than what the client library needs)
 *      the connection can be rejected at the noise/registration handshake —
 *      the QR/ pairing code then never completes. We therefore PIN a known-good
 *      WA Web version (BAILEYS_WA_VERSION, default 2.3000.1043857760 — the
 *      version bundled with Baileys 6.7.x) instead of trusting the fetch.
 *   2. requestPairingCode() must only be called once the socket has a live,
 *      noise-encrypted, ready websocket. Calling it while still connecting
 *      yields HTTP 428 "Precondition Required / Connection Closed" from WA.
 *      We wait for 'open' / 'connecting' via waitForConnectionUpdate() first.
 *   3. A QR shown on the dashboard must be the CURRENT one — WA rotates QRs
 *      roughly every 20s. The dashboard polls /api/session every 5s; the
 *      backend additionally re-renders on every fresh qr event and keeps the
 *      QR "age" in the status so the UI can warn when a scan is imminent.
 */

const fs = require('fs')
const path = require('path')
const qrcode = require('qrcode')
const config = require('../config')
const bus = require('../events')
const logger = require('../logger')
const { handleMessage } = require('./commands')

// Baileys >= 6.7 is ESM-only; a static require() of it throws ERR_REQUIRE_ESM on
// Node < 20.19 (require(esm) default). Load it lazily via dynamic import(), which
// works on every supported Node version (18+). `bw` is set by preloadBaileys()
// before the first connection attempt.
let bw = null

/** Resolve which WhatsApp Web version to advertise. */
function resolveWAVersion () {
  const env = String(process.env.BAILEYS_WA_VERSION || '').trim()
  if (env) {
    const parts = env.split('.').map((n) => parseInt(n, 10))
    if (parts.length === 3 && parts.every((n) => Number.isInteger(n) && n >= 0)) {
      return parts
    }
    logger.warn('[conn] BAILEYS_WA_VERSION "%s" invalid — using default', env)
  }
  // Default: the version bundled with Baileys 6.7.x. Do NOT blindly trust
  // fetchLatestBaileysVersion() (GitHub raw fetch — flaky in sandboxes/Render;
  // and a too-new advertised version gets rejected during pairing handshake).
  return [2, 3000, 1043857760]
}

async function preloadBaileys () {
  if (bw) return bw
  const timer = setTimeout(() => {
    logger.warn('[conn] Baileys import is taking a long time — continuing to wait')
  }, 15000)
  timer.unref?.()
  try {
    const mod = await import('@whiskeysockets/baileys')
    bw = {
      default: mod.default,
      makeWASocket: mod.default,
      useMultiFileAuthState: mod.useMultiFileAuthState,
      DisconnectReason: mod.DisconnectReason,
      fetchLatestBaileysVersion: mod.fetchLatestBaileysVersion,
      Browsers: mod.Browsers
    }
    return bw
  } finally {
    clearTimeout(timer)
  }
}

const SESSION_DIR = config.session.dir

class Connection {
  constructor () {
    this.sock = null
    this.state = 'idle' // idle | connecting | qr | pairing | connected | disconnected | closed
    this.qr = null // base64 data URL
    this.pairingCode = null
    this.lastDisconnect = null
    this.registerError = null
    this.startedAt = null
    this.connectAttempt = 0
    this.manualClose = false
    this.loggedOut = false
    this.version = null
    this.phone = null
    this.refreshTimeout = null
    this.stopRequested = false
    this.pairingReady = false
    this.socketGeneration = 0
  }

  /** Public info for dashboard/API. */
  status () {
    return {
      state: this.state,
      connected: this.state === 'connected',
      qr: this.qr,
      qrAgeSec: this.qrAt ? Math.floor((Date.now() - this.qrAt) / 1000) : 0,
      pairingCode: this.pairingCode,
      phone: this.phone,
      lastDisconnect: this.lastDisconnect,
      registerError: this.registerError,
      uptimeSec: this.connectedAt ? Math.floor((Date.now() - this.connectedAt) / 1000) : 0,
      version: this.version,
      mediaQueued: this.mediaQueueSize?.() ?? 0
    }
  }

  async start () {
    if (this.sock || this.stopRequested) return
    this.stopRequested = false
    this.startedAt = Date.now()
    this.manualClose = false
    if (config.session.forceLogout) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true })
      logger.info('[conn] FORCE_LOGOUT — cleared saved session')
    }
    fs.mkdirSync(SESSION_DIR, { recursive: true })

    try {
      await preloadBaileys()
    } catch (err) {
      logger.error('[conn] failed to load Baileys: %s', err.message)
      throw err
    }

    await this.connect()
  }

  async connect () {
    if (this.stopRequested) return
    this.connectAttempt++
    this.state = this.connectAttempt === 1 ? 'connecting' : 'reconnecting'
    this.qr = null
    this.pairingCode = null
    this.pairingReady = false
    const generation = ++this.socketGeneration
    bus.emitSafe('session.status', { state: this.state, at: new Date().toISOString() })

    try {
      if (!bw) await preloadBaileys()
      const { makeWASocket, useMultiFileAuthState, DisconnectReason } = bw
      // Use the pinned, known-good WhatsApp Web version (BAILEYS_WA_VERSION or
      // the version bundled with Baileys 6.7.x). Avoids a flaky GitHub fetch
      // and any version mismatch during the pairing handshake.
      const version = resolveWAVersion()
      this.version = version
      logger.info('[conn] using WhatsApp Web version %s', version.join('.'))

      const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR)

      const sock = makeWASocket({
        version,
        auth: authState,
        browser: bw.Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        // Proxy escape-hatch: WhatsApp often rejects / rate-limits pairing from
        // datacenter IPs (Render, VPS, cloud). Baileys accepts a Node http(s)/
        // socks agent as `agent`. Set PROXY_URL (e.g. socks5h://user:pass@host:1080
        // or http://user:pass@host:3128) to route the WhatsApp WebSocket through a
        // residential/mobile proxy and pair from a trusted IP. Optional — empty by
        // default. NOTE: this only wraps the WebSocket; media downloads still use
        // yt-dlp directly (see downloader.js for its own proxy support).
        agent: config.session.proxyAgent,
        // Pairing-code reliability: without an explicit query timeout, a slow WA
        // reply can time out with "Error: Connection Closed" while
        // requestPairingCode() is in flight (WhiskeySockets/Baileys#2008).
        defaultQueryTimeoutMs: 60000,
        logger: logger.child({ module: 'baileys' })
      })
      this.sock = sock

      sock.ev.on('creds.update', saveCreds)

      sock.ev.on('connection.update', async (update) => {
        // A socket that was replaced by reconnect/reset may still emit a late
        // close event. Never let that stale event tear down the new socket.
        if (generation !== this.socketGeneration || this.sock !== sock) return
        const { connection, lastDisconnect, qr, registerError } = update
        // A failed registration attempt (QR/pairing rejected by WA) — surface the
        // REAL reason (e.g. 429 rate-overlimit, 401 bad session) instead of a blind
        // "disconnected". The dashboard shows this prominently.
        if (registerError) {
          const re = registerError?.output || registerError
          this.registerError = {
            code: re.statusCode ?? 'unknown',
            reason: re.payload?.message || registerError?.message || String(registerError),
            at: new Date().toISOString()
          }
          logger.error('[conn] registerError: %s', this.registerError.reason)
        }
        if (qr) {
          this.pairingReady = true
          // Keep a fresh QR on screen, but never clobber an active pairing flow.
          if (this.state !== 'pairing') {
            this.state = 'qr'
            this.qr = await qrcode.toDataURL(qr, { width: 360, margin: 1 })
            this.qrAt = Date.now()
            this.pairingCode = null
            bus.emitSafe('session.qr', { qr: this.qr, at: new Date().toISOString() })
            bus.emitSafe('session.status', { state: 'qr', at: new Date().toISOString() })
          }
          this.scheduleQrRefresh()
        }
        if (connection === 'open') {
          this.pairingReady = true
          this.state = 'connected'
          this.connectedAt = Date.now()
          this.phone = sock.user?.id?.split(':')[0] || null
          this.qr = null
          this.pairingCode = null
          this.lastDisconnect = null
          this.connectAttempt = 0
          bus.emitSafe('session.connected', { phone: this.phone, at: new Date().toISOString() })
          bus.emitSafe('session.status', { state: 'connected', phone: this.phone, at: new Date().toISOString() })
          logger.info('[conn] connected as %s', this.phone || 'unknown')
        }
        if (connection === 'close') {
          const boomErr = lastDisconnect?.error
          const code = boomErr?.output?.statusCode
          let detail = ''
          try { detail = boomErr?.output?.payload?.message || boomErr?.message || '' } catch { /* ignore */ }

          let reason = DisconnectReason[code] || code || 'unknown'
          if (code === 429) reason = 'WhatsApp HTTP 429 (rate limit)'
          if (code === 401) reason = 'WhatsApp 401 (session rejected/logged out)'

          this.lastDisconnect = { code, reason, detail, at: new Date().toISOString() }
          this.state = 'disconnected'
          this.qr = null
          this.pairingCode = null
          this.pairingReady = false
          this.sock = null
          bus.emitSafe('session.disconnected', { code, reason, detail, at: new Date().toISOString() })
          bus.emitSafe('session.status', { state: 'disconnected', reason, detail, at: new Date().toISOString() })
          logger.warn('[conn] disconnected — statusCode=%s reason=%s%s', code ?? '?', reason, detail ? ` detail="${detail}"` : '')

          // Do not invent a rate-limit from a 401. A real upstream 429 is left
          // visible as 429. A 401 is treated as a rejected/stale session; a new
          // pairing request will clear the auth directory and start fresh.
          if (code === 401) this.loggedOut = true

          // Never auto-hammer WhatsApp after an actual 429 or a rejected 401.
          // Other transient disconnects keep the normal reconnect behavior.
          const shouldReconnect = !this.manualClose && !this.stopRequested && code !== 401 && code !== 429
          if (shouldReconnect) {
            const delay = Math.min(30000, 2000 * Math.pow(2, Math.min(this.connectAttempt, 4)))
            const expectedGeneration = this.socketGeneration
            logger.info('[conn] reconnecting in %sms (attempt %s)', delay, this.connectAttempt + 1)
            setTimeout(() => {
              if (!this.stopRequested && !this.manualClose && this.socketGeneration === expectedGeneration && !this.sock) {
                this.connect().catch((err) => logger.error('[conn] reconnect failed: %s', err.message))
              }
            }, delay)
          }
        }
      })

      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return
        for (const msg of messages) {
          // Process command messages sent from the linked account too. The
          // command handler ignores ordinary/non-command outgoing messages, so
          // this enables owner testing without creating reply loops.
          try {
            await handleMessage(sock, msg)
          } catch (err) {
            logger.error('[msg] handler error: %s', err.message)
          }
        }
      })

      logger.info('[conn] socket started (attempt %s)', this.connectAttempt)
    } catch (err) {
      logger.error('[conn] connect error: %s', err.message)
      this.lastDisconnect = { code: 'error', reason: err.message, at: new Date().toISOString() }
      if (!this.stopRequested) {
        setTimeout(() => this.connect(), 5000)
      }
    }
  }

  scheduleQrRefresh () {
    // Baileys re-emits a fresh `connection.update.qr` by itself whenever the
    // previous code expires/rotates (~20s), and the dashboard now polls
    // /api/session every 5s, so the QR shown is always the current one.
    // This timer is just a safety log if a QR somehow stalls.
    clearTimeout(this.refreshTimeout)
    this.refreshTimeout = setTimeout(() => {
      if (this.state === 'qr') {
        logger.debug('[conn] QR still waiting — Baileys rotates it automatically')
      }
    }, 60000)
  }

  /** Wait until the fresh socket has reached registration readiness. */
  async waitForPairingReady (timeoutMs = 12000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (this.state === 'connected') return
      if (this.sock && this.pairingReady) return
      if (!this.sock && this.lastDisconnect) {
        const code = this.lastDisconnect.code
        throw new Error(`WhatsApp socket closed before pairing was ready${code ? ` (HTTP ${code})` : ''}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw new Error('WhatsApp socket was not ready for pairing in time. Try Get code again once.')
  }

  /** Clear stale/rejected auth and create a genuinely fresh pairing socket. */
  async resetForPairing (reason = 'fresh pairing requested') {
    logger.info('[conn] resetting auth for fresh pairing (%s)', reason)
    this.manualClose = true
    this.socketGeneration++
    const old = this.sock
    this.sock = null
    if (old) {
      try { old.end(undefined) } catch { /* ignore */ }
    }
    clearTimeout(this.refreshTimeout)
    fs.rmSync(SESSION_DIR, { recursive: true, force: true })
    fs.mkdirSync(SESSION_DIR, { recursive: true })
    this.state = 'idle'
    this.qr = null
    this.qrAt = null
    this.pairingCode = null
    this.pairingReady = false
    this.phone = null
    this.lastDisconnect = null
    this.registerError = null
    this.loggedOut = false
    this.connectAttempt = 0
    this.stopRequested = false
    this.manualClose = false
    await this.connect()
  }

  /** Request a pairing code (replaces QR flow). Returns the code string. */
  async requestPairingCode (phone) {
    const number = String(phone).replace(/[^\d]/g, '').replace(/^0+/, '')
    if (number.length < 8) throw new Error('Enter a valid phone number with country code (E.164)')

    // If the previous socket ended with 401/loggedOut, do not reuse that auth
    // state. Start from a clean auth directory before asking WhatsApp for code.
    if (this.loggedOut || Number(this.lastDisconnect?.code) === 401) {
      await this.resetForPairing('previous session returned 401/loggedOut')
    } else if (!this.sock) {
      await this.start()
    }

    await this.waitForPairingReady()
    if (!this.sock) throw new Error('Socket not started')

    this.state = 'pairing'
    this.qr = null
    this.registerError = null
    try {
      const code = await this.sock.requestPairingCode(number)
      this.pairingCode = code
      this.phone = number
      bus.emitSafe('session.pairingCode', { code, at: new Date().toISOString() })
      bus.emitSafe('session.status', { state: 'pairing', at: new Date().toISOString() })
      logger.info('[conn] pairing code issued for %s', number)
      return code
    } catch (err) {
      const boom = err?.output?.statusCode ? err : (err?.error?.output ? err.error : null)
      const code = boom?.output?.statusCode
      const detail = boom?.output?.payload?.message || err?.message || String(err)
      const label = code ? `HTTP ${code}: ${detail}` : detail
      this.lastDisconnect = { code, reason: label.slice(0, 200), detail: label.slice(0, 400), at: new Date().toISOString() }
      this.registerError = { code: code ?? 'unknown', reason: detail.slice(0, 300), at: new Date().toISOString() }
      logger.error('[conn] requestPairingCode failed: %s', label)
      const wrapped = new Error(`Pairing failed (${label.slice(0, 200)})`)
      if (code) wrapped.output = { statusCode: code, payload: { message: detail } }
      throw wrapped
    }
  }

  /** Gracefully disconnect (keeps session saved). */
  async disconnect () {
    this.manualClose = true
    this.state = 'disconnected'
    this.qr = null
    this.pairingCode = null
    this.pairingReady = false
    this.socketGeneration++
    const sock = this.sock
    this.sock = null
    if (sock) {
      try { sock.end(undefined) } catch { /* ignore */ }
    }
    bus.emitSafe('session.status', { state: 'disconnected', reason: 'manual', at: new Date().toISOString() })
  }

  /** Reconnect (clears manualClose flag, keeps session). */
  async reconnect () {
    this.manualClose = false
    this.stopRequested = false
    this.socketGeneration++
    const old = this.sock
    this.sock = null
    if (old) {
      try { old.end(undefined) } catch { /* ignore */ }
    }
    this.connectAttempt = 0
    this.lastDisconnect = null
    this.loggedOut = false
    await this.connect()
  }

  /** Logout + wipe session. */
  async logout () {
    this.manualClose = true
    this.socketGeneration++
    if (this.sock) {
      try { await this.sock.logout() } catch { /* ignore */ }
      try { this.sock.end(undefined) } catch { /* ignore */ }
      this.sock = null
    }
    fs.rmSync(SESSION_DIR, { recursive: true, force: true })
    this.state = 'idle'
    this.phone = null
    this.qr = null
    this.pairingCode = null
    bus.emitSafe('session.status', { state: 'idle', at: new Date().toISOString() })
  }

  async stop () {
    this.stopRequested = true
    this.manualClose = true
    this.socketGeneration++
    clearTimeout(this.refreshTimeout)
    const sock = this.sock
    this.sock = null
    if (sock) {
      // Process shutdown/redeploy must close transport only. Calling logout()
      // here would unlink the saved WhatsApp session on every Render restart.
      try { sock.end(undefined) } catch { /* ignore */ }
    }
  }
}

module.exports = new Connection()