'use strict'

/**
 * Download engine — yt-dlp via yt-dlp-exec.
 * Supports optional cookies/proxy for cloud hosts such as Render where YouTube
 * may challenge datacenter IPs with "Sign in to confirm you're not a bot".
 */

const fs = require('fs')
const path = require('path')
const ytdlp = require('yt-dlp-exec')
const config = require('../config')
const logger = require('../logger')
const bus = require('../events')
const { sanitizeFilename } = require('../utils/format')
const { resolveFfmpeg } = require('../utils/ffmpeg')

const MEDIA_DIR = config.download.mediaDir
fs.mkdirSync(MEDIA_DIR, { recursive: true })

const QUALITIES = config.qualityMap
let cookieFile = null
let cookiePrepared = false

function heightSelector (height) {
  if (!height || height <= 0) return 'height'
  return `height<=${height}`
}

function buildVideoFormat (qualityKey) {
  const q = QUALITIES[qualityKey] || QUALITIES[config.download.defaultQuality]
  const sel = heightSelector(q.height)
  return [
    `bv*[ext=mp4][${sel}]+ba[ext=m4a]/bv*[${sel}]+ba[ext=m4a]/b[ext=mp4][${sel}]/b[${sel}]`,
    'bv*+ba/b',
    'best'
  ].join('/')
}

function parseProgress (line) {
  const m = line.match(/([\d.]+)%\s+of\s+~?\s*([\d.]+)([KMG]iB)/)
  if (!m) return null
  const pct = parseFloat(m[1])
  const mult = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[m[3]] || 1
  return { percent: Math.min(100, pct), bytes: Math.round(parseFloat(m[2]) * mult) }
}

function emitProgress (downloadId, data) {
  bus.emitSafe('download.progress', { downloadId, ...data })
}

function prepareCookieFile () {
  if (cookiePrepared) return cookieFile
  cookiePrepared = true

  if (config.download.ytdlpCookiesFile) {
    if (fs.existsSync(config.download.ytdlpCookiesFile)) {
      cookieFile = config.download.ytdlpCookiesFile
      logger.info('[dl] using yt-dlp cookies file from YTDLP_COOKIES_FILE')
    } else {
      logger.warn('[dl] YTDLP_COOKIES_FILE does not exist: %s', config.download.ytdlpCookiesFile)
    }
    return cookieFile
  }

  if (config.download.ytdlpCookiesBase64) {
    try {
      const raw = Buffer.from(config.download.ytdlpCookiesBase64.replace(/\s+/g, ''), 'base64')
      const text = raw.toString('utf8')
      if (!/Netscape HTTP Cookie File|\.youtube\.com|youtube\.com/i.test(text)) {
        throw new Error('decoded data does not look like a Netscape cookies.txt file')
      }
      const dir = config.data.dir
      fs.mkdirSync(dir, { recursive: true })
      cookieFile = path.join(dir, '.pantheon-ytdlp-cookies.txt')
      fs.writeFileSync(cookieFile, raw, { mode: 0o600 })
      try { fs.chmodSync(cookieFile, 0o600) } catch { /* Windows/dev */ }
      logger.info('[dl] materialized yt-dlp cookies from YTDLP_COOKIES_B64')
    } catch (err) {
      logger.warn('[dl] invalid YTDLP_COOKIES_B64: %s', err.message)
      cookieFile = null
    }
  }

  return cookieFile
}

function commonArgs () {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--no-colors',
    '--socket-timeout', '25',
    '--retries', '4',
    '--fragment-retries', '4'
  ]
  const cookies = prepareCookieFile()
  if (cookies) args.push('--cookies', cookies)
  if (config.download.proxyUrl) args.push('--proxy', config.download.proxyUrl)
  return args
}

function cleanYtError (raw) {
  const text = String(raw || 'unknown yt-dlp error').replace(/\x1b\[[0-9;]*m/g, '').trim()
  if (/sign in to confirm (?:you.?re|you are) not a bot|sign in to confirm you.?re not a bot/i.test(text)) {
    return new Error(
      'YouTube challenged Pantheon\'s Render IP ("Sign in to confirm you are not a bot"). ' +
      'Set YTDLP_COOKIES_B64 in Render to a base64-encoded YouTube cookies.txt export, or set YTDLP_PROXY_URL to a trusted outbound proxy, then redeploy.'
    )
  }
  if (/HTTP Error 403|forbidden/i.test(text) && !prepareCookieFile()) {
    return new Error('YouTube returned HTTP 403 from the server IP. Configure YTDLP_COOKIES_B64 or YTDLP_PROXY_URL on Render.')
  }
  return new Error(`yt-dlp failed: ${text}`.slice(0, 700))
}

async function runYtDlp (opts) {
  const { source, type, quality, downloadId } = opts
  const qualityKey = quality || config.download.defaultQuality
  const isAudio = type === 'audio'
  const q = QUALITIES[qualityKey] || QUALITIES.auto
  const outTemplate = path.join(MEDIA_DIR, `%(id)s_${downloadId}.%(ext)s`)
  const args = commonArgs()

  const ffmpegBin = resolveFfmpeg()
  if (ffmpegBin) args.push('--ffmpeg-location', ffmpegBin)

  if (isAudio) {
    args.push(
      '-f', 'ba/b',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--embed-metadata',
      '--max-filesize', `${Math.min(config.download.maxFileSizeMb, 60)}M`
    )
  } else {
    args.push(
      '-f', buildVideoFormat(qualityKey),
      '--merge-output-format', 'mp4',
      '--remux-video', 'mp4',
      '--max-filesize', `${config.download.maxFileSizeMb}M`
    )
    if (q.height > 0) args.push('-S', `res:${q.height}`)
  }

  args.push('-o', outTemplate, source)
  logger.info('[dl] yt-dlp %s → %s (quality=%s cookies=%s proxy=%s)',
    isAudio ? 'audio' : 'video', source, qualityKey, prepareCookieFile() ? 'yes' : 'no', config.download.proxyUrl ? 'yes' : 'no')

  const proc = ytdlp.exec(args, {}, { reject: false })
  let title = null

  proc.stderr?.on?.('data', (chunk) => {
    const text = String(chunk)
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const prog = parseProgress(line)
      if (prog) {
        emitProgress(downloadId, { percent: prog.percent, bytes: prog.bytes })
        continue
      }
      const t = line.match(/\[info\]\s+Downloading\s+video\s+1\s+of\s+1:\s+(.+)/)
      if (t) title = t[1].trim()
      else if (!title) {
        const t2 = line.match(/\[info\]\s+(.+)/)
        if (t2) title = t2[1].trim()
      }
    }
  })

  const result = await proc
  if (result.exitCode !== 0) throw cleanYtError(result.stderr || result.stdout || `exit ${result.exitCode}`)

  const candidates = fs.readdirSync(MEDIA_DIR).filter((f) => f.includes(`_${downloadId}.`) || f.startsWith(`${downloadId}.`))
  const match = candidates.sort((a, b) => b.length - a.length)[0]
  if (!match) throw new Error('yt-dlp finished but produced no file')

  const finalFile = path.join(MEDIA_DIR, match)
  const sizeBytes = fs.statSync(finalFile).size
  if (!title) title = path.basename(match).replace(/\.[^.]+$/, '')
  return { file: finalFile, title: sanitizeFilename(title, 120), sizeBytes }
}

async function searchAndDownload (query, type, quality, downloadId, { maxResults = 8 } = {}) {
  void type; void quality; void downloadId
  const searchArgs = [
    ...commonArgs(),
    '--flat-playlist',
    '-J', `ytsearch${maxResults}:${query}`
  ]
  try {
    const out = await ytdlp.exec(searchArgs, {}, { reject: false })
    if (out.exitCode !== 0) throw cleanYtError(out.stderr || out.stdout || `exit ${out.exitCode}`)
    const json = JSON.parse(out.stdout)
    const entries = (json.entries || []).filter((e) => e && e.id)
    if (!entries.length) throw new Error('No results found for that query')
    return entries[0].webpage_url || `https://www.youtube.com/watch?v=${entries[0].id}`
  } catch (err) {
    if (err?.message?.startsWith('YouTube ') || err?.message?.startsWith('yt-dlp failed')) throw err
    throw new Error(`Search failed: ${err.message}`)
  }
}

module.exports = { runYtDlp, searchAndDownload, buildVideoFormat, parseProgress, QUALITIES }
