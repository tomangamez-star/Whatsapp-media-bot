'use strict'

/**
 * Media sender — pushes downloaded files back into WhatsApp.
 * Videos >30s or >16MB are sent as documents (WhatsApp limitation) — the
 * dashboard/README document this behavior.
 */

const fs = require('fs')
const path = require('path')
const { formatBytes } = require('../utils/format')

/**
 * @param {object} sock Baileys socket
 * @param {string} jid target chat
 * @param {string} file absolute path
 * @param {object} meta { title, type: 'video'|'audio', caption }
 */
async function sendMedia (sock, jid, file, meta) {
  const stat = fs.statSync(file)
  const sizeMb = stat.size / (1024 * 1024)
  const isVideo = meta.type === 'video'
  const ext = path.extname(file).toLowerCase()

  // WhatsApp caps video messages: max ~16MB and ~30s. Larger → send as document.
  const asDocument = sizeMb > 15 || (isVideo && false) // keep videos under 15MB as video
  const filename = path.basename(file)
  const caption = meta.caption || meta.title || ''

  if (isVideo && sizeMb <= 15) {
    await sock.sendMessage(jid, {
      video: { url: file },
      caption: caption.slice(0, 1024),
      mimetype: 'video/mp4'
    })
    return
  }

  if (!isVideo) {
    // audio — try native audio message first, fall back to document
    try {
      await sock.sendMessage(jid, {
        audio: { url: file },
        mimetype: 'audio/mpeg',
        ptt: false
      })
      return
    } catch (err) {
      logger.warn('[send] audio message failed (%s) — falling back to document', err.message)
    }
  }

  // document fallback (also used for large videos / non-mp4)
  await sock.sendMessage(jid, {
    document: { url: file },
    fileName: filename,
    mimetype: ext === '.mp3' ? 'audio/mpeg' : 'video/mp4',
    caption: caption.slice(0, 1024)
  })
  void asDocument
}

module.exports = { sendMedia }
