# WhatsApp Media Bot — production image
# Includes ffmpeg (audio extraction / video merging) + build tools for better-sqlite3

FROM node:20-bookworm-slim AS base
WORKDIR /app

# System deps: ffmpeg for yt-dlp post-processing, build tools for native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    make \
    g++ \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies (cached layer)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --no-audit --no-fund

# App source
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

# Persistent data (sessions, downloads, db)
VOLUME ["/app/data"]

EXPOSE 3000

# Keep alive: node process stays up; PM2-style restart is handled by Docker restart policy
CMD ["node", "src/server.js"]
