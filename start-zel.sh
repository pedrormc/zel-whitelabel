#!/bin/bash
# Start Zel — Claude Code with WhatsApp MCP reply tool
#
# Architecture:
#   webhook-server.ts (separate PM2 process) → FIFO → Claude stdin (stream-json)
#   Claude → whatsapp-mcp.ts (MCP reply tool) → Evolution API → WhatsApp
#
# Usage:
#   pm2 start ecosystem.config.cjs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

export PATH="$HOME/.bun/bin:$PATH"

VAULT_PATH="${VAULT_PATH:-/home/USER/vault}"
ZEL_HOME="${ZEL_HOME:-/home/USER/zel}"

if [ ! -d "$VAULT_PATH" ]; then
  echo "[zel] ERROR: Vault not found at $VAULT_PATH"
  exit 1
fi

if ! command -v bun &>/dev/null; then
  echo "[zel] ERROR: bun not found"
  exit 1
fi

if [ ! -d "$ZEL_HOME/node_modules/@modelcontextprotocol" ]; then
  echo "[zel] Installing dependencies..."
  cd "$ZEL_HOME" && bun install --no-summary
fi

echo "[zel] Starting Claude Code with WhatsApp MCP..."
echo "[zel] Working dir: $VAULT_PATH"

# FIFO keeps stdin open so Claude stays alive
FIFO="$ZEL_HOME/zel-stdin.fifo"
[ -p "$FIFO" ] || mkfifo "$FIFO"

export CLAUDE_PERSONA=zel
cd "$VAULT_PATH"

# Open FIFO for read+write (prevents blocking on open)
exec 3<>"$FIFO"

# Send initial prompt
echo '{"type":"user","message":{"role":"user","content":"[Sistema] Zel v2 iniciado. Voce e o Zel, assistente pessoal do dono no WhatsApp. Mensagens chegam como <channel source=\"whatsapp\" ...>. Responda SEMPRE via tool reply com o chat_id. Aguarde mensagens."}}' >&3

exec claude \
  -p \
  --model opus \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --add-dir "$ZEL_HOME" \
  --mcp-config "$ZEL_HOME/.mcp.json" \
  --permission-mode bypassPermissions \
  <&3
