'use strict'

/**
 * Data layer — better-sqlite3 when available (production), automatic JSON-file
 * fallback when the native module fails to build (dev machines, some hosts).
 *
 * Collections: downloads (history), users (admin + allowed chats), settings (webhook).
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const config = require('./config')
const logger = require('./logger')

const DATA_DIR = config.data.dir
fs.mkdirSync(DATA_DIR, { recursive: true })

/* ─────────────────────────── helpers ─────────────────────────── */

function uid (len = 12) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len)
}

function nowIso () {
  return new Date().toISOString()
}

/* ─────────────────────────── sqlite implementation ─────────────────────────── */

let db = null
let mode = 'sqlite'

function initSqlite () {
  const Database = require('better-sqlite3')
  db = new Database(config.data.dbFile)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      query TEXT,
      url TEXT,
      title TEXT,
      quality TEXT,
      format TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      progress REAL DEFAULT 0,
      size_bytes INTEGER DEFAULT 0,
      chat TEXT,
      sender TEXT,
      error TEXT,
      file TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT UNIQUE,
      phone TEXT,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `)
  db.prepare('CREATE INDEX IF NOT EXISTS idx_downloads_created ON downloads(created_at DESC)').run()
}

/* ─────────────────────────── json fallback implementation ─────────────────────────── */

const jsonFiles = {
  downloads: path.join(DATA_DIR, 'downloads.json'),
  users: path.join(DATA_DIR, 'users.json'),
  settings: path.join(DATA_DIR, 'settings.json')
}

function readJson (name) {
  try {
    if (!fs.existsSync(jsonFiles[name])) return name === 'downloads' ? [] : {}
    return JSON.parse(fs.readFileSync(jsonFiles[name], 'utf8'))
  } catch (err) {
    logger.warn(`[db] failed reading ${name}.json — starting empty`)
    return name === 'downloads' ? [] : {}
  }
}

function writeJson (name, data) {
  fs.writeFileSync(jsonFiles[name], JSON.stringify(data, null, 2))
}

/* ─────────────────────────── public API ─────────────────────────── */

const store = {
  get mode () {
    return mode
  },

  /* ----- downloads ----- */

  createDownload (payload) {
    const row = {
      id: uid(16),
      type: payload.type || 'video',
      query: payload.query || null,
      url: payload.url || null,
      title: payload.title || null,
      quality: payload.quality || null,
      format: payload.format || null,
      status: 'queued',
      progress: 0,
      size_bytes: 0,
      chat: payload.chat || null,
      sender: payload.sender || null,
      error: null,
      file: null,
      created_at: nowIso(),
      updated_at: nowIso()
    }
    if (mode === 'sqlite') {
      db.prepare(`INSERT INTO downloads (id, type, query, url, title, quality, format, status, progress, size_bytes, chat, sender, error, file, created_at, updated_at)
        VALUES (@id, @type, @query, @url, @title, @quality, @format, @status, @progress, @size_bytes, @chat, @sender, @error, @file, @created_at, @updated_at)`).run(row)
    } else {
      const all = readJson('downloads')
      all.unshift(row)
      writeJson('downloads', all)
    }
    return row
  },

  updateDownload (id, patch) {
    const allowed = ['status', 'progress', 'size_bytes', 'title', 'quality', 'format', 'url', 'error', 'file']
    const clean = {}
    for (const k of allowed) if (patch[k] !== undefined) clean[k] = patch[k]
    if (!Object.keys(clean).length) return null
    clean.updated_at = nowIso()

    if (mode === 'sqlite') {
      const sets = Object.keys(clean).map((k) => `${k} = @${k}`).join(', ')
      db.prepare(`UPDATE downloads SET ${sets} WHERE id = @id`).run({ ...clean, id })
    } else {
      const all = readJson('downloads')
      const row = all.find((d) => d.id === id)
      if (row) Object.assign(row, clean)
      writeJson('downloads', all)
    }
    return this.getDownload(id)
  },

  getDownload (id) {
    if (mode === 'sqlite') {
      return db.prepare('SELECT * FROM downloads WHERE id = ?').get(id) || null
    }
    return readJson('downloads').find((d) => d.id === id) || null
  },

  listDownloads (opts = {}) {
    const { type, status, limit = 50, offset = 0 } = opts
    let rows
    if (mode === 'sqlite') {
      let sql = 'SELECT * FROM downloads'
      const where = []
      const params = {}
      if (type) { where.push('type = @type'); params.type = type }
      if (status) { where.push('status = @status'); params.status = status }
      if (where.length) sql += ' WHERE ' + where.join(' AND ')
      sql += ' ORDER BY created_at DESC LIMIT @limit OFFSET @offset'
      rows = db.prepare(sql).all({ ...params, limit, offset })
    } else {
      rows = readJson('downloads').sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      if (type) rows = rows.filter((r) => r.type === type)
      if (status) rows = rows.filter((r) => r.status === status)
      rows = rows.slice(offset, offset + limit)
    }
    return rows
  },

  countDownloads (filter = {}) {
    if (mode === 'sqlite') {
      let sql = 'SELECT COUNT(*) AS c FROM downloads'
      const where = []
      const params = {}
      if (filter.type) { where.push('type = @type'); params.type = filter.type }
      if (filter.status) { where.push('status = @status'); params.status = filter.status }
      if (where.length) sql += ' WHERE ' + where.join(' AND ')
      return db.prepare(sql).get(params).c
    }
    let rows = readJson('downloads')
    if (filter.type) rows = rows.filter((r) => r.type === filter.type)
    if (filter.status) rows = rows.filter((r) => r.status === filter.status)
    return rows.length
  },

  /* ----- users ----- */

  upsertUser (user) {
    const row = {
      jid: user.jid,
      phone: user.phone || null,
      name: user.name || null,
      role: user.role || 'user',
      created_at: nowIso()
    }
    if (mode === 'sqlite') {
      db.prepare(`INSERT INTO users (jid, phone, name, role, created_at) VALUES (@jid, @phone, @name, @role, @created_at)
        ON CONFLICT(jid) DO UPDATE SET phone = excluded.phone, name = excluded.name`).run(row)
    } else {
      const all = readJson('users')
      const existing = all.find((u) => u.jid === row.jid)
      if (existing) { existing.phone = row.phone; existing.name = row.name }
      else all.push(row)
      writeJson('users', all)
    }
    return row
  },

  listUsers () {
    if (mode === 'sqlite') return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all()
    return readJson('users')
  },

  /* ----- settings ----- */

  getSetting (key) {
    if (mode === 'sqlite') {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
      return row ? row.value : null
    }
    const all = readJson('settings')
    return all[key] !== undefined ? all[key] : null
  },

  setSetting (key, value) {
    if (mode === 'sqlite') {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
    } else {
      const all = readJson('settings')
      all[key] = String(value)
      writeJson('settings', all)
    }
    return value
  }
}

/* ─────────────────────────── boot ─────────────────────────── */

try {
  initSqlite()
  mode = 'sqlite'
  logger.info('[db] using better-sqlite3 @ %s', config.data.dbFile)
} catch (err) {
  mode = 'json'
  logger.warn('[db] better-sqlite3 unavailable (%s) — falling back to JSON files in %s', err.message, DATA_DIR)
}

module.exports = store
