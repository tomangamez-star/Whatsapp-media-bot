'use strict'

/**
 * Shared formatting helpers.
 */

function formatBytes (bytes, decimals = 2) {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`
}

function formatDuration (sec) {
  if (!sec || sec <= 0) return '0s'
  if (sec < 60) return `${Math.floor(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function formatUptime (sec) {
  if (!sec || sec < 0) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const parts = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  parts.push(`${s}s`)
  return parts.join(' ')
}

function sanitizeFilename (name, maxLen = 80) {
  return String(name || 'media')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen) || 'media'
}

/** Normalize a phone number to digits-only form. */
function cleanNumber (input) {
  return String(input || '').replace(/[^\d]/g, '')
}

/** Build a WhatsApp JID from a phone number. */
function toJid (phone) {
  const n = cleanNumber(phone)
  if (!n) return null
  return `${n}@s.whatsapp.net`
}

function safeJsonParse (str, fallback) {
  try {
    return JSON.parse(str)
  } catch {
    return fallback
  }
}

module.exports = {
  formatBytes,
  formatDuration,
  formatUptime,
  sanitizeFilename,
  cleanNumber,
  toJid,
  safeJsonParse
}
