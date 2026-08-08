'use strict'

/* ─────────────────────────────────────────────
   WhatsApp Media Bot — dashboard app logic
   Auth, Socket.IO realtime, pairing, feed, history, webhook.
   Vanilla JS — no framework, no build step.
   ───────────────────────────────────────────── */

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => Array.from(document.querySelectorAll(sel))
const API = '/api'

let token = localStorage.getItem('wa_bot_token') || ''
let socket = null
let feedPaused = false

/* ── helpers ── */

async function api (path, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (token) headers['x-access-token'] = token
  if (options.body && typeof options.body === 'object') {
    headers['Content-Type'] = 'application/json'
    options.body = JSON.stringify(options.body)
  }
  const res = await fetch(API + path, { ...options, headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401) { showLogin(); throw new Error('Unauthorized') }
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

function toast (msg, type = '') {
  const el = document.createElement('div')
  el.className = 'toast ' + type
  el.textContent = msg
  $('#toast-root').appendChild(el)
  setTimeout(() => el.remove(), 4200)
}

function esc (s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function fmtTime (iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fmtBytes (b) {
  if (!b) return '—'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = b
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + u[i]
}

function fmtUptime (s) {
  if (!s && s !== 0) return '—'
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60); const sec = Math.floor(s % 60)
  let out = ''
  if (d) out += d + 'd '; if (h) out += h + 'h '; if (m) out += m + 'm '
  return out + sec + 's'
}

/* ── build info / version marker ── */

async function loadBuildInfo () {
  try {
    const b = await api('/build')
    const build = b.build || '—'
    $('#brand-version').textContent = 'v1.0.0'
    $('#build-badge').textContent = 'build: ' + build
    $('#build-badge').title = 'Deployed build (commit): ' + build
    $('#about-build').textContent = build
  } catch { /* silent */ }
}

/* ── views ── */

function showLogin () {
  $('#login-view').classList.remove('hidden')
  $('#app').classList.add('hidden')
}

function showApp () {
  $('#login-view').classList.add('hidden')
  $('#app').classList.remove('hidden')
}

function switchView (name) {
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name))
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name))
  if (name === 'history') loadHistory()
  if (name === 'overview') loadStats()
}

/* ── auth ── */

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = $('#login-error')
  err.textContent = ''
  try {
    const data = await api('/auth/login', {
      method: 'POST',
      body: { username: $('#login-user').value, password: $('#login-pass').value }
    })
    token = data.token
    localStorage.setItem('wa_bot_token', token)
    showApp()
    boot()
  } catch (ex) {
    err.textContent = ex.message
  }
})

$('#logout-btn').addEventListener('click', () => {
  token = ''
  localStorage.removeItem('wa_bot_token')
  if (socket) socket.close()
  showLogin()
})

/* ── connection rendering ── */

function renderSession (s) {
  if (!s) return
  const states = {
    connected: ['Connected', 'ok'],
    connecting: ['Connecting…', 'warn'],
    reconnecting: ['Reconnecting…', 'warn'],
    qr: ['Waiting for QR scan', 'warn'],
    pairing: ['Pairing…', 'warn'],
    disconnected: ['Disconnected', 'bad'],
    idle: ['Not started', 'bad'],
    closed: ['Closed', 'bad']
  }
  const [label, tone] = states[s.state] || [s.state, 'bad']
  const pill = $('#conn-pill')
  pill.className = 'conn-pill ' + (tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'bad')
  $('#conn-pill-text').textContent = label + (s.phone ? ' · ' + s.phone : '')

  const ov = $('#overview-conn')
  ov.querySelector('.conn-status').innerHTML =
    `<span class="dot dot-lg ${tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'bad'}"></span><span>${label}</span>`
  ov.querySelector('#ov-state').textContent = s.state
  ov.querySelector('#ov-phone').textContent = s.phone || '—'
  ov.querySelector('#ov-uptime').textContent = fmtUptime(s.uptimeSec)
  ov.querySelector('#ov-version').textContent = s.version ? s.version.join('.') : '—'

  // pairing view: QR area
  if (s.state === 'qr' && s.qr) {
    $('#qr-img').src = s.qr
    $('#qr-img').classList.remove('hidden')
    $('#qr-placeholder').classList.add('hidden')
  } else if (s.state !== 'qr') {
    $('#qr-img').classList.add('hidden')
    $('#qr-placeholder').classList.remove('hidden')
    $('#qr-placeholder').textContent = s.state === 'connected'
      ? 'Already connected ✅'
      : 'No QR yet — start the connection'
  }
}

/* ── stats ── */

async function loadStats () {
  try {
    const st = await api('/stats')
    $('#stat-downloads').textContent = st.downloads
    $('#stat-videos').textContent = st.videos
    $('#stat-songs').textContent = st.songs
    $('#stat-completed').textContent = st.completed
    $('#stat-pending').textContent = st.pending
    $('#stat-failed').textContent = st.failed
  } catch { /* silent */ }
}

