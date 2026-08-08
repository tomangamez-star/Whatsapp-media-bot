'use strict'

/**
 * Entry point — boots HTTP + Socket.IO server, WhatsApp connection,
 * keep-alive pinger and periodic media cleanup.
 */

const http = require('http')
const express = require('express')
const { Server } = require('socket.io')
const fs = require('fs')
const path = require('path')

const config = require('./config')
const logger = require('./logger')
const bus = require('./events')
const db = require('./db')
const connection = require('./bot/connection')
const { router, logRing } = require('./api')
const { getWebhookConfig } = require('./services/webhooks')

const app = express()
const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e6
})

app.use(express.json({ limit: '1mb' }))
app.use('/api', router)

// Dashboard static files at the root
const dashboardDir = path.join(__dirname, '..', 'dashboard')
app.use(express.static(dashboardDir, { index: 'index.html', maxAge: '1h' }))

/* ─────────── Socket.IO realtime bridge (no auth — dashboard is behind the login page) ─────────── */

io.on('connection', (socket) => {
  logger.info('[io] client connected')
  socket.emit('session', connection.status())
  socket.emit('logs', logRing.slice(-50))
  socket.on('ping', (cb) => { if (typeof cb === 'function') cb('pong') })
})

function broadcast (event, payload) {
  io.emit(event, payload)
}

// mirror bot events to all dashboard clients
bus.on('session.status', (p) => broadcast('session', connection.status()))
bus.on('session.qr', (p) => broadcast('session.qr', p))
bus.on('session.connected', (p) => { broadcast('session.connected', p); broadcast('log', { level: 'success', msg: `Bot connected as ${p.phone || 'unknown'}`, at: p.at }) })
bus.on('session.disconnected', (p) => broadcast('log', { level: 'warn', msg: `Disconnected (${p.reason})`, at: p.at }))
bus.on('session.pairingCode', (p) => broadcast('session.pairingCode', p))
bus.on('command', (p) => broadcast('log', { level: 'info', msg: `Command .${p.command} from ${p.sender.split('@')[0]}${p.args ? ': ' + p.args : ''}`, at: p.at }))
bus.on('download.progress', (p) => {
  const d = db.getDownload(p.downloadId)
  if (d) broadcast('download.progress', { id: p.downloadId, percent: p.percent, bytes: p.bytes, type: d.type })
})
bus.on('download.completed', (p) => {
  const d = db.getDownload(p.downloadId)
  broadcast('download.completed', { id: p.downloadId, title: d?.title })
  broadcast('log', { level: 'success', msg: `✅ Download completed: ${d?.title || p.downloadId}`, at: new Date().toISOString() })
})
bus.on('download.failed', (p) => broadcast('log', { level: 'error', msg: `❌ Download failed: ${p.error?.slice(0, 140)}`, at: new Date().toISOString() }))

/* ─────────── keep-alive self-ping (helps some hosts keep the process awake) ─────────── */

let keepaliveTimer = null
function startKeepalive () {
  if (config.keepalive.intervalSec <= 0) return
  keepaliveTimer = setInterval(async () => {
    try {
      await fetch(`http://127.0.0.1:${config.server.port}/api/health`, { signal: AbortSignal.timeout(5000) })
    } catch { /* keep-alive is best-effort */ }
  }, config.keepalive.intervalSec * 1000)
  keepaliveTimer.unref?.()
}

/* ─────────── periodic media cleanup ─────────── */

function startCleanup () {
  const minutes = config.download.cleanupAfterMinutes
  if (minutes <= 0) return
  const run = () => {
    const cutoff = Date.now() - minutes * 60000
    const mediaDir = config.download.mediaDir
    if (!fs.existsSync(mediaDir)) return
    for (const f of fs.readdirSync(mediaDir)) {
      const fp = path.join(mediaDir, f)
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp)
      } catch { /* ignore */ }
    }
    logger.info('[cleanup] removed media files older than %s minutes', minutes)
  }
  const timer = setInterval(run, minutes * 60000)
  timer.unref?.()
  setTimeout(run, 30000) // first pass shortly after boot
}

/* ─────────── graceful shutdown ─────────── */

async function shutdown (signal) {
  logger.info('[server] shutting down (%s)', signal)
  clearInterval(keepaliveTimer)
  await connection.stop()
  io.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}

/* ─────────── boot ─────────── */

server.listen(config.server.port, config.server.host, () => {
  logger.info('┌─────────────────────────────────────────────┐')
  logger.info('│  WhatsApp Media Bot — dashboard ready       │')
  logger.info('│  http://%s:%s  │', config.server.host === '0.0.0.0' ? 'localhost' : config.server.host, config.server.port)
  logger.info('│  login: %s / %s            │', config.auth.username, config.auth.password)
  logger.info('└─────────────────────────────────────────────┘')

  startKeepalive()
  startCleanup()

  // auto-connect WhatsApp (reuses saved session, or shows QR in dashboard)
  connection.start()
    .then(() => {
      const wh = getWebhookConfig()
      if (wh.enabled) logger.info('[webhook] enabled → %s', wh.url)
    })
    .catch((err) => logger.error('[conn] failed to start: %s', err.message))
})

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', (err) => logger.error('[unhandledRejection] %s', err?.message))