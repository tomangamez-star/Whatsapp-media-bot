#!/usr/bin/env bash
# Stamp the deployed commit hash into .build-info so the dashboard can show a
# version marker. Runs as the FIRST step of the Render buildCommand.
set -euo pipefail
cd "$(dirname "$0")/.."

SHA=""
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  SHA="$(git rev-parse --short HEAD 2>/dev/null || true)"
fi
if [ -z "$SHA" ]; then
  # No git metadata on Render builds — fall back to a timestamp.
  SHA="no-git-$(date -u +%Y%m%d%H%M%S)"
fi
echo "$SHA" > .build-info
echo "build-info: $SHA"
