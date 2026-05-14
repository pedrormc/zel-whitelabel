/**
 * PM2 ecosystem config for Zel v2.
 *
 * Processes:
 *   zel-claude    — Claude Code session (reads from FIFO, uses whatsapp-mcp for reply)
 *   zel-webhook   — Bun HTTP server (receives Evolution webhooks, writes to FIFO)
 *   zel-reminders — Reminder checker (every 60s)
 */

module.exports = {
  apps: [
    {
      name: 'zel-claude',
      script: './start-zel.sh',
      cwd: '/home/USER/zel',
      interpreter: 'bash',
      restart_delay: 5000,
      max_restarts: 50,
      autorestart: true,
      error_file: '/home/USER/zel/logs/claude-error.log',
      out_file: '/home/USER/zel/logs/claude-out.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'zel-webhook',
      script: './webhook-server.ts',
      cwd: '/home/USER/zel',
      interpreter: '/home/USER/.bun/bin/bun',
      restart_delay: 3000,
      max_restarts: 50,
      autorestart: true,
      error_file: '/home/USER/zel/logs/webhook-error.log',
      out_file: '/home/USER/zel/logs/webhook-out.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'zel-reminders',
      script: 'reminder-checker.js',
      cwd: '/home/USER/zel',
      interpreter: 'node',
      restart_delay: 3000,
      max_restarts: 20,
      autorestart: true,
      error_file: '/home/USER/zel/logs/reminders-error.log',
      out_file: '/home/USER/zel/logs/reminders-out.log',
      merge_logs: true,
    },
  ],
};
