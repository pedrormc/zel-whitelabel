#!/bin/bash
# Vault sync — runs every 5min via cron
# Pulls remote changes, pushes local changes, alerts on failure

set -euo pipefail

# Load env for Evolution API credentials
if [ -f "$HOME/zel/.env" ]; then
  export $(grep -v '^#' "$HOME/zel/.env" | xargs)
fi

VAULT_DIR="${VAULT_PATH:-$HOME/obsidiano}"
OWNER_WHATSAPP_NUMBER="${OWNER_WHATSAPP_NUMBER:-556199272347}"

alert() {
  local msg="$1"
  curl -s -X POST "${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}" \
    -H "apikey: ${EVOLUTION_APIKEY}" \
    -H "Content-Type: application/json" \
    -d "{\"number\":\"${OWNER_WHATSAPP_NUMBER}@s.whatsapp.net\",\"text\":\"${msg}\"}" \
    >/dev/null 2>&1 || true
}

cd "$VAULT_DIR" || { alert "Zel: vault dir nao encontrado"; exit 1; }

# Pull with stash
git stash --quiet 2>/dev/null || true

if ! git pull --rebase origin main 2>&1; then
  alert "Zel: git pull falhou, verificar vault"
  git stash pop --quiet 2>/dev/null || true
  exit 1
fi

git stash pop --quiet 2>/dev/null || true

# Push local changes
git add -A
if ! git diff --cached --quiet; then
  git commit -m "zel: auto-sync" --quiet
  if ! git push 2>&1; then
    alert "Zel: git push falhou, verificar vault"
    exit 1
  fi
fi
