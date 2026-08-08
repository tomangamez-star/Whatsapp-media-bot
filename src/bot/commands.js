'use strict'

/**
 * Command handler — parses incoming WhatsApp messages and dispatches to the
 * download pipeline. Also handles the quality-selection follow-up flow.
 */

const fs = require('fs')
const config = require('../config')
const db = require('../db')
const bus = require('../events')
const logger = require('../logger')
const { runYtDlp, searchAndDownload } = require('../services/downloader')
const { sendMedia } = require('../services/sender')
const { formatBytes, formatDuration } = require('../utils/format')
const { Queue } = require('../utils/queue')

const queue = new Queue(config.download.maxConcurrent)

const QUALITY_KEYS = Object.keys(config.qualityMap) // ['240','360',...]
const QUALITY_LABELS = Object.values(config.qualityMap).map((q) => q.label)
const QUALITY_RE = new RegExp(`^(\\d{2,4}p|hd|4k|8k|auto)$`, 'i')

// map quality tokens to canonical keys
const QUALITY_ALIAS = {
  '240p': '240', '360p': '360', '480p': '480', '720p': '720', '720': '720',
  hd: '1080', '1080p': '1080', '1080': '1080',
  '4k': '2160', '2160p': '2160', '2160': '2160',
  '8k': '4320', '4320p': '4320', '4320': '4320',
  auto: 'auto'
}

const HELP_TEXT = `*WhatsApp Media Bot* 📱

*Commands*
.movie <title> — search & download a movie/video
.video <query> — search any video (YouTube/IG/TikTok…)
.yt <link> — download from a direct link (YouTube, Instagram, TikTok, etc.)
.song <query> | .mp3 <query> — search & download audio
.mp3 <link> — extract audio from a direct link

*Quality*
.quality 240p|360p|480p|720p|HD|4K|8K|auto — set your default
After a download completes, reply with a quality to re-download.

*Other*
.ping — bot health
.help — this message`

/** Per-user pending quality selection: map jid → download record waiting for quality reply. */
const pendingQuality = new Map()

function isUrl (s) {
  return /^https?:\/\/.+/i.test(s)
}

function normalizeCommand (text) {
  return String(text || '').trim().toLowerCase()
}

/**
 * Main entry — called for every incoming message.
 */
async function handleMessage (sock, msg) {
  const text = (msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    '').trim()

  if (!text) return

  const jid = msg.key.remoteJid
  const sender = msg.key.participant || jid || ''
  const isGroup = jid?.endsWith('@g.us')
  const senderJid = isGroup ? sender : jid

  // quality-selection follow-up: a bare quality reply after a finished download
  if (QUALITY_RE.test(text) && pendingQuality.has(senderJid)) {
    const pending = pendingQuality.get(senderJid)
    pendingQuality.delete(senderJid)
    const quality = QUALITY_ALIAS[text.toLowerCase()]
    if (quality) {
      return downloadEntry(sock, pending, quality)
    }
  }

  if (!text.startsWith('.')) return

  const [rawCmd, ...rest] = text.split(/\s+/)
  const cmd = rawCmd.slice(1).toLowerCase()
  const arg = rest.join(' ').trim()

  // owner/allowed-chats gate
  const isAllowed = isAllowedSender(senderJid)
  if (!isAllowed) {
    logger.info('[cmd] blocked sender %s', senderJid)
    return
  }

  db.upsertUser({ jid: senderJid, phone: senderJid.split('@')[0], role: isOwner(senderJid) ? 'owner' : 'user' })

  bus.emitSafe('command', {
    jid: senderJid,
    sender: senderJid,
    command: cmd,
    args: arg,
    text,
    at: new Date().toISOString()
  })

  try {
    switch (cmd) {
      case 'ping':
        return reply(sock, jid, `Pong! 🏓 Bot is online. Uptime: ${formatDuration(process.uptime())}`)

      case 'help':
        return reply(sock, jid, HELP_TEXT)

      case 'movie':
      case 'video':
      case 'yt':
      case 'song':
      case 'mp3':
        return handleDownloadCommand(sock, jid, senderJid, cmd, arg)

      case 'quality':
        return handleQualityCommand(sock, jid, senderJid, arg)

      default:
        return reply(sock, jid, `Unknown command "${rawCmd}". Send .help for the command list.`)
    }
  } catch (err) {
    logger.error('[cmd] handler error: %s', err.message)
    await reply(sock, jid, `⚠️ Error: ${err.message.slice(0, 300)}`)
  }
}

function isOwner (jid) {
  return config.bot.allowedChats.length === 0 || config.bot.allowedChats.includes(jid.split('@')[0])
}

function isAllowedSender (jid) {
  if (config.bot.allowedChats.length === 0) return true // no restriction
  return config.bot.allowedChats.includes(jid.split('@')[0])
}

async function reply (sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text })
  } catch (err) {
    logger.warn('[reply] failed: %s', err.message)
  }
}

/* ─────────────────────────── commands ─────────────────────────── */

