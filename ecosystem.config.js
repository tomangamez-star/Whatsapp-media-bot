/**
 * PM2 ecosystem file — run the bot 24/7 with auto-restart.
 *
 * Usage:
 *   npm i -g pm2
 *   pm2 start ecosystem.config.js
 *   pm2 save && pm2 startup   # survive reboots
 */
module.exports = {
  apps: [
    {
      name: 'wa-media-bot',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1, // single instance — WhatsApp sessions are per-process
      exec_mode: 'fork',
      autorestart: true, // restart on crash
      max_restarts: 20,
      min_uptime: '10s',
      restart_delay: 5000,
      watch: false,
      max_memory_restart: '500M',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      out_file: './data/logs/out.log',
      error_file: './data/logs/error.log',
      merge_logs: true,
      time: true
    }
  ]
}
