'use strict'

/**
 * Central configuration — reads environment variables with safe defaults.
 */
const path = require('path')
require('dotenv').config()

const ROOT = path.join(__dirname, '..')

const bool = (v, dflt = false) => (v === undefined || v === '' ? dflt : String(v).toLowerCase() === 'true' || String(v) === '1')

const config = {
  root: ROOT,

  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0'
  },

  auth: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'wa-bot-admin',
    token: process.env.ADMIN_TOKEN || '',
    sessionTtlDays: 30
  },

  bot: {
    name: process.env.BOT_NAME || 'WhatsApp Media Bot',
    // WhatsApp profile — bot only replies to chats listed here.
    // Comma separated numbers with country code, e.g. "15551234567,911234567890"
    allowedChats: (process.env.ALLOWED_CHATS || '')
      .split(',')
      .map((s) => s.trim().replace(/\D/g, ''))
      .filter(Boolean)
  },

  download: {
    maxConcurrent: Math.max(1, parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '2', 10)),
    defaultQuality: process.env.DEFAULT_QUALITY || '720',
    maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '1900', 10),
    cleanupAfterMinutes: parseInt(process.env.CLEANUP_AFTER_MINUTES || '120', 10),
    mediaDir: process.env.MEDIA_DIR || path.join(ROOT, 'data', 'media')
  },

  session: {
    dir: process.env.SESSION_DIR || path.join(ROOT, 'data', 'session'),
    forceLogout: bool(process.env.FORCE_LOGOUT, false),
    // Country code used to normalize national-format phone numbers for the
    // pairing code flow, e.g. "234" for Nigeria (07074455500 -> 2347074455500).
    // Leave empty to accept only full E.164 numbers.
    defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '',
    // Optional outbound proxy for the WhatsApp WebSocket (Baileys `agent`).
    // Escape hatch when WhatsApp rejects/rate-limits pairing from a datacenter
    // IP (Render/VPS/cloud). Examples:
    //   socks5h://user:pass@host:1080   (SOCKS5 — recommended, e.g. mobile/residential proxy)
    //   http://user:pass@host:3128      (HTTP CONNECT)
    // Empty by default (direct connection). Built lazily below — if the
    // proxy-agent packages are unavailable, the app still boots and warns.
    proxyUrl: (process.env.PROXY_URL || '').trim()
  },

  data: {
    dir: process.env.DATA_DIR || path.join(ROOT, 'data'),
    dbFile: path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'media-bot.db')
  },

  webhook: {
    url: process.env.WEBHOOK_URL || '',
    secret: process.env.WEBHOOK_SECRET || '',
    enabled: bool(process.env.WEBHOOK_ENABLED, false),
    events: (process.env.WEBHOOK_EVENTS || 'command,download.started,download.completed,download.failed,session.connected,session.disconnected,bot.ready')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  },

  keepalive: {
    intervalSec: parseInt(process.env.KEEPALIVE_INTERVAL_SEC || '300', 10)
  },

  qualityMap: {
    '240': { height: 240, label: '240p' },
    '360': { height: 360, label: '360p' },
    '480': { height: 480, label: '480p' },
    '720': { height: 720, label: '720p' },
    '1080': { height: 1080, label: 'HD (1080p)' },
    '2160': { height: 2160, label: '4K (2160p)' },
    '4320': { height: 4320, label: '8K (4320p)' },
    'auto': { height: 0, label: 'Best available' }
  }
}

// Build an optional proxy agent for the WhatsApp WebSocket (Baileys `agent`).
// Uses https-proxy-agent / socks-proxy-agent if installed; if they are missing
// (e.g. --omit=dev installs), the app still boots — the pairing just stays on
// the direct connection and a warning is logged.
const { URL } = require('url')
let _proxyAgent = null
let _proxyAgentBuilt = false

Object.defineProperty(config.session, 'proxyAgent', {
  enumerable: true,
  get () {
    if (!config.session.proxyUrl) return undefined
    if (_proxyAgentBuilt) return _proxyAgent
    _proxyAgentBuilt = true
    try {
      const { HttpsProxyAgent } = require('https-proxy-agent')
      const { SocksProxyAgent } = require('socks-proxy-agent')
      const u = new URL(config.session.proxyUrl)
      _proxyAgent = u.protocol === 'socks:' || u.protocol === 'socks5:' || u.protocol === 'socks5h:'
        ? new SocksProxyAgent(config.session.proxyUrl)
        : new HttpsProxyAgent(config.session.proxyUrl)
      // eslint-disable-next-line no-console
      console.warn(`[config] using WhatsApp WebSocket proxy ${u.protocol}//${u.hostname}:${u.port || 'default'}`)
    } catch (err) {
      _proxyAgent = undefined
      // eslint-disable-next-line no-console
      console.warn(`[config] PROXY_URL set but proxy agent unavailable (${err.message}) — add https-proxy-agent + socks-proxy-agent to dependencies`)
    }
    return _proxyAgent
  }
})

module.exports = config