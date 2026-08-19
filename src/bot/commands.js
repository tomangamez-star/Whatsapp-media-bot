'use strict'

/**
 * Pantheon command router.
 * Default prefix: /
 * Snapshot cards are immutable: metrics are sampled once per command.
 */

const fs = require('fs')
const os = require('os')
const { performance } = require('perf_hooks')
const config = require('../config')
const db = require('../db')
const bus = require('../events')
const logger = require('../logger')
const { runYtDlp, searchAndDownload } = require('../services/downloader')
const { sendMedia } = require('../services/sender')
const { formatBytes, formatUptime } = require('../utils/format')
const { Queue } = require('../utils/queue')
const {
  handleGroupCommand,
  moderateIncoming,
  maybeReplyAI
} = require('./group-features')

const queue = new Queue(config.download.maxConcurrent)
const BOT = config.bot.name
const PREFIX_KEY = 'bot:prefix'
const METRIC_PREFIX = 'metric:'
const SAFE_PREFIXES = ['/', '.', ',', ':', '\\', '|', '~', ';', '*', '!', '?', '+', '-', '=', '#', '$', '%', '&', '_']

const COMMANDS = [
  { name: 'start', category: 'Core', usage: 'start', desc: 'Tech-style system snapshot & bot information' },
  { name: 'menu', category: 'Core', usage: 'menu', desc: 'Browse all commands' },
  { name: 'help', category: 'Core', usage: 'help [command]', desc: 'Usage help' },
  { name: 'ping', category: 'System', usage: 'ping', desc: 'Fresh latency/runtime snapshot' },
  { name: 'prefix', category: 'Owner', usage: 'prefix <symbol>', desc: 'Change the command prefix' },

  { name: 'kick', category: 'Group', usage: 'kick @user', desc: 'Remove a group member (admin required)' },
  { name: 'setwelcome', category: 'Group', usage: 'setwelcome <on|off>', desc: 'Random welcome cards with profile picture' },
  { name: 'goodbye', category: 'Group', usage: 'goodbye <on|off>', desc: 'Toggle member-leave messages' },
  { name: 'antispam', category: 'Group', usage: 'antispam <on|off>', desc: 'Delete flooding, warn 3 times, then remove' },
  { name: 'antilink', category: 'Group', usage: 'antilink <on|off|delete|warn>', desc: 'Configure group link moderation' },
  { name: 'ai', category: 'Group', usage: 'ai <on|off>', desc: 'Toggle restrained mention/reply AI responses' },

  { name: 'movie', category: 'Media', usage: 'movie <title>', desc: 'Search & download a movie/video result' },
  { name: 'video', category: 'Media', usage: 'video <query>', desc: 'Search & download a video' },
  { name: 'yt', category: 'Media', usage: 'yt <link>', desc: 'Download from a direct media link' },
  { name: 'song', category: 'Media', usage: 'song <query>', desc: 'Search & download audio' },
  { name: 'mp3', category: 'Media', usage: 'mp3 <query/link>', desc: 'Search or extract MP3 audio' },
  { name: 'quality', category: 'Media', usage: 'quality <240p|360p|480p|720p|HD|4K|8K|auto>', desc: 'Set your default video quality' }
]
const ALIASES = { alive: 'ping', commands: 'menu', welcome: 'setwelcome' }
const CATEGORIES = [...new Set(COMMANDS.map((c) => c.category))]

const QUALITY_KEYS = Object.keys(config.qualityMap)
const QUALITY_RE = /^(\d{2,4}p|hd|4k|8k|auto)$/i
const QUALITY_ALIAS = {
  '240p': '240', '240': '240', '360p': '360', '360': '360', '480p': '480', '480': '480',
  '720p': '720', '720': '720', hd: '1080', '1080p': '1080', '1080': '1080',
  '4k': '2160', '2160p': '2160', '2160': '2160', '8k': '4320', '4320p': '4320', '4320': '4320', auto: 'auto'
}

const pendingQuality = new Map()

function getPrefix () {
  const saved = db.getSetting(PREFIX_KEY)
  return SAFE_PREFIXES.includes(saved) ? saved : config.bot.defaultPrefix
}

function metricGet (name) {
  const n = Number(db.getSetting(METRIC_PREFIX + name) || 0)
  return Number.isFinite(n) ? n : 0
}

function metricAdd (name, amount = 1) {
  const next = metricGet(name) + Number(amount || 0)
  db.setSetting(METRIC_PREFIX + name, String(next))
  return next
}

function unwrapMessage (message) {
  let m = message || {}
  for (let i = 0; i < 6; i++) {
    if (m.ephemeralMessage?.message) { m = m.ephemeralMessage.message; continue }
    if (m.viewOnceMessage?.message) { m = m.viewOnceMessage.message; continue }
    if (m.viewOnceMessageV2?.message) { m = m.viewOnceMessageV2.message; continue }
    if (m.viewOnceMessageV2Extension?.message) { m = m.viewOnceMessageV2Extension.message; continue }
    if (m.documentWithCaptionMessage?.message) { m = m.documentWithCaptionMessage.message; continue }
    break
  }
  return m
}

function extractText (msg) {
  const m = unwrapMessage(msg?.message)
  return String(
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.title ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    ''
  ).trim()
}

function isUrl (s) { return /^https?:\/\/.+/i.test(s) }
function digits (jid) { return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '') }

function isOwner (senderJid, msg) {
  if (msg?.key?.fromMe) return true
  const n = digits(senderJid)
  if (config.bot.ownerNumber) return n === config.bot.ownerNumber
  return config.bot.allowedChats.length > 0 && n === config.bot.allowedChats[0]
}

function isAllowedSender (senderJid, msg, isGroup) {
  if (msg?.key?.fromMe) return true
  // ALLOWED_CHATS is a private-chat gate. Once Pantheon is intentionally added
  // to a group, group users must be able to use its group/media commands.
  if (isGroup) return true
  if (config.bot.allowedChats.length === 0) return true
  return config.bot.allowedChats.includes(digits(senderJid))
}

function parseCommand (text, prefix) {
  if (!text.startsWith(prefix)) return null
  const body = text.slice(prefix.length).trim()
  if (!body) return null

  // Compact owner syntax: /prefix. as well as /prefix .
  if (body.toLowerCase().startsWith('prefix') && body.length === 'prefix'.length + 1) {
    return { cmd: 'prefix', arg: body.slice('prefix'.length), rawCmd: `${prefix}${body}` }
  }

  const [head, ...rest] = body.split(/\s+/)
  const raw = head || ''
  const name = raw.toLowerCase()
  return { cmd: ALIASES[name] || name, arg: rest.join(' ').trim(), rawCmd: `${prefix}${raw}` }
}

async function reply (sock, jid, text, extra = {}) {
  try {
    return await sock.sendMessage(jid, { text, ...extra })
  } catch (err) {
    logger.warn('[reply] failed: %s', err.message)
    metricAdd('errors')
    return null
  }
}

function platformName () {
  if (process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_INSTANCE_ID) return 'Render'
  if (process.env.RAILWAY_ENVIRONMENT) return 'Railway'
  return process.platform
}

function formatTimeOnly () {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: config.bot.timezone,
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    }).format(new Date())
  } catch {
    return new Date().toLocaleTimeString('en-US', { hour12: true })
  }
}

async function sampleRuntime () {
  const startCpu = process.cpuUsage()
  const start = process.hrtime.bigint()
  const t0 = performance.now()
  await new Promise((resolve) => setTimeout(resolve, 80))
  const eventLoopLagMs = Math.max(0, Math.round(performance.now() - t0 - 80))
  const elapsedUs = Number(process.hrtime.bigint() - start) / 1000
  const cpu = process.cpuUsage(startCpu)
  const cpuPct = elapsedUs > 0 ? Math.min(999, ((cpu.user + cpu.system) / elapsedUs) * 100) : 0
  const mem = process.memoryUsage()
  return { pingMs: Math.max(1, eventLoopLagMs), cpuPct, mem }
}

async function startCard (sock) {
  const prefix = getPrefix()
  const runtime = await sampleRuntime()
  const totalTransferred = metricGet('download_bytes') + metricGet('upload_bytes')
  const completed = db.countDownloads({ status: 'completed' })
  const failed = db.countDownloads({ status: 'failed' })
  const memoryLimit = Number(process.env.RENDER_MEMORY_LIMIT_MB || process.env.MEMORY_LIMIT_MB || 0)
  const memoryLine = memoryLimit > 0
    ? `${formatBytes(runtime.mem.rss)} / ${memoryLimit} MB`
    : `${formatBytes(runtime.mem.rss)} RSS`
  const pg = db.persistence
  const authLine = pg?.ready ? '🟢 Supabase/Postgres' : (pg?.configured ? '🟠 Connecting' : '🟡 Local/Ephemeral')

  return `╭━━〔 ⚡ *${BOT}* 〕━━╮
│      SYSTEM SNAPSHOT
╰━━━━━━━━━━━━━━━━━━━━╯

╭─〔 🤖 *BOT IDENTITY* 〕
│ Name       » ${BOT}
│ Health     » 🟢 Healthy
│ Owner      » ${config.bot.ownerName}
│ Platform   » ${platformName()}
│ Prefix     » [${prefix}]
│ Version    » v${config.bot.version}
╰────────────────────

╭─〔 🧠 *RUNTIME CORE* 〕
│ WhatsApp   » ${sock?.user ? '🟢 Connected' : '🔴 Offline'}
│ Ping       » ${runtime.pingMs}ms
│ CPU        » ${runtime.cpuPct.toFixed(1)}%
│ Memory     » ${memoryLine}
│ Heap       » ${formatBytes(runtime.mem.heapUsed)} / ${formatBytes(runtime.mem.heapTotal)}
│ Runtime    » ${formatUptime(process.uptime())}
│ Node       » ${process.version}
│ OS         » ${os.platform()} ${os.arch()}
│ CPU Cores  » ${os.cpus()?.length || 1}
│ PID        » ${process.pid}
│ Time       » ${formatTimeOnly()}
╰────────────────────

╭─〔 🗄️ *STATE CORE* 〕
│ Session DB » ${authLine}
│ Data Mode  » ${db.mode.toUpperCase()}
│ Queue      » ${queue.size || 0}
╰────────────────────

╭─〔 📡 *TRANSFER MATRIX* 〕
│ Downloaded » ${formatBytes(metricGet('download_bytes'))}
│ Uploaded   » ${formatBytes(metricGet('upload_bytes'))}
│ Bot Traffic» ${formatBytes(totalTransferred)}
│ Completed  » ${completed}
│ Failed     » ${failed}
╰────────────────────

╭─〔 📊 *COMMAND CORE* 〕
│ Commands   » ${COMMANDS.length}
│ Aliases    » ${Object.keys(ALIASES).length}
│ Categories » ${CATEGORIES.length}
│ Executed   » ${metricGet('commands')}
│ Errors     » ${metricGet('errors')}
╰────────────────────

╭─〔 🚀 *QUICK ACCESS* 〕
│ ${prefix}menu  » Command center
│ ${prefix}help  » Usage guide
│ ${prefix}song  » Music downloader
│ ${prefix}movie » Video/movie search
╰────────────────────`
}

function menuCard () {
  const p = getPrefix()
  const group = (category) => COMMANDS.filter((c) => c.category === category)
    .map((c) => `│ ${p}${c.usage}`).join('\n')
  return `╭━━〔 🛰️ *${BOT} COMMAND CENTER* 〕━━╮
│ Prefix » [${p}]
│ Commands » ${COMMANDS.length}  •  Categories » ${CATEGORIES.length}
╰━━━━━━━━━━━━━━━━━━━━━━╯

╭─〔 ⚡ *CORE* 〕
${group('Core')}
╰────────────────

╭─〔 🛡️ *GROUP CONTROL* 〕
${group('Group')}
╰────────────────

╭─〔 📡 *MEDIA* 〕
${group('Media')}
╰────────────────

╭─〔 🧠 *SYSTEM* 〕
${group('System')}
╰────────────────

╭─〔 🔐 *OWNER* 〕
${group('Owner')}
╰────────────────

Use *${p}help <command>* for details.`
}

function helpCard (arg = '') {
  const p = getPrefix()
  const q = String(arg || '').toLowerCase().trim()
  if (q) {
    const actual = ALIASES[q] || q
    const c = COMMANDS.find((x) => x.name === actual)
    if (!c) return `No help entry for *${q}*. Use ${p}menu to view available commands.`
    return `╭─〔 🧩 *COMMAND HELP* 〕
│ Command » ${p}${c.name}
│ Usage   » ${p}${c.usage}
│ Group   » ${c.category}
│ Info    » ${c.desc}
╰────────────────`
  }
  return `╭━━〔 🛠️ *${BOT} HELP NODE* 〕━━╮
│ ${p}start » system snapshot
│ ${p}menu  » full command center
│ ${p}help <command> » detailed usage
│
│ Examples:
│ ${p}song calm down rema
│ ${p}movie spiderman
│ ${p}kick @user
│ ${p}antilink on
│ ${p}ai on
╰────────────────────`
}

