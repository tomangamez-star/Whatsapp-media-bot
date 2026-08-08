#!/usr/bin/env bash
# Install ffmpeg if it is not already available.
# Used by Render/Railway build steps and by the Dockerfile entrypoint.
# Render's build sandbox is non-root: bare apt-get fails, so try sudo first,
# fall back to plain apt-get (root containers), then apk (Alpine/Docker).
set -euo pipefail

if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg already available: $(ffmpeg -version 2>/dev/null | head -1)"
  exit 0
fi

echo "ffmpeg not found - installing..."

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
  echo "[ffmpeg] using apt-get..."
  if ! run_as_root apt-get update -y; then
    echo "[ffmpeg] apt-get update failed (non-root?) - retrying as plain apt-get"
    apt-get update -y
  fi
  if ! run_as_root apt-get install -y --no-install-recommends ffmpeg; then
    echo "[ffmpeg] sudo install failed - retrying as plain apt-get"
    apt-get install -y --no-install-recommends ffmpeg
  fi
  rm -rf /var/lib/apt/lists/* 2>/dev/null || true
elif command -v apk >/dev/null 2>&1; then
  echo "[ffmpeg] using apk..."
  apk add --no-cache ffmpeg
else
  echo "WARNING: no package manager found - ffmpeg may be missing" >&2
fi

if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg ready: $(ffmpeg -version 2>/dev/null | head -1)"
else
  echo "ERROR: ffmpeg still not available after install attempt" >&2
  exit 1
fi
