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
    defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || ''
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

module.exports = config