async function pingCard () {
  const r = await sampleRuntime()
  return `╭─〔 ⚡ *${BOT} PING* 〕
│ Status   » 🟢 Online
│ Ping     » ${r.pingMs}ms
│ CPU      » ${r.cpuPct.toFixed(1)}%
│ Memory   » ${formatBytes(r.mem.rss)}
│ Runtime  » ${formatUptime(process.uptime())}
│ Time     » ${formatTimeOnly()}
╰────────────────`
}

async function handleMessage (sock, msg) {
  const text = extractText(msg)
  if (!text) return

  const jid = msg?.key?.remoteJid
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return
  const isGroup = jid.endsWith('@g.us')
  const participant = msg.key.participant || msg.participant || ''
  const senderJid = msg.key.fromMe ? (sock.user?.id || participant || jid) : (isGroup ? (participant || jid) : jid)

  if (!isAllowedSender(senderJid, msg, isGroup)) {
    logger.info('[cmd] blocked private sender %s', senderJid)
    return
  }

  const owner = isOwner(senderJid, msg)
  const prefix = getPrefix()
  const parsed = parseCommand(text, prefix)

  // Automatic moderation runs on ordinary group traffic. Valid Pantheon commands
  // are exempt from anti-link so media commands can still contain a URL.
  if (isGroup) {
    const moderated = await moderateIncoming(sock, {
      msg, groupJid: jid, senderJid, text, owner, isCommand: Boolean(parsed)
    })
    if (moderated) return
  }

  // Quality follow-up intentionally works without a prefix.
  if (!parsed && QUALITY_RE.test(text) && pendingQuality.has(senderJid)) {
    const pending = pendingQuality.get(senderJid)
    pendingQuality.delete(senderJid)
    const quality = QUALITY_ALIAS[text.toLowerCase()]
    if (quality) return downloadEntry(sock, pending, quality)
  }

  // AI stays silent unless enabled and directly addressed/replied to/mentioned.
  if (!parsed) {
    if (isGroup) await maybeReplyAI(sock, { msg, groupJid: jid, senderJid, text })
    return
  }

  db.upsertUser({ jid: senderJid, phone: digits(senderJid), role: owner ? 'owner' : 'user' })
  metricAdd('commands')
  bus.emitSafe('command', {
    jid: senderJid, sender: senderJid, command: parsed.cmd, args: parsed.arg,
    text, at: new Date().toISOString()
  })

  const groupHandled = await handleGroupCommand(sock, {
    cmd: parsed.cmd,
    arg: parsed.arg,
    msg,
    groupJid: isGroup ? jid : null,
    senderJid,
    owner,
    prefix,
    reply: (message) => reply(sock, jid, message)
  })
  if (groupHandled) return

  try {
    switch (parsed.cmd) {
      case 'start': return reply(sock, jid, await startCard(sock))
      case 'menu': return reply(sock, jid, menuCard())
      case 'help': return reply(sock, jid, helpCard(parsed.arg))
      case 'ping': return reply(sock, jid, await pingCard())
      case 'prefix': return handlePrefixCommand(sock, jid, parsed.arg, owner)
      case 'movie':
      case 'video':
      case 'yt':
      case 'song':
      case 'mp3': return handleDownloadCommand(sock, jid, senderJid, parsed.cmd, parsed.arg)
      case 'quality': return handleQualityCommand(sock, jid, senderJid, parsed.arg)
      default: return reply(sock, jid, `⚠️ Unknown command *${parsed.rawCmd}*\nUse ${prefix}menu to open the command center.`)
    }
  } catch (err) {
    metricAdd('errors')
    logger.error('[cmd] handler error: %s', err.message)
    return reply(sock, jid, `⚠️ Command failed: ${String(err.message || err).slice(0, 300)}`)
  }
}

async function handlePrefixCommand (sock, jid, arg, owner) {
  if (!owner) return reply(sock, jid, '🔐 Only the bot owner can change the command prefix.')
  const current = getPrefix()
  const next = String(arg || '').trim()
  if (!next) {
    return reply(sock, jid, `╭─〔 ⚙️ *PREFIX CORE* 〕\n│ Current » [${current}]\n│ Allowed » ${SAFE_PREFIXES.join(' ')}\n│ Usage   » ${current}prefix .\n╰────────────────`)
  }
  if (next.length !== 1 || !SAFE_PREFIXES.includes(next)) {
    return reply(sock, jid, `❌ Prefix must be one supported symbol:\n${SAFE_PREFIXES.join(' ')}`)
  }
  db.setSetting(PREFIX_KEY, next)
  return reply(sock, jid, `✅ Command prefix changed: *${current}* → *${next}*\nNext command: ${next}menu`)
}

