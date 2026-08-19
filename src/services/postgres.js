'use strict'

/**
 * Small shared Postgres/Supabase pool.
 * DATABASE_URL is optional: without it Pantheon keeps the existing local mode.
 */

const { Pool } = require('pg')
const config = require('../config')
const logger = require('../logger')

let pool = null
let initPromise = null
let healthy = false

function enabled () {
  return Boolean(config.database.url)
}

function safeHost () {
  try { return new URL(config.database.url).hostname } catch { return 'configured-host' }
}

function shouldUseSsl () {
  if (config.database.ssl !== null) return config.database.ssl
  try {
    const host = new URL(config.database.url).hostname
    return !['localhost', '127.0.0.1', '::1'].includes(host)
  } catch {
    return true
  }
}

async function init () {
  if (!enabled()) return null
  if (initPromise) return initPromise

  initPromise = (async () => {
    pool = new Pool({
      connectionString: config.database.url,
      max: config.database.poolMax,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      ssl: shouldUseSsl() ? { rejectUnauthorized: false } : false
    })

    pool.on('error', (err) => {
      healthy = false
      logger.error('[pg] idle client error: %s', err.message)
    })

    await pool.query('SELECT 1')
    healthy = true
    logger.info('[pg] connected to %s (pool max=%s)', safeHost(), config.database.poolMax)
    return pool
  })().catch((err) => {
    healthy = false
    initPromise = null
    if (pool) {
      try { pool.end() } catch { /* ignore */ }
      pool = null
    }
    throw err
  })

  return initPromise
}

async function query (text, params) {
  const p = await init()
  if (!p) throw new Error('DATABASE_URL is not configured')
  try {
    const result = await p.query(text, params)
    healthy = true
    return result
  } catch (err) {
    healthy = false
    throw err
  }
}

async function withClient (fn) {
  const p = await init()
  if (!p) throw new Error('DATABASE_URL is not configured')
  const client = await p.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

async function close () {
  if (!pool) return
  const p = pool
  pool = null
  initPromise = null
  healthy = false
  await p.end()
}

function status () {
  return {
    enabled: enabled(),
    connected: healthy,
    host: enabled() ? safeHost() : null
  }
}

module.exports = { enabled, init, query, withClient, close, status }
