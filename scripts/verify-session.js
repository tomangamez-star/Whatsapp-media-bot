'use strict'
/* Verify the QR + pairing code are REAL Baileys outputs served by the API. */
const BASE = process.env.BASE || 'http://127.0.0.1:3400'

async function main () {
  // 1. login
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'testpass123' })
  })
  const { token } = await loginRes.json()
  if (!token) throw new Error('login failed')
  console.log('login ok, token len', token.length)

  const H = { 'x-access-token': token, 'Content-Type': 'application/json' }

  // 2. session state — QR should be present and a REAL PNG data URL
  const s = await (await fetch(`${BASE}/api/session`, { headers: H })).json()
  console.log('state:', s.state, '| connected:', s.connected)
  console.log('hasQR:', !!s.qr, '| qrPrefix:', s.qr ? s.qr.slice(0, 30) : 'none')
  console.log('pairingCode:', s.pairingCode)

  // decode QR data URL and check PNG magic + dimensions header
  if (s.qr) {
    const b64 = s.qr.split(',')[1]
    const buf = Buffer.from(b64, 'base64')
    console.log('QR bytes:', buf.length, '| PNG magic ok:', buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a')
    // IHDR width/height at bytes 16-23 (big-endian)
    const w = buf.readUInt32BE(16)
    const h = buf.readUInt32BE(20)
    console.log('QR PNG dimensions:', w + 'x' + h)
    // save to file for visual inspection
    require('fs').writeFileSync('/tmp/live-qr.png', buf)
    console.log('saved /tmp/live-qr.png')
  }

  // 3. request a pairing code — must return a real 8-char code
  const pair = await (await fetch(`${BASE}/api/session/pair`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ phone: '14155552671' })
  })).json()
  console.log('pair response:', JSON.stringify(pair))
  if (pair.pairingCode) {
    const c = String(pair.pairingCode)
    console.log('pairing code:', c, '| is 8 alnum chars:', /^[A-Z0-9]{8}$/.test(c))
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exit(1) })