/* ── pairing actions ── */

$('#btn-start-qr').addEventListener('click', async () => {
  const btn = $('#btn-start-qr')
  btn.disabled = true
  try {
    const s = await api('/session')
    if (s.state === 'connected') { toast('Already connected ✅', 'ok'); return }
    // ensure socket is running (auto-starts on boot, but be safe)
    await api('/session/reconnect', { method: 'POST' })
    toast('Waiting for QR… Scan it in WhatsApp → Linked Devices')
    setTimeout(() => { $('#btn-start-qr').disabled = false }, 2500)
  } catch (ex) { toast(ex.message, 'error'); btn.disabled = false }
})

$('#btn-pair').addEventListener('click', async () => {
  const phone = $('#pair-phone').value.replace(/\D/g, '')
  if (phone.length < 8) { toast('Enter a valid number with country code (E.164)', 'warn'); return }
  const btn = $('#btn-pair')
  btn.disabled = true
  btn.textContent = 'Getting code…'
  try {
    const data = await api('/session/pair', { method: 'POST', body: { phone } })
    $('#pair-code-text').textContent = data.pairingCode
    $('#pair-phone-shown').textContent = data.phone || phone
    $('#pair-result').classList.remove('hidden')
    toast('Pairing code ready — enter it on your phone within ~60s')
  } catch (ex) { toast(ex.message, 'error') }
  btn.disabled = false
  btn.textContent = 'Get code'
})

$('#btn-reconnect').addEventListener('click', async () => {
  try { await api('/session/reconnect', { method: 'POST' }); toast('Reconnecting…') }
  catch (ex) { toast(ex.message, 'error') }
})
$('#btn-disconnect').addEventListener('click', async () => {
  try { await api('/session/disconnect', { method: 'POST' }); toast('Disconnected (session kept)') }
  catch (ex) { toast(ex.message, 'error') }
})
$('#btn-logout').addEventListener('click', async () => {
  if (!confirm('Logout wipes the saved WhatsApp session. You must pair again. Continue?')) return
  try { await api('/session/logout', { method: 'POST' }); toast('Logged out — session wiped') }
  catch (ex) { toast(ex.message, 'error') }
})

/* ── live feed ── */

function addFeed (level, msg, at) {
  if (feedPaused) return
  const feed = $('#feed')
  const item = document.createElement('div')
  item.className = 'feed-item feed-msg ' + level
  const time = at ? new Date(at).toLocaleTimeString() : new Date().toLocaleTimeString()
  item.innerHTML = `<span class="feed-time">${time}</span><span class="feed-text">${esc(msg)}</span>`
  feed.appendChild(item)
  while (feed.children.length > 400) feed.removeChild(feed.firstChild)
  if ($('#feed-autoscroll').checked) feed.scrollTop = feed.scrollHeight
}

$('#feed-clear').addEventListener('click', () => { $('#feed').innerHTML = '' })
$('#feed-autoscroll').addEventListener('change', (e) => {
  feedPaused = !e.target.checked
  if (e.target.checked) { const f = $('#feed'); f.scrollTop = f.scrollHeight }
})

/* ── history ── */

const STATUS_ICON = { completed: '✅', failed: '❌', downloading: '⏳', queued: '⏸', sending: '📤', searching: '🔍' }

async function loadHistory () {
  const type = $('#hist-type').value
  const status = $('#hist-status').value
  const qs = new URLSearchParams({ limit: '100' })
  if (type) qs.set('type', type)
  if (status) qs.set('status', status)
  try {
    const data = await api('/history?' + qs.toString())
    const body = $('#hist-body')
    $('#hist-count').textContent = data.total + ' records'
    if (!data.items.length) {
      body.innerHTML = '<tr><td colspan="7" class="muted center">No downloads yet. Send a command to the bot on WhatsApp!</td></tr>'
      return
    }
    body.innerHTML = data.items.map((d) => `
      <tr>
        <td class="muted small">${fmtTime(d.created_at)}</td>
        <td>${d.type === 'video' ? '🎬' : '🎵'} ${d.type}</td>
        <td>
          <div><b>${esc(d.title || d.query || d.url || '—')}</b></div>
          ${d.url ? `<div class="muted small">${esc(d.url.slice(0, 60))}</div>` : ''}
        </td>
        <td>${esc(d.quality || '—')}</td>
        <td>
          <div class="progress-wrap"><div class="progress-fill" style="width:${Math.round(d.progress || 0)}%"></div></div>
          <span class="muted small">${Math.round(d.progress || 0)}%</span>
        </td>
        <td><span class="badge ${esc(d.status)}">${STATUS_ICON[d.status] || ''} ${esc(d.status)}</span></td>
        <td class="err-cell">${d.error ? esc(d.error) : ''}</td>
      </tr>`).join('')
  } catch (ex) {
    $('#hist-body').innerHTML = `<tr><td colspan="7" class="muted center">${esc(ex.message)}</td></tr>`
  }
}

