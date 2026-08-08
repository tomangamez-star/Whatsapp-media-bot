'use strict'

/**
 * Outbound webhook dispatcher — posts bot events to a user-configured URL.
 * Delivered with HMAC signature (X-WaBot-Signature) when a secret is set.
 */

const crypto = require('crypto')
const config = require('../config')
const db = require('../db')
const logger = require('../logger')
const bus = require('../events')

const MAX_BODY = 64 * 1024

function getWebhookConfig () {
  return {
    url: db.getSetting('webhook:url') || config.webhook.url || '',
    secret: db.getSetting('webhook:secret') || config.webhook.secret || '',
    enabled: (db.getSetting('webhook:enabled') ?? (config.webhook.enabled ? 'true' : 'false')) === 'true',
    events: (db.getSetting('webhook:events') || config.webhook.events.join(',')).split(',').map((s) => s.trim()).filter(Boolean)
  }
}

function sign (payload, secret) {
  if (!secret) return null
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

function matchesEvent (cfg, event) {
  return cfg.events.includes('*') || cfg.events.includes(event)
}

async function deliver (event, payload) {
  const cfg = getWebhookConfig()
  if (!cfg.enabled || !cfg.url || !matchesEvent(cfg, event)) return

  const body = JSON.stringify({ event, at: new Date().toISOString(), data: payload })
  if (body.length > MAX_BODY) {
    logger.warn('[webhook] payload too large for %s (%d bytes) — skipping', event, body.length)
    return
  }

  const headers = { 'Content-Type': 'application/json' }
  const sig = sign(body, cfg.secret)
  if (sig) headers['X-WaBot-Signature'] = sig

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(cfg.url, {
      method: 'POST', headers, body, signal: controller.signal
    })
    if (res.status >= 300) {
      logger.warn('[webhook] %s → HTTP %s', event, res.status)
    } else {
      logger.info('[webhook] %s delivered (%s)', event, res.status)
    }
  } catch (err) {
    logger.warn('[webhook] %s delivery failed: %s', event, err.message)
  } finally {
    clearTimeout(timer)
  }
}

function saveConfig (cfg) {
  db.setSetting('webhook:url', cfg.url || '')
  db.setSetting('webhook:secret', cfg.secret || '')
  db.setSetting('webhook:enabled', cfg.enabled ? 'true' : 'false')
  db.setSetting('webhook:events', (cfg.events || []).join(','))
  return getWebhookConfig()
}

// wire event bus → webhook
bus.on('command', (p) => deliver('command', p))
bus.on('download.started', (p) => deliver('download.started', p))
bus.on('download.completed', (p) => deliver('download.completed', p))
bus.on('download.failed', (p) => deliver('download.failed', p))
bus.on('session.connected', (p) => deliver('session.connected', p))
bus.on('session.disconnected', (p) => deliver('session.disconnected', p))
bus.on('bot.ready', (p) => deliver('bot.ready', p))

module.exports = { getWebhookConfig, saveConfig, deliver }