async function handleQualityCommand (sock, jid, senderJid, arg) {
  const raw = String(arg || '').trim().toLowerCase()
  const q = QUALITY_ALIAS[raw] || raw.replace(/p$/, '')
  if (!QUALITY_KEYS.includes(q)) {
    return reply(sock, jid, `Usage: ${getPrefix()}quality <240p|360p|480p|720p|HD|4K|8K|auto>`)
  }
  db.setSetting(`quality:${senderJid}`, q)
  return reply(sock, jid, `✅ Default quality set to *${config.qualityMap[q]?.label || q}*`)
}

async function handleDownloadCommand (sock, jid, senderJid, cmd, arg) {
  const p = getPrefix()
  if (!arg) {
    const usage = {
      movie: `${p}movie <title> — e.g. ${p}movie spiderman`,
      video: `${p}video <query> — e.g. ${p}video funny cats`,
      yt: `${p}yt <link>`,
      song: `${p}song <query> — e.g. ${p}song calm down rema`,
      mp3: `${p}mp3 <query or link>`
    }[cmd]
    return reply(sock, jid, `Usage: ${usage}`)
  }

  const type = (cmd === 'song' || cmd === 'mp3') ? 'audio' : 'video'
  const quality = db.getSetting(`quality:${senderJid}`) || config.download.defaultQuality
  const rec = db.createDownload({
    type, query: isUrl(arg) ? null : arg, url: isUrl(arg) ? arg : null,
    quality, chat: jid, sender: senderJid
  })

  if (isUrl(arg)) {
    await reply(sock, jid, type === 'audio' ? '🎵 Extracting audio…' : `📥 Downloading media at *${quality}*…`)
    return enqueueDownload(sock, jid, rec, { source: arg, title: arg })
  }

  await reply(sock, jid, type === 'audio'
    ? `🔎 Searching *${arg}* for audio…`
    : `🎬 Searching *${arg}*…\nQuality » *${quality}*`)
  return enqueueDownload(sock, jid, rec, { query: arg })
}

function enqueueDownload (sock, jid, rec, opts) {
  queue.add(() => doDownload(sock, jid, rec, opts)).catch((err) => {
    metricAdd('errors')
    logger.error('[dl] unhandled: %s', err.message)
  })
}

async function doDownload (sock, jid, rec, opts) {
  const { query, source } = opts
  db.updateDownload(rec.id, { status: 'searching', progress: 0 })
  try {
    let url = source
    if (!url) url = await searchAndDownload(query, rec.type, rec.quality, rec.id)
    db.updateDownload(rec.id, { status: 'downloading', url, title: query || source })

    const onProgress = (ev) => {
      if (ev.downloadId === rec.id) db.updateDownload(rec.id, { progress: ev.percent, size_bytes: ev.bytes })
    }
    bus.on('download.progress', onProgress)
    try {
      const result = await runYtDlp({ source: url, type: rec.type, quality: rec.quality, downloadId: rec.id })
      db.updateDownload(rec.id, { status: 'sending', progress: 100, size_bytes: result.sizeBytes, title: result.title, file: result.file })
      metricAdd('download_bytes', result.sizeBytes)
      await reply(sock, jid, `✅ *${result.title}*\n${formatBytes(result.sizeBytes)} — transmitting…`)
      await sendMedia(sock, jid, result.file, { type: rec.type, title: result.title })
      metricAdd('upload_bytes', result.sizeBytes)
      db.updateDownload(rec.id, { status: 'completed' })
      bus.emitSafe('download.completed', { downloadId: rec.id })
      pendingQuality.set(rec.sender, { id: rec.id, chat: jid })
      fs.unlink(result.file, () => {})
    } finally {
      bus.removeListener('download.progress', onProgress)
    }
  } catch (err) {
    metricAdd('errors')
    db.updateDownload(rec.id, { status: 'failed', error: String(err.message || err).slice(0, 500) })
    bus.emitSafe('download.failed', { downloadId: rec.id, error: err.message })
    await reply(sock, jid, `❌ Download failed: ${String(err.message || err).slice(0, 500)}`)
  }
}

async function downloadEntry (sock, entry, quality) {
  const rec = db.getDownload(entry.id)
  if (!rec) return
  db.updateDownload(rec.id, { quality, status: 'queued' })
  await reply(sock, entry.chat, `📥 Re-downloading at *${config.qualityMap[quality]?.label || quality}*…`)
  return enqueueDownload(sock, entry.chat, rec, { source: rec.url, query: rec.query })
}

module.exports = { handleMessage, getPrefix, COMMANDS }