$('#hist-type').addEventListener('change', loadHistory)
$('#hist-status').addEventListener('change', loadHistory)
$('#hist-refresh').addEventListener('click', loadHistory)

/* ── webhook settings ── */

async function loadWebhook () {
  try {
    const cfg = await api('/webhook')
    $('#wh-url').value = cfg.url || ''
    $('#wh-secret').value = cfg.secret === '********' ? '' : (cfg.secret || '')
    $('#wh-events').value = (cfg.events || []).join(',')
    $('#wh-enabled').checked = !!cfg.enabled
  } catch { /* silent */ }
}

$('#webhook-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const toastEl = $('#wh-toast')
  try {
    const cfg = {
      url: $('#wh-url').value.trim(),
      secret: $('#wh-secret').value.trim(),
      enabled: $('#wh-enabled').checked,
      events: $('#wh-events').value.split(',').map((s) => s.trim()).filter(Boolean)
    }
    await api('/webhook', { method: 'POST', body: cfg })
    toastEl.textContent = '✅ Saved'
    setTimeout(() => { toastEl.textContent = '' }, 2500)
  } catch (ex) { toast(ex.message, 'error') }
})

/* ── socket.io realtime ── */

function bootSocket () {
  if (socket) socket.close()
  // guard: socket.io client script should now be loaded via /socket.io/socket.io.js
  if (typeof io === 'undefined') {
    addFeed('warn', 'Realtime socket not available — using polling fallback')
  } else {
    socket = io({ auth: { token } })
    socket.on('connect', () => {
      addFeed('success', 'Realtime channel connected')
      socket.emit('ping', (p) => { if (p !== 'pong') addFeed('warn', 'Unexpected ping reply: ' + p) })
    })
    socket.on('disconnect', () => addFeed('warn', 'Realtime channel disconnected — retrying…'))
    socket.on('session', (s) => renderSession(s))
    socket.on('session.qr', (p) => {
      $('#qr-img').src = p.qr
      $('#qr-img').classList.remove('hidden')
      $('#qr-placeholder').classList.add('hidden')
    })
    socket.on('session.connected', (p) => {
      toast('WhatsApp connected ✅', 'ok')
      addFeed('success', 'WhatsApp connected' + (p.phone ? ' as ' + p.phone : ''))
      loadStats()
    })
    socket.on('session.pairingCode', (p) => {
      $('#pair-code-text').textContent = p.code
      $('#pair-result').classList.remove('hidden')
    })
    socket.on('log', (p) => addFeed(p.level || 'info', p.msg, p.at))
    socket.on('logs', (items) => {
      $('#feed').innerHTML = ''
      ;(items || []).forEach((l) => addFeed(l.level || 'info', l.msg, l.at))
    })
    socket.on('download.progress', (p) => {
      addFeed('info', `Download ${p.id.slice(0, 8)}… ${Math.round(p.percent)}% (${fmtBytes(p.bytes)})`)
      if (p.percent >= 100) loadStats()
    })
    socket.on('download.completed', (p) => {
      loadStats()
      if (document.querySelector('.nav-item.active')?.dataset.view === 'history') loadHistory()
    })
    socket.on('download.failed', () => { loadStats() })
  }
  // Polling fallback — keeps the QR + pairing code LIVE even if the
  // socket channel is down or the connection state changes. Baileys QR
  // codes rotate/expire, so a stale QR can never be scanned.
  if (qrPollTimer) clearInterval(qrPollTimer)
  qrPollTimer = setInterval(async () => {
    try {
      const s = await api('/session')
      renderSession(s)
    } catch { /* auth handled by api() */ }
  }, 5000)
}
let qrPollTimer = null

/* ── boot ── */

async function boot () {
  if (socket) { socket.close(); socket = null }
  try {
    const s = await api('/session')
    renderSession(s)
  } catch { return }
  try {
    const health = await api('/health')
    $('#about-db').textContent = health.db
    $('#about-node').textContent = health.node
    setInterval(() => {
      $('#about-uptime').textContent = fmtUptime(health.uptime + (Date.now() - bootTs) / 1000)
    }, 1000)
  } catch { /* silent */ }
  loadBuildInfo()
  loadStats()
  loadWebhook()
  bootSocket()
}
const bootTs = Date.now()

/* ── nav + init ── */

$$('.nav-item').forEach((n) => n.addEventListener('click', (e) => { e.preventDefault(); switchView(n.dataset.view) }))
$$('[data-goto]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); switchView(a.dataset.goto) }))

if (token) {
  api('/session').then(() => { showApp(); boot() }).catch(() => showLogin())
} else {
  showLogin()
}