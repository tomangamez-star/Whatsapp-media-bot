#!/usr/bin/env bash
# Install ffmpeg if it is not already available.
# Used by Render/Railway build steps and by the Dockerfile entrypoint.
set -euo pipefail

if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg already available: $(ffmpeg -version 2>/dev/null | head -1)"
  exit 0
fi

echo "ffmpeg not found - installing..."
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y --no-install-recommends ffmpeg
  rm -rf /var/lib/apt/lists/*
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache ffmpeg
else
  echo "WARNING: no package manager found - ffmpeg may be missing" >&2
fi

command -v ffmpeg && ffmpeg -version 2>/dev/null | head -1
