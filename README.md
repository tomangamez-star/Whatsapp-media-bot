# 🤖 WhatsApp Media Bot — Downloader + Management Dashboard

A full-stack **WhatsApp media downloader bot** powered by [Baileys](https://github.com/WhiskeySockets/Baileys) (latest) and [yt-dlp](https://github.com/yt-dlp/yt-dlp), paired with a real-time **web management dashboard** for pairing, monitoring, history and webhooks.

Everything runs in one Node.js process and stays online 24/7 (Docker / PM2 configs included).

---

## ✨ Features

### WhatsApp bot (works entirely inside WhatsApp)
| Command | What it does |
|---|---|
| `.movie spiderman` | Searches the web and downloads the best matching movie/video |
| `.video cats funny` | Searches and downloads any video (YouTube, Instagram, TikTok, Vimeo, Dailymotion, etc.) |
| `.yt <link>` | Downloads directly from a YouTube / Instagram / TikTok / any-yt-dlp-supported link |
| `.song imagine dragons` | Searches and downloads the song (audio) |
| `.mp3 <query or link>` | Song search **or** audio extraction from a direct link |
| `.quality 720p` | Sets **your** default quality: `240p · 360p · 480p · 720p · HD · 4K · 8K · auto` |
| `.ping` / `.help` | Health check / command reference |

- **Quality ladder** — 240p → 8K where the source allows (yt-dlp format selection, never upscales).
- **Per-user quality memory** — after a download, just reply `4k` / `720p` to re-download it at that quality.
- **Progress updates** sent back into the chat while downloading.
- **Smart delivery** — videos ≤15 MB go as native video messages; anything larger (or audio) is delivered as a document so nothing gets blocked by WhatsApp limits.
- **Concurrency-safe** — downloads are queued (configurable, default 2 at a time).

### Management dashboard (`http://<host>:3000`)
- 🔐 **Login** (default `admin` / `wa-bot-admin` — change in `.env`)
- 🔗 **Pairing** — connect via **QR code** or **pairing code**, with session controls (reconnect / disconnect / logout)
- ⚡ **Live activity feed** — every incoming command and bot response in real time (Socket.IO)
- 🕘 **Download history** — every request with type, query, quality, progress %, status and error
- 📊 **Overview** — connection health, uptime, Baileys version, download stats
- ⚙️ **Webhooks** — configure URL, HMAC secret and event list from the UI
- 💾 **Persistence** — SQLite (better-sqlite3) with automatic JSON fallback; session survives restarts

### Reliability
- Auto-reconnect with exponential backoff on connection drops
- 24/7 keep-alive (self-ping health endpoint)
- Automatic media-file cleanup (default: files older than 2 h)
- Health endpoint for Docker / uptime monitors

---

## 🚀 Quick start (local)

**Requirements:** Node.js ≥ 18. On Render/Railway no system ffmpeg is needed — a static `ffmpeg-static` binary is bundled and passed to yt-dlp automatically (`--ffmpeg-location`). For local dev, ffmpeg on PATH is used as a fallback.

```bash
# 1. install
npm install

# 2. configure (optional — defaults work)
cp .env.example .env
#   edit ADMIN_USERNAME / ADMIN_PASSWORD at minimum!

# 3. run
npm start
```

Open **http://localhost:3000**, sign in, and on the **Pairing** page either:
- click **Generate QR** and scan it in WhatsApp → *Linked Devices → Link a device* **within ~20 s** of it appearing (the QR rotates automatically; the dashboard refreshes it every 5 s), or
- enter your phone number and click **Get code**, then use the code via *Link with phone number instead*.

**Phone number format for the pairing code:** the number must be sent to WhatsApp as **E.164 without `+` and without leading zeros** — e.g. for a Nigerian number `+234 707 445 5500` the input is `2347074455500`. The dashboard accepts any of `2347074455500`, `+2347074455500`, `002347074455500`, or national format `07074455500` (the last one resolves via the `DEFAULT_COUNTRY_CODE` env var — set it, e.g. `234` for Nigeria, or full E.164 inputs will still work).

Once connected, message your bot number any command from the table above. 🎉

> ⚠️ **Keep the QR flow on the dashboard** — the bot intentionally does *not* print the QR to the terminal; it's shown in the UI only. If you prefer terminal QR, set `BOT_NAME` and use `printQRInTerminal` (see `src/bot/connection.js`).

---

## 🐳 Deploy 24/7 (Docker)

```bash
docker compose up -d --build
```

- `restart: unless-stopped` → restarts on crash **and** host reboot.
- Named volume keeps your WhatsApp session + database.
- Healthcheck hits `/api/health` every 60 s.

## ⚡ Deploy 24/7 (PM2)

```bash
npm i -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # survive reboots
```

`ecosystem.config.js` includes autorestart, restart delays, memory cap and log files.

## 🌐 Live deployment (running now)

A live instance is running in this environment and reachable right now — the URL is delivered fresh with each run (a Cloudflare Quick Tunnel). Ask the assistant for the current URL, or check the latest run output.

- **Login:** `admin` / `wa-bot-admin` (change via `ADMIN_PASSWORD` / `ADMIN_TOKEN`)
- **Health:** `<current-url>/api/health`

> ⚠️ **Honest note on persistence:** this instance runs on a Cloudflare *Quick* Tunnel from a sandbox host. It stays up while that host runs, but the URL is **ephemeral** — it changes whenever the tunnel is re-created, and the sandbox is not a permanent 24/7 host. Use it to try the dashboard and pair your WhatsApp today. For a **permanent, always-on URL** use the one-click deploy below (2 minutes) or run the Docker/PM2 setups on any VPS.

## ☁️ One-click deploy (permanent URL — recommended)

The repo ships with **`render.yaml`** (Render Blueprint) and **`railway.json`** (Railway).

### Deploy to Render (button)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/tomangamez-star/Whatsapp-media-bot)

Replace `<your-username>` with your GitHub username after you push (below). The button auto-detects `render.yaml`, sets the env vars, runs the build (npm ci — ffmpeg is bundled via `ffmpeg-static`, no system install), and asks you for the admin password.

> **Note:** `render.yaml` deliberately does **not** set `PORT` — Render injects its own `PORT` and the app binds to it (config default is 3000 when unset). Overriding `PORT` on Render breaks routing/health checks.

### 1. Create the GitHub repo & push (2 commands, once)

```bash
# from inside this project folder (a git repo is already initialized):
git add -A
git commit -m "WhatsApp media bot + dashboard (production-ready)"
git branch -M main

# create an EMPTY repo on github.com (no README), then:
git remote add origin https://github.com/<your-username>/whatsapp-media-bot.git
git push -u origin main
```

Or, with the GitHub CLI: `gh repo create whatsapp-media-bot --public --source . --push`

### 2. Deploy

- **Render** → https://render.com → *New → Blueprint* → paste your repo → it auto-detects `render.yaml` and asks for the admin password. Free tier included (sleeps on idle; `Starter` = always-on).
- **Railway** → https://railway.com → *New Project → Deploy from GitHub* → it auto-detects `railway.json` (or pick the Dockerfile).

### 3. After deploy

3. Set `ADMIN_PASSWORD` (and keep the generated `ADMIN_TOKEN`) in the service's environment variables.
4. Open the service URL → pair your WhatsApp on the **Pairing** page → done.

## ⚡ Free-tier / always-on hosting (Render, Railway, Fly.io, Koyeb…)

1. Deploy this repo (build: `npm install`, start: `npm start`).
2. Point a healthcheck/uptime monitor at `/api/health` (Render's built-in healthcheck works).
3. Optionally enable the **webhook** in dashboard Settings and point it at a service that pings you (or use it for your own automation) — it doubles as a keep-alive signal.

> **Important for free hosts:** the *Node process* must stay awake. Most free tiers sleep on idle — use their paid/always-on plan or a cron-ping service so the WhatsApp connection doesn't drop.

---

## 🔔 Webhooks

The bot POSTs JSON events to your configured URL:

```
POST https://your-endpoint/hooks/whatsapp-bot
X-WaBot-Signature: <hmac-sha256 hex of raw body with your secret>
Content-Type: application/json

{
  "event": "download.completed",
  "at": "2026-08-08T17:00:00.000Z",
  "data": { "downloadId": "..." }
}
```

**Events:** `command` · `download.started` · `download.progress` · `download.completed` · `download.failed` · `session.connected` · `session.disconnected` · `bot.ready`

Verify signatures in your receiver:

```js
const crypto = require('crypto')
const expected = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET)
  .update(rawBody).digest('hex')
if (expected !== req.headers['x-wabot-signature']) return res.status(401).end()
```

## 🔌 API (all except `/api/health` need `x-access-token` header)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | `{username, password}` → `{token}` |
| GET | `/api/session` | connection status (state, phone, uptime, qr…) |
| POST | `/api/session/pair` | `{phone}` → pairing code |
| POST | `/api/session/reconnect` · `/disconnect` · `/logout` | session controls |
| GET | `/api/history?type=&status=&limit=` | download history |
| GET | `/api/stats` | counters (videos, songs, completed…) |
| GET | `/api/logs` | recent log ring |
| GET/POST | `/api/webhook` | webhook config |
| GET | `/api/health` | health probe (no auth) |

---

## 📁 Project structure

```
whatsapp-media-bot/
├── src/
│   ├── server.js              # boot: HTTP + Socket.IO + keep-alive + cleanup
│   ├── config.js              # env config
│   ├── db.js                  # SQLite (better-sqlite3) + JSON fallback
│   ├── events.js              # typed event bus
│   ├── logger.js              # pino logger
│   ├── api/index.js           # Express API routes + auth
│   ├── bot/
│   │   ├── connection.js      # Baileys socket, QR/pairing, reconnect
│   │   └── commands.js        # .movie/.video/.yt/.song/.mp3/.quality/…
│   ├── services/
│   │   ├── downloader.js      # yt-dlp search + quality ladder + progress
│   │   ├── sender.js          # WhatsApp media delivery
│   │   └── webhooks.js        # outbound webhook dispatcher (HMAC)
│   └── utils/                 # format helpers, concurrency queue
├── dashboard/                 # static frontend (index.html, styles.css, app.js)
├── Dockerfile · docker-compose.yml
├── ecosystem.config.js        # PM2
└── .env.example
```

## ⚙️ Environment variables

| Var | Default | Description |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | server bind |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `wa-bot-admin` | dashboard login |
| `ADMIN_TOKEN` | — | optional static API token |
| `ALLOWED_CHATS` | *(empty = allow all)* | comma-separated phone numbers only the bot answers to |
| `MAX_CONCURRENT_DOWNLOADS` | `2` | parallel yt-dlp jobs |
| `DEFAULT_QUALITY` | `720` | `240·360·480·720·1080·2160·4320·auto` |
| `MAX_FILE_SIZE_MB` | `1900` | per-file cap |
| `CLEANUP_AFTER_MINUTES` | `120` | media retention (`0` = keep) |
| `FORCE_LOGOUT` | `0` | wipe session on boot |
| `WEBHOOK_URL` / `WEBHOOK_SECRET` / `WEBHOOK_ENABLED` / `WEBHOOK_EVENTS` | — | webhook defaults |
| `DEFAULT_COUNTRY_CODE` | — | country code for national-format pairing numbers (e.g. `234` for Nigeria) |
| `BAILEYS_WA_VERSION` | `2.3000.1043857760` | WhatsApp Web version advertised by Baileys; override only if WhatsApp rejects the default |
| `KEEPALIVE_INTERVAL_SEC` | `300` | self-ping interval (`0` = off) |

---

## ⚠️ Legal & fair-use notice

Downloading copyrighted media without permission may violate terms of service and/or law in your jurisdiction. **Use this bot only for content you own or have rights to** (public-domain, Creative Commons, your own uploads). The project is provided for educational purposes; the author is not responsible for misuse. WhatsApp may ban numbers that use unofficial clients — use a dedicated number and keep usage reasonable.

---

## 🛠 Troubleshooting

- **Pairing code fails with HTTP 429** — WhatsApp rate-limits pairing requests; wait 15–40 min and retry.
- **Pairing/QR shows `401 Connection Failure`** — WhatsApp rejected the connection after too many attempts (rate-limit / bad session); wait 15–40 min or use another number. The dashboard now shows the exact statusCode under "Last disconnect".
- **QR/pairing code "doesn't work"** — the code expires fast: the QR rotates every ~20 s (dashboard polls every 5 s) and the pairing code is valid for a short window. Scan/enter the **current** one. Also make sure the phone number uses the correct E.164 format (see above).
- **`better-sqlite3` fails to build** — the bot auto-falls back to JSON storage; install build tools (`python3 make g++`) to get SQLite back.
- **Downloads fail with "ffmpeg not found"** — the app bundles a static binary via `ffmpeg-static` (used automatically); set `FFMPEG_PATH` to override, or install system ffmpeg (`apt install ffmpeg` / `brew install ffmpeg`). In Docker it is already included.
- **yt-dlp binary not downloading** — the wrapper auto-downloads it on first use; set `yt_dlp_binary_path` or install `yt-dlp` system-wide and it will be used.
- **Video not sending as video message** — WhatsApp caps video messages (~15 MB / 30 s); larger files are sent as documents by design.