async function handleQualityCommand (sock, jid, senderJid, arg) {
  const q = normalizeCommand(arg).replace(/p$/, '')
  if (!QUALITY_KEYS.includes(q) && arg.toLowerCase() !== 'auto') {
    return reply(sock, jid, `Usage: .quality <${QUALITY_KEYS.join('|')}|auto>\nAvailable: 240p, 360p, 480p, 720p, HD, 4K, 8K, auto`)
  }
  db.setSetting(`quality:${senderJid}`, q === 'auto' ? 'auto' : q)
  return reply(sock, jid, `✅ Default quality set to *${QUALITY_LABELS[QUALITY_KEYS.indexOf(q)] || 'auto'}*`)
}

async function handleDownloadCommand (sock, jid, senderJid, cmd, arg) {
  if (!arg) {
    const usage = {
      movie: '.movie <title> — e.g. .movie spiderman',
      video: '.video <query> — e.g. .video cats funny',
      yt: '.yt <link> — e.g. .yt https://youtube.com/watch?v=...',
      song: '.song <query> — e.g. .song imagine dragons',
      mp3: '.mp3 <query or link>'
    }[cmd]
    return reply(sock, jid, `Usage: ${usage}`)
  }

  const type = (cmd === 'song' || cmd === 'mp3') ? 'audio' : 'video'
  const quality = db.getSetting(`quality:${senderJid}`) || config.download.defaultQuality

  // direct URL
  if (isUrl(arg) && (cmd === 'yt' || cmd === 'mp3')) {
    const rec = db.createDownload({
      type, url: arg, query: null, quality, chat: jid, sender: senderJid
    })
    await reply(sock, jid, type === 'audio'
      ? `🎵 Extracting audio from link…`
      : `📥 Downloading from link (quality: *${quality}*)…`)
    return enqueueDownload(sock, jid, rec, { source: arg, title: arg })
  }

  // search-based
  const rec = db.createDownload({
    type, query: arg, url: null, quality, chat: jid, sender: senderJid
  })
  await reply(sock, jid, type === 'audio'
    ? `🔎 Searching "${arg}" for audio…`
    : `🔎 Searching "${arg}"…\nI'll send the best result at *${quality}*.`)
  return enqueueDownload(sock, jid, rec, { query: arg })
}

/** Queue the actual yt-dlp work; returns immediately. */
function enqueueDownload (sock, jid, rec, opts) {
  queue
    .add(() => doDownload(sock, jid, rec, opts))
    .catch((err) => {
      logger.error('[dl] unhandled: %s', err.message)
    })
}

/** Core pipeline: search → download → progress → send → history. */
async function doDownload (sock, jid, rec, opts) {
  const { query, source } = opts
  db.updateDownload(rec.id, { status: 'searching', progress: 0 })

  try {
    let url = source
    let title = source || query
    if (!url) {
      await reply(sock, jid, `🔍 Searching…`)
      url = await searchAndDownload(query, rec.type, rec.quality, rec.id)
      title = query
    }

    db.updateDownload(rec.id, { status: 'downloading', url, title })

    // per-user progress message (throttled)
    let progressMsg = null
    let lastProgressSent = 0
    const progressHook = (p) => {
      const now = Date.now()
      if (now - lastProgressSent < 4000) return
      lastProgressSent = now
      progressMsg && void reply(sock, jid, `⏳ Downloading… ${Math.round(p.percent)}%`)
        .then((r) => { progressMsg = r })
        .catch(() => {})
    }
    const onProgress = (ev) => {
      if (ev.downloadId !== rec.id) return
      db.updateDownload(rec.id, { progress: ev.percent, size_bytes: ev.bytes })
      progressHook(ev)
    }
    bus.on('download.progress', onProgress)
    try {
      const result = await runYtDlp({
        source: url, type: rec.type, quality: rec.quality, downloadId: rec.id
      })
      db.updateDownload(rec.id, {
        status: 'sending', progress: 100, size_bytes: result.sizeBytes, title: result.title, file: result.file
      })
      await reply(sock, jid, `✅ *${result.title}*\n${formatBytes(result.sizeBytes)} — sending…`)
      await sendMedia(sock, jid, result.file, {
        type: rec.type, title: result.title
      })
      db.updateDownload(rec.id, { status: 'completed' })
      bus.emitSafe('download.completed', { downloadId: rec.id })

      // cleanup file after send
      fs.unlink(result.file, () => {})
    } finally {
      bus.removeListener('download.progress', onProgress)
    }
  } catch (err) {
    db.updateDownload(rec.id, { status: 'failed', error: err.message.slice(0, 500) })
    bus.emitSafe('download.failed', { downloadId: rec.id, error: err.message })
    await reply(sock, jid, `❌ Failed: ${err.message.slice(0, 300)}`)
  }
}

/** Re-download an entry with an explicit quality (quality follow-up flow). */
async function downloadEntry (sock, entry, quality) {
  const rec = db.getDownload(entry.id)
  if (!rec) return
  db.updateDownload(rec.id, { quality, status: 'queued' })
  await reply(sock, entry.chat, `📥 Re-downloading at *${quality}*…`)
  return enqueueDownload(sock, entry.chat, rec, {
    source: rec.url, query: rec.query
  })
}

module.exports = { handleMessage, HELP_TEXT }
