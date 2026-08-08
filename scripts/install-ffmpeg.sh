#!/usr/bin/env bash
# Best-effort system ffmpeg install (Docker / root containers / local dev).
#
# On Render's build sandbox (non-root, no sudo) this script is NON-FATAL:
# the app bundles a static ffmpeg via the `ffmpeg-static` npm package and
# passes it to yt-dlp with --ffmpeg-location, so a system ffmpeg is NOT
# required for the app to run. This script only installs one when it can.
set -uo pipefail

if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg already available: $(ffmpeg -version 2>/dev/null | head -1)"
  exit 0
fi

echo "ffmpeg not found - attempting best-effort install (non-fatal)..."

run_as_root () {
  if [ "$(id -u)" = "0" ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    return 1
  fi
}

if command -v apt-get >/dev/null 2>&1; then
  echo "[ffmpeg] trying apt-get..."
  if run_as_root apt-get update -y 2>/dev/null && run_as_root apt-get install -y --no-install-recommends ffmpeg 2>/dev/null; then
    echo "[ffmpeg] apt-get install succeeded"
  else
    echo "[ffmpeg] apt-get unavailable (non-root sandbox) - continuing without system ffmpeg"
  fi
elif command -v apk >/dev/null 2>&1; then
  echo "[ffmpeg] using apk..."
  apk add --no-cache ffmpeg 2>/dev/null && echo "[ffmpeg] apk install succeeded" || echo "[ffmpeg] apk install failed - continuing"
fi

if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg ready: $(ffmpeg -version 2>/dev/null | head -1)"
else
  echo "NOTE: no system ffmpeg (expected on Render) - the app uses the bundled ffmpeg-static binary instead."
fi
exit 0
