'use strict'

/**
 * Baileys auth-state adapter.
 * - DATABASE_URL present: creds + every signal key live in Postgres/Supabase.
 * - no DATABASE_URL: falls back to Baileys' local multi-file auth state.
 *
 * The Postgres format uses Baileys BufferJSON so Buffers/Uint8Arrays survive
 * round-trips correctly. That matters for message decryption after redeploys.
 */

const fs = require('fs')
const config = require('../config')
const postgres = require('../services/postgres')
const logger = require('../logger')

const SESSION_ID = process.env.WA_SESSION_ID || 'pantheon-main'
let schemaReady = false

async function ensureSchema () {
  if (!postgres.enabled() || schemaReady) return
  await postgres.query(`
    CREATE TABLE IF NOT EXISTS pantheon_wa_auth (
      session_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, item_key)
    )
  `)
  schemaReady = true
}

function encode (value, BufferJSON) {
  return JSON.stringify(value, BufferJSON.replacer)
}

function decode (value, BufferJSON) {
  return JSON.parse(value, BufferJSON.reviver)
}

async function usePostgresAuthState (bw) {
  await ensureSchema()
  const { BufferJSON, initAuthCreds, proto } = bw
  if (!BufferJSON || !initAuthCreds) throw new Error('Installed Baileys build does not expose BufferJSON/initAuthCreds')

  const readOne = async (itemKey) => {
    const result = await postgres.query(
      'SELECT value FROM pantheon_wa_auth WHERE session_id = $1 AND item_key = $2',
      [SESSION_ID, itemKey]
    )
    if (!result.rows[0]) return null
    return decode(result.rows[0].value, BufferJSON)
  }

  const writeOne = async (itemKey, value) => {
    const encoded = encode(value, BufferJSON)
    await postgres.query(`
      INSERT INTO pantheon_wa_auth (session_id, item_key, value, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (session_id, item_key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [SESSION_ID, itemKey, encoded])
  }

  const creds = (await readOne('creds')) || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          if (!ids?.length) return {}
          const itemKeys = ids.map((id) => `key:${type}:${id}`)
          const result = await postgres.query(
            'SELECT item_key, value FROM pantheon_wa_auth WHERE session_id = $1 AND item_key = ANY($2::text[])',
            [SESSION_ID, itemKeys]
          )
          const byKey = new Map(result.rows.map((row) => [row.item_key, row.value]))
          const out = {}
          for (const id of ids) {
            const raw = byKey.get(`key:${type}:${id}`)
            if (!raw) continue
            let value = decode(raw, BufferJSON)
            if (type === 'app-state-sync-key' && value && proto?.Message?.AppStateSyncKeyData) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value)
            }
            out[id] = value
          }
          return out
        },
        set: async (data) => {
          await postgres.withClient(async (client) => {
            await client.query('BEGIN')
            try {
              for (const [type, entries] of Object.entries(data || {})) {
                for (const [id, value] of Object.entries(entries || {})) {
                  const itemKey = `key:${type}:${id}`
                  if (value === null || value === undefined) {
                    await client.query(
                      'DELETE FROM pantheon_wa_auth WHERE session_id = $1 AND item_key = $2',
                      [SESSION_ID, itemKey]
                    )
                  } else {
                    await client.query(`
                      INSERT INTO pantheon_wa_auth (session_id, item_key, value, updated_at)
                      VALUES ($1, $2, $3, NOW())
                      ON CONFLICT (session_id, item_key)
                      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
                    `, [SESSION_ID, itemKey, encode(value, BufferJSON)])
                  }
                }
              }
              await client.query('COMMIT')
            } catch (err) {
              await client.query('ROLLBACK')
              throw err
            }
          })
        }
      }
    },
    saveCreds: () => writeOne('creds', creds),
    storage: 'postgres'
  }
}

async function createAuthState (bw) {
  if (postgres.enabled()) {
    const state = await usePostgresAuthState(bw)
    logger.info('[auth] using Postgres/Supabase session store (%s)', SESSION_ID)
    return state
  }

  fs.mkdirSync(config.session.dir, { recursive: true })
  const local = await bw.useMultiFileAuthState(config.session.dir)
  logger.warn('[auth] DATABASE_URL not set — using ephemeral local session files')
  return { ...local, storage: 'local' }
}

async function clearAuthState () {
  fs.rmSync(config.session.dir, { recursive: true, force: true })
  fs.mkdirSync(config.session.dir, { recursive: true })
  if (postgres.enabled()) {
    await ensureSchema()
    await postgres.query('DELETE FROM pantheon_wa_auth WHERE session_id = $1', [SESSION_ID])
    logger.info('[auth] cleared Postgres session %s', SESSION_ID)
  }
}

module.exports = { createAuthState, clearAuthState }
