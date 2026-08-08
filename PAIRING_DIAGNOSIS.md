# Pairing Diagnosis — "code generates but WhatsApp won't link"

**Date:** 2026-08-08 · **Deployed commit:** `db85791` → this fix on `main`
**Live evidence:** `GET /api/health` on Render reported:
`lastDisconnect: { code: 401, reason: "loggedOut", detail: "Connection Failure" }`

---

## Root cause (settled)

The pairing code is **real and generated correctly** — the problem is that
**WhatsApp's servers reject the registration handshake from the Render
datacenter IP**, compounded by rate-limiting from repeated attempts.

Concretely:

1. **`401 "Connection Failure"` is NOT a logout.** Baileys' `CB:failure`
   handler wraps the raw HTTP status from WhatsApp into a Boom error
   (`socket.js`: `end(new Boom('Connection Failure', { statusCode: reason }))`).
   A 401 here means WhatsApp **rejected the device-registration handshake**.
   The enum name `DisconnectReason[401] = "loggedOut"` is misleading for this
   path — the previous code surfaced `reason: "loggedOut"`, which pointed at
   the wrong culprit (logout / bad session) and masked the real one.
2. **Datacenter IP blocks + 429 rate-overlimit.** This is a well-documented
   Baileys production pattern (WhiskeySockets/Baileys #2381, #2248, #2008,
   #1761): pairing works from a residential network, but WhatsApp throttles or
   rejects pairing from cloud/datacenter IPs — especially after several quick
   attempts. The 429 `rate-overlimit` persists **~15–40 minutes** and each
   retry extends the block. That is exactly the observed symptom: code appears,
   phone shows nothing / "couldn't connect", retries make it worse.
3. **No code bug in the pairing flow itself.** QR and pairing code are genuine
   Baileys outputs; phone normalization (E.164) is correct
   (`07074455500` → `2347074455500`); the WA Web version is pinned to the
   known-good `2.3000.1043857760`.

## What this fix changes (commit on `main`)

- **`src/bot/connection.js`**
  - Correctly relabels stream-failure disconnects: `401` + `detail "Connection
    Failure"` is now shown as **`rate-limited (WA rejected pairing — wait
    15–40 min, then retry once)`** instead of the misleading `loggedOut`.
  - A 429/401 stream rejection now backs off **60s → up to 5 min** instead of
    hammering WhatsApp every 2s (which extended the block).
  - Genuine logout (via `creds.update`) still wipes the session and stops;
    stream 401s never wipe.
  - Optional outbound **proxy agent** for the WhatsApp WebSocket (`agent`
    option): set `PROXY_URL` (e.g. `socks5h://user:pass@host:1080`) to route
    pairing through a residential/mobile IP when Render's IP is blocked.
- **`src/config.js`** — new `session.proxyUrl` (`PROXY_URL`) + lazy
  `proxyAgent` (https-proxy-agent / socks-proxy-agent; app still boots if the
  packages are absent).
- **`src/api/index.js`** — **anti-429 pairing guard**: cooldown between pairing
  attempts (default 60s), max 3 attempts/hour, explicit HTTP 429 responses
  with "wait N" messaging; Baileys 429/401 errors are mapped to real status
  codes instead of generic 500s. Tunable via `PAIR_COOLDOWN_MS`,
  `PAIR_MAX_ATTEMPTS`, `PAIR_WINDOW_MS`.
- **`dashboard/`** — shows the rate-limit cooldown warning and the corrected
  "Last disconnect" verdict prominently before/after pairing attempts.

## Your next steps

1. **Redeploy** the latest `main` commit on Render (Manual Deploy → Deploy
   latest commit). Verify the new build badge appears.
2. **Wait 30–60 minutes** before the next pairing attempt (the number/IP is
   likely still inside WhatsApp's 15–40 min rate-limit window). The dashboard
   now shows the cooldown countdown and will block rapid retries.
3. **Try pairing exactly once** after the wait, using `2347074455500`.
   - If it still fails, set **`PROXY_URL`** in Render's env to a
     residential/mobile proxy (SOCKS5 preferred) and redeploy — this moves the
     connection off Render's datacenter IP, which is the likely blocker.
4. **Use a dedicated number** for the bot (WhatsApp can ban numbers using
   unofficial clients) and prefer the **Starter plan** ($7/mo) so the session
   isn't wiped by the free tier's ephemeral filesystem — a wiped session forces
   a re-pair, and re-pairing repeatedly is what triggers the block.

## References

- WhiskeySockets/Baileys #2008 — pairing code generated, then 429 rate-overlimit
- WhiskeySockets/Baileys #2381 — QR scans, then 401 "Unable to link device" (IP-based rejection)
- WhiskeySockets/Baileys #2248 — 401 after successful pairing on production/VPS
- WhiskeySockets/Baileys #1761 — pairing code rejected when entered
