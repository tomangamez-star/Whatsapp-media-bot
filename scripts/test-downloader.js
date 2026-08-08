'use strict'

/**
 * Smoke test for the downloader service — runs a real yt-dlp search +
 * small download to verify the engine works end-to-end.
 *
 * Usage: node scripts/test-downloader.js
 */

const { searchAndDownload, runYtDlp } = require('../src/services/downloader')
const db = require('../src/db')
const fs = require('fs')

async function main () {
  const query = process.argv[2] || 'rick roll (never gonna give you up)'
  console.log(`▶ Searching for: "${query}"`)
  const rec = db.createDownload({ type: 'video', query, quality: '240', chat: 'test', sender: 'test' })
  console.log('▶ download id:', rec.id)

  const url = await searchAndDownload(query, 'video', '240', rec.id, { maxResults: 3 })
  console.log('▶ best result:', url)

  db.updateDownload(rec.id, { status: 'downloading', url })
  const result = await runYtDlp({ source: url, type: 'video', quality: '240', downloadId: rec.id })
  console.log('✅ downloaded:', result.file, `(${result.sizeBytes} bytes)`)
  console.log('✅ title:', result.title)

  fs.unlinkSync(result.file)
  db.updateDownload(rec.id, { status: 'completed', file: result.file })
  console.log('✅ test passed')
  process.exit(0)
}

main().catch((err) => {
  console.error('❌ test failed:', err.message)
  process.exit(1)
})
