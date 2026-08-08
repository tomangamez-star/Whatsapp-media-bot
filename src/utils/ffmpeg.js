'use strict'

/**
 * ffmpeg binary resolver.
 *
 * Priority:
 *   1. FFMPEG_PATH env var  (explicit override, e.g. Render env)
 *   2. ffmpeg-static package (bundled static binary — works on Render/Railway
 *      build sandboxes with no system install, no apt-get, no root)
 *   3. `ffmpeg` on PATH      (system install, e.g. Docker image)
 *
 * Returns the binary path as a string, or null if none is resolvable.
 */

function resolveFfmpeg () {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH

  try {
    // ffmpeg-static exports the path to its bundled binary on require
    const staticPath = require('ffmpeg-static')
    if (staticPath && staticPath.length) return staticPath
  } catch (err) {
    // package not installed — fall through
  }

  return 'ffmpeg' // rely on PATH
}

module.exports = { resolveFfmpeg }
