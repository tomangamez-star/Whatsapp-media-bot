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

// Pairing requests are not locally rate-limited. If WhatsApp/Baileys returns
// HTTP 429, that real upstream response is surfaced by POST /session/pair.

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
  res.json(connection.status())
})

router.post('/session/pair', requireAuth, express.json(), async (req, res) => {
  try {
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
    // Surface WhatsApp/Baileys' real verdict directly. Do not infer a cooldown
    // or convert unrelated 401 errors into a made-up rate-limit message.
    if (status === 429 || /rate[- ]?overlimit|rate[- ]?limit/i.test(String(detail))) {
      return res.status(429).json({ error: `WhatsApp returned HTTP 429 while requesting the pairing code. This is the real upstream response, not a local cooldown. Detail: ${detail.slice(0, 200)}` })
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