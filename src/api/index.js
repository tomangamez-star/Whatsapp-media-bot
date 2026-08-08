'use strict'

/**
 * API server — dashboard backend.
 *
 *   POST /api/auth/login          → { token }
 *   GET  /api/session             → connection status
 *   POST /api/session/pair        → request pairing code { phone }
 *   POST /api/session/reconnect   → reconnect socket
 *   POST /api/session/disconnect  → disconnect (keeps session)
 *   POST /api/session/logout      → logout + wipe session
 *   GET  /api/history             → download history (?type=&status=&limit=)
 *   GET  /api/logs                → recent bot log lines (?limit=)
 *   GET/POST /api/webhook         → webhook config
 *   GET  /api/health              → health probe (no auth)
 */

const express = require('express')
const path = require('path')
const crypto = require('crypto')
const config = require('../config')
const db = require('../db')
const bus = require('../events')
const logger = require('../logger')
const connection = require('../bot/connection')
const { normalizePhone, validPhone } = require('../utils/phone')
const { getWebhookConfig, saveConfig } = require('../services/webhooks')

const router = express.Router()
const TOKEN_HEADER = 'x-access-token'

/* token table (in-memory, regenerated per boot; also check ADMIN_TOKEN) */
const tokens = new Set()

// ⛔ Anti-429 pairing guard: WhatsApp rate-limits pairing requests hard (HTTP
// 429 "rate-overlimit", persists ~15–40 min after repeated attempts — Baileys
// #2008, #1761). Repeatedly clicking "Get code" from a datacenter IP is the
// #1 way to get the number/device temporarily blocked, which is exactly the
// "code generates but WhatsApp won't link" symptom. Enforce a cooldown window
// between pairing attempts and surface a clear "wait" message instead of
// silently letting the user hammer the endpoint.
const PAIR_COOLDOWN_MS = parseInt(process.env.PAIR_COOLDOWN_MS || '60000', 10)
const PAIR_MAX_ATTEMPTS = parseInt(process.env.PAIR_MAX_ATTEMPTS || '3', 10)
const PAIR_WINDOW_MS = parseInt(process.env.PAIR_WINDOW_MS || '3600000', 10) // 1h
const pairAttempts = [] // timestamps of recent pairing attempts (in-memory)

function checkPairRateLimit () {
  const now = Date.now()
  while (pairAttempts.length && now - pairAttempts[0] > PAIR_WINDOW_MS) pairAttempts.shift()
  if (pairAttempts.length) {
    const waitMs = PAIR_COOLDOWN_MS - (now - pairAttempts[pairAttempts.length - 1])
    if (waitMs > 0) {
      return { blocked: true, waitSec: Math.ceil(waitMs / 1000) }
    }
  }
  if (pairAttempts.length >= PAIR_MAX_ATTEMPTS) {
    const oldest = pairAttempts[0]
    const waitMs = PAIR_WINDOW_MS - (now - oldest)
    if (waitMs > 0) {
      return { blocked: true, waitSec: Math.ceil(waitMs / 1000), window: true }
    }
  }
  pairAttempts.push(now)
  return { blocked: false }
}

function createToken () {
  const t = crypto.randomBytes(24).toString('hex')
  tokens.add(t)
  return t
}

function authOk (req) {
  const provided = req.headers[TOKEN_HEADER] || (req.body && req.body.token)
  if (config.auth.token && provided === config.auth.token) return true
  return tokens.has(provided)
}

function requireAuth (req, res, next) {
  if (authOk(req)) return next()
  res.status(401).json({ error: 'Unauthorized' })
}

/* keep a rolling in-memory log ring for /api/logs + live feed */
const logRing = []
function pushLog (entry) {
  logRing.push(entry)
  if (logRing.length > 500) logRing.shift()
}
bus.on('command', (p) => pushLog({ level: 'info', msg: `Command .${p.command} from ${p.sender.split('@')[0]}: ${p.args || '(no args)'}`, at: p.at }))
bus.on('download.completed', (p) => {
  const d = db.getDownload(p.downloadId)
  pushLog({ level: 'info', msg: `Download completed: ${d?.title || p.downloadId}`, at: new Date().toISOString() })
})
bus.on('download.failed', (p) => pushLog({ level: 'error', msg: `Download failed: ${p.error?.slice(0, 120)}`, at: new Date().toISOString() }))

/* ─────────────────────────── routes ─────────────────────────── */

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
    node: process.version,
    db: db.mode,
    session: connection.status()
  })
})

router.post('/auth/login', express.json(), (req, res) => {
  const { username, password } = req.body || {}
  if (username === config.auth.username && password === config.auth.password) {
    return res.json({ token: createToken(), expiresIn: config.auth.sessionTtlDays * 86400 })
  }
  res.status(401).json({ error: 'Invalid credentials' })
})

