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
 */

const fs = require('fs')
const path = require('path')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const qrcode = require('qrcode')
const config = require('../config')
const bus = require('../events')
const logger = require('../logger')
const { handleMessage } = require('./commands')

const SESSION_DIR = config.session.dir

class Connection {
  constructor () {
    this.sock = null
    this.state = 'idle' // idle | connecting | qr | pairing | connected | disconnected | closed
    this.qr = null // base64 data URL
    this.pairingCode = null
    this.lastDisconnect = null
    this.startedAt = null
    this.connectAttempt = 0
    this.manualClose = false
    this.loggedOut = false
    this.version = null
    this.phone = null
    this.refreshTimeout = null
    this.stopRequested = false
  }

  /** Public info for dashboard/API. */
  status () {
    return {
      state: this.state,
      connected: this.state === 'connected',
      qr: this.qr,
      pairingCode: this.pairingCode,
      phone: this.phone,
      lastDisconnect: this.lastDisconnect,
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

    await this.connect()
  }

  async connect () {
    if (this.stopRequested) return
    this.connectAttempt++
    this.state = this.connectAttempt === 1 ? 'connecting' : 'reconnecting'
    this.qr = null
    this.pairingCode = null
    bus.emitSafe('session.status', { state: this.state, at: new Date().toISOString() })

    try {
      const { version, isLatest } = await fetchLatestBaileysVersion()
      this.version = version
      logger.info('[conn] using Baileys version %s (latest: %s)', version.join('.'), isLatest)

      const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR)

      const sock = makeWASocket({
        version,
        auth: authState,
        browser: ['Chrome (Linux)', 'Chrome', '119.0.0.0'],
        printQRInTerminal: false,
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        logger: logger.child({ module: 'baileys' })
      })
      this.sock = sock

      sock.ev.on('creds.update', saveCreds)

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) {
          this.state = 'qr'
          this.qr = await qrcode.toDataURL(qr, { width: 360, margin: 1 })
          this.pairingCode = null
          bus.emitSafe('session.qr', { qr: this.qr, at: new Date().toISOString() })
          bus.emitSafe('session.status', { state: 'qr', at: new Date().toISOString() })
          this.scheduleQrRefresh()
        }
        if (connection === 'open') {
          this.state = 'connected'
          this.connectedAt = Date.now()
          this.phone = sock.user?.id?.split(':')[0] || null
          this.qr = null
          this.pairingCode = null
          this.connectAttempt = 0
          bus.emitSafe('session.connected', { phone: this.phone, at: new Date().toISOString() })
          bus.emitSafe('session.status', { state: 'connected', phone: this.phone, at: new Date().toISOString() })
          logger.info('[conn] connected as %s', this.phone || 'unknown')
        }
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode
          const reason = DisconnectReason[code] || code || 'unknown'
          this.lastDisconnect = { code, reason, at: new Date().toISOString() }
          this.state = 'disconnected'
          this.qr = null
          this.pairingCode = null
          this.sock = null
          bus.emitSafe('session.disconnected', { code, reason, at: new Date().toISOString() })
          bus.emitSafe('session.status', { state: 'disconnected', reason, at: new Date().toISOString() })
          logger.warn('[conn] disconnected (code=%s reason=%s)', code, reason)

          const shouldReconnect = !this.manualClose && !this.stopRequested && code !== DisconnectReason.loggedOut
          if (shouldReconnect) {
            const delay = Math.min(60000, 2000 * Math.pow(2, Math.min(this.connectAttempt, 5)))
            logger.info('[conn] reconnecting in %sms (attempt %s)', delay, this.connectAttempt + 1)
            setTimeout(() => this.connect(), delay)
          } else if (code === DisconnectReason.loggedOut) {
            this.loggedOut = true
            fs.rmSync(SESSION_DIR, { recursive: true, force: true })
            logger.warn('[conn] logged out — session cleared')
          }
        }
      })

      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return
        for (const msg of messages) {
          if (msg.key.fromMe) continue
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
    clearTimeout(this.refreshTimeout)
    this.refreshTimeout = setTimeout(() => {
      if (this.state === 'qr' && this.sock) {
        // QR codes expire; ask Baileys to refresh by re-requesting
        logger.debug('[conn] refreshing QR')
      }
    }, 60000)
  }

  /** Request a pairing code (replaces QR flow). Returns the code string. */
  async requestPairingCode (phone) {
    if (!this.sock) throw new Error('Socket not started')
    const number = String(phone).replace(/\D/g, '')
    if (number.length < 8) throw new Error('Enter a valid phone number with country code (E.164)')
    this.state = 'pairing'
    this.qr = null
    const code = await this.sock.requestPairingCode(number)
    this.pairingCode = code
    bus.emitSafe('session.pairingCode', { code, at: new Date().toISOString() })
    bus.emitSafe('session.status', { state: 'pairing', at: new Date().toISOString() })
    return code
  }

  /** Gracefully disconnect (keeps session saved). */
  async disconnect () {
    this.manualClose = true
    this.state = 'disconnected'
    this.qr = null
    this.pairingCode = null
    if (this.sock) {
      try { await this.sock.logout() } catch { /* ignore */ }
      try { this.sock.end(undefined) } catch { /* ignore */ }
      this.sock = null
    }
    bus.emitSafe('session.status', { state: 'disconnected', reason: 'manual', at: new Date().toISOString() })
  }

  /** Reconnect (clears manualClose flag, keeps session). */
  async reconnect () {
    this.manualClose = false
    this.stopRequested = false
    if (this.sock) {
      try { this.sock.end(undefined) } catch { /* ignore */ }
      this.sock = null
    }
    this.connectAttempt = 0
    await this.connect()
  }

  /** Logout + wipe session. */
  async logout () {
    this.manualClose = true
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
    clearTimeout(this.refreshTimeout)
    if (this.sock) {
      try { await this.sock.logout() } catch { /* ignore */ }
      try { this.sock.end(undefined) } catch { /* ignore */ }
    }
  }
}

module.exports = new Connection()
