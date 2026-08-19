'use strict'

/**
 * Download engine — wraps yt-dlp (via yt-dlp-exec).
 *
 * Supports:
 *   • search → pick best result   (.movie spiderman, .video cats, .song imagine dragons)
 *   • direct URL                  (.yt https://youtube.com/watch?v=..., .mp3 <link>)
 *   • video quality ladder        240p / 360p / 480p / 720p / HD / 4K / 8K / auto
 *   • audio-only extraction       (m4a/mp3 via ffmpeg)
 *
 * The binary auto-downloads on first use (yt-dlp-exec). If that fails, it falls
 * back to a system `yt-dlp`/`youtube-dl` binary on PATH.
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

/** video format selector for a target height (yt-dlp -S syntax). */
function heightSelector (height) {
  if (!height || height <= 0) return 'height'
  return `height<=${height}`
}

/** Build a compact, resilient format string for a video download. */
function buildVideoFormat (qualityKey) {
  const q = QUALITIES[qualityKey] || QUALITIES[config.download.defaultQuality]
  const sel = heightSelector(q.height)

  // Prefer mp4 when possible, otherwise mkv/webm are fine — yt-dlp merges + remuxes.
  return [
    `bv*[ext=mp4][${sel}]+ba[ext=m4a]/bv*[${sel}]+ba[ext=m4a]/b[ext=mp4][${sel}]/b[${sel}]`,
    'bv*+ba/b',
    'best'
  ].join('/')
}

/** Parse yt-dlp progress lines ("[download]  42.3% of 12.34MiB at 1.2MiB/s ETA 00:05") */
function parseProgress (line) {
  const m = line.match(/([\d.]+)%\s+of\s+~?\s*([\d.]+)([KMG]iB)/)
  if (!m) return null
  const pct = parseFloat(m[1])
  const mult = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[m[3]] || 1
  return { percent: Math.min(100, pct), bytes: Math.round(parseFloat(m[2]) * mult) }
}

/** Emit a download.started / download.progress event with a normalized payload. */
function emitProgress (downloadId, data) {
  bus.emitSafe('download.progress', { downloadId, ...data })
}

/**
 * Run yt-dlp and stream progress events.
 * @param {object} opts { source, type, quality, downloadId, onTitle }
 * @returns {Promise<{file, title, sizeBytes}>}
 */
async function runYtDlp (opts) {
  const { source, type, quality, downloadId } = opts
  const qualityKey = quality || config.download.defaultQuality

  const isAudio = type === 'audio'
  const q = QUALITIES[qualityKey] || QUALITIES.auto
  const outTemplate = path.join(MEDIA_DIR, `%(id)s_${downloadId}.%(ext)s`)
  const outStem = path.join(MEDIA_DIR, `${downloadId}`)

  const args = ['--no-playlist', '--no-warnings', '--no-call-home', '--newline', '--no-colors']

  // Point yt-dlp at the bundled static ffmpeg (audio extract / merge / remux).
  // Falls back to a system ffmpeg on PATH if ffmpeg-static isn't installed.
  const ffmpegBin = resolveFfmpeg()
  if (ffmpegBin) args.push('--ffmpeg-location', ffmpegBin)

  if (isAudio) {
    args.push(
      '-f', 'ba/b',
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--embed-metadata'
    )
    // size guard: 60 MB cap for audio files (generous, WhatsApp-friendly)
    args.push('--max-filesize', `${Math.min(config.download.maxFileSizeMb, 60)}M`)
  } else {
    args.push(
      '-f', buildVideoFormat(qualityKey),
      '--merge-output-format', 'mp4',
      '--remux-video', 'mp4',
      '--max-filesize', `${config.download.maxFileSizeMb}M`
    )
    if (q.height > 0) {
      args.push('-S', `res:${q.height}`) // sort by resolution, never exceed target
    }
    // prefer larger file if multiple choices match (e.g. 8K vs 4K source)
    args.push('--no-playlist')
  }

  args.push('-o', outTemplate, source)

  logger.info('[dl] yt-dlp %s → %s (quality=%s)', isAudio ? 'audio' : 'video', source, qualityKey)

  const proc = ytdlp.exec(args, {}, { reject: false })
  let title = null
  let finalFile = null
  let sizeBytes = 0

  proc.stderr.on('data', (chunk) => {
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
  if (result.exitCode !== 0) {
    throw new Error(`yt-dlp failed (${result.exitCode}): ${result.stderr || result.stdout || 'unknown error'}`.slice(0, 500))
  }

  // locate produced file
  const candidates = fs.readdirSync(MEDIA_DIR).filter((f) => f.includes(`_${downloadId}.`) || f.startsWith(`${downloadId}.`))
  const match = candidates.sort((a, b) => b.length - a.length)[0]
  if (!match) throw new Error('yt-dlp finished but produced no file')
  finalFile = path.join(MEDIA_DIR, match)
  sizeBytes = fs.statSync(finalFile).size

  if (!title) title = path.basename(match).replace(/\.[^.]+$/, '')
  return { file: finalFile, title: sanitizeFilename(title, 120), sizeBytes }
}

/**
 * Search the web (YouTube + general) for media by query and download the best hit.
 */
async function searchAndDownload (query, type, quality, downloadId, { maxResults = 8 } = {}) {
  // ytsearch: returns up to N results, we pick the first downloadable one
  const searchArgs = [
    '--no-playlist', '--no-warnings', '--no-call-home', '--flat-playlist',
    '-J', `ytsearch${maxResults}:${query}`
  ]
  let json
  try {
    const out = await ytdlp.exec(searchArgs, {}, { reject: false })
    json = JSON.parse(out.stdout)
  } catch (err) {
    throw new Error(`Search failed: ${err.message}`)
  }
  const entries = (json.entries || []).filter((e) => e && e.id)
  if (!entries.length) throw new Error('No results found for that query')
  return entries[0].webpage_url || `https://www.youtube.com/watch?v=${entries[0].id}`
}

module.exports = { runYtDlp, searchAndDownload, buildVideoFormat, parseProgress, QUALITIES }