router.get('/session', requireAuth, (req, res) => {
  const st = connection.status()
  st.pairRateLimit = checkPairRateLimit()
  res.json(st)
})

router.post('/session/pair', requireAuth, express.json(), async (req, res) => {
  try {
    // Anti-429 guard: enforce a cooldown between pairing attempts so the number
    // doesn't get rate-limited/blocked by WhatsApp (the #1 cause of "code
    // generates but won't link" from a datacenter IP).
    const limit = checkPairRateLimit()
    if (limit.blocked) {
      const msg = limit.window
        ? `Pairing is temporarily rate-limited by WhatsApp. You've reached ${PAIR_MAX_ATTEMPTS} attempts in the last hour — wait ${Math.ceil(limit.waitSec / 60)} min before trying again. Repeated attempts extend the block (15–40 min).`
        : `Please wait ${limit.waitSec}s between pairing attempts — WhatsApp rate-limits pairing requests and repeated clicks trigger a temporary block (HTTP 429, 15–40 min).`
      return res.status(429).json({ error: msg, retryAfterSec: limit.waitSec })
    }
    const { phone } = req.body || {}
    // Accept "+2347074455500", "2347074455500", "002347074455500" or national
    // format "07074455500" (resolved via DEFAULT_COUNTRY_CODE). Always sent to
    // Baileys as bare E.164 without "+" and without leading zeros.
    const normalized = normalizePhone(phone, config.session.defaultCountryCode)
    if (!validPhone(normalized)) {
      return res.status(400).json({
        error: `Invalid phone number (got "${String(phone || '').trim()}"). Use E.164 with country code, e.g. 2347074455500 for Nigeria, or set DEFAULT_COUNTRY_CODE to enable national format (07074455500).`
      })
    }
    await connection.start()
    const code = await connection.requestPairingCode(normalized)
    res.json({ pairingCode: code, phone: normalized, hint: 'Enter this code in WhatsApp → Linked Devices → Link with phone number instead. The code refreshes live in the dashboard (5s poll).' })
  } catch (err) {
    const boom = err?.output?.statusCode ? err : (err?.error?.output ? err.error : null)
    const status = boom?.output?.statusCode
    const detail = boom?.output?.payload?.message || err?.message || String(err)
    // Surface WhatsApp's verdict directly — 429 rate-overlimit, 401 rejected,
    // 428 too-early — with a human-readable wait hint instead of a generic 500.
    if (status === 429 || /rate[- ]?overlimit|rate[- ]?limit/i.test(String(detail))) {
      return res.status(429).json({ error: `WhatsApp is rate-limiting pairing for this number/IP (HTTP 429). Wait 15–40 minutes before retrying — repeated attempts extend the block. Detail: ${detail.slice(0, 200)}`, retryAfterSec: 900 })
    }
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: err.message })
  }
})

router.post('/session/reconnect', requireAuth, async (req, res) => {
  try {
    await connection.reconnect()
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/session/disconnect', requireAuth, async (req, res) => {
  try {
    await connection.disconnect()
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/session/logout', requireAuth, async (req, res) => {
  try {
    await connection.logout()
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get('/history', requireAuth, (req, res) => {
  const { type, status, limit = 50, offset = 0 } = req.query
  const rows = db.listDownloads({
    type: type || undefined,
    status: status || undefined,
    limit: Math.min(200, parseInt(limit, 10) || 50),
    offset: parseInt(offset, 10) || 0
  })
  res.json({ total: db.countDownloads({ type, status }), items: rows })
})

router.get('/logs', requireAuth, (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 100)
  res.json({ items: logRing.slice(-limit) })
})

router.get('/webhook', requireAuth, (req, res) => {
  const cfg = getWebhookConfig()
  res.json({ ...cfg, secret: cfg.secret ? '********' : '' })
})

router.post('/webhook', requireAuth, express.json(), (req, res) => {
  const cfg = saveConfig({
    url: req.body.url || '',
    secret: req.body.secret || '',
    enabled: !!req.body.enabled,
    events: Array.isArray(req.body.events) && req.body.events.length ? req.body.events : ['command', 'download.started', 'download.completed', 'download.failed']
  })
  res.json({ ok: true, config: { ...cfg, secret: cfg.secret ? '********' : '' } })
})

router.get('/stats', requireAuth, (req, res) => {
  res.json({
    downloads: db.countDownloads(),
    videos: db.countDownloads({ type: 'video' }),
    songs: db.countDownloads({ type: 'audio' }),
    completed: db.countDownloads({ status: 'completed' }),
    failed: db.countDownloads({ status: 'failed' }),
    pending: db.countDownloads({ status: 'queued' }) + db.countDownloads({ status: 'downloading' }) + db.countDownloads({ status: 'searching' })
  })
})

/* serve dashboard static files — mounted at root in server.js */

module.exports = { router, createToken, logRing }