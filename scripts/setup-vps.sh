#!/bin/bash
# ============================================================
# Zel — Full Ecosystem Setup on VPS
# Run this AFTER: claude login (authenticate Claude Code)
# ============================================================

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[zel-setup]${NC} $1"; }
warn() { echo -e "${YELLOW}[zel-setup]${NC} $1"; }
err()  { echo -e "${RED}[zel-setup]${NC} $1"; exit 1; }

# --- Pre-flight checks ---
log "Checking prerequisites..."

command -v node >/dev/null 2>&1 || err "Node.js not found. Install: curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt install -y nodejs"
command -v git >/dev/null 2>&1 || err "git not found. Install: sudo apt install -y git"
command -v claude >/dev/null 2>&1 || err "Claude Code not found. Install: npm install -g @anthropic-ai/claude-code"
command -v pm2 >/dev/null 2>&1 || { log "Installing PM2..."; npm install -g pm2; }
command -v jq >/dev/null 2>&1 || { log "Installing jq..."; sudo apt install -y jq; }

# --- Timezone ---
log "Setting timezone to America/Sao_Paulo..."
sudo timedatectl set-timezone America/Sao_Paulo 2>/dev/null || warn "Could not set timezone (not critical)"

# --- Clone Zel repo ---
if [ ! -d "$HOME/zel" ]; then
  log "Cloning Zel repo..."
  git clone https://github.com/SEU_USER/zel-whitelabel.git "$HOME/zel"
else
  log "Zel repo already exists, pulling latest..."
  cd "$HOME/zel" && git pull
fi

# --- Clone Obsidian vault ---
if [ ! -d "$HOME/obsidiano" ]; then
  log "Cloning Obsidian vault..."
  git clone https://github.com/SEU_USER/seu-vault.git "$HOME/obsidiano"
else
  log "Vault already exists, pulling latest..."
  cd "$HOME/obsidiano" && git pull
fi

# --- Install Zel dependencies ---
log "Installing Zel dependencies..."
cd "$HOME/zel" && npm install

# --- .env setup ---
if [ ! -f "$HOME/zel/.env" ]; then
  log "Creating .env from template..."
  cp "$HOME/zel/.env.example" "$HOME/zel/.env"
  chmod 600 "$HOME/zel/.env"
  warn "EDIT .env with your credentials: nano $HOME/zel/.env"
else
  log ".env already exists."
fi

# --- Create reminders.json ---
if [ ! -f "$HOME/zel/reminders.json" ]; then
  echo "[]" > "$HOME/zel/reminders.json"
fi

# ============================================================
# ECOSYSTEM SETUP — Claude Code agents, skills, rules, MCPs
# ============================================================

log "Setting up Claude Code ecosystem..."

CLAUDE_DIR="$HOME/.claude"
mkdir -p "$CLAUDE_DIR/agents" "$CLAUDE_DIR/skills" "$CLAUDE_DIR/rules/common" "$CLAUDE_DIR/rules/typescript" "$CLAUDE_DIR/scripts"

# --- Install n8n-mcp globally ---
log "Installing n8n-mcp globally..."
npm install -g n8n-mcp 2>/dev/null || warn "n8n-mcp install failed (may need manual install)"

# --- Copy ecosystem configs ---
log "Copying ecosystem configs..."

# MCP servers config
if [ ! -f "$CLAUDE_DIR/mcp.json" ]; then
  cp "$HOME/zel/ecosystem/mcp.json.example" "$CLAUDE_DIR/mcp.json"
  warn "EDIT MCP config with your API keys: nano $CLAUDE_DIR/mcp.json"
else
  log "mcp.json already exists."
fi

# Settings (only if no existing settings)
if [ ! -f "$CLAUDE_DIR/settings.json" ]; then
  cp "$HOME/zel/ecosystem/settings.json.example" "$CLAUDE_DIR/settings.json"
  log "Settings copied. Plugins will auto-install on first run."
else
  log "settings.json already exists — merging plugins..."
  # Ensure plugins are enabled in existing settings
  tmp=$(mktemp)
  jq '.enabledPlugins["everything-claude-code@everything-claude-code"] = true |
      .enabledPlugins["superpowers@superpowers-marketplace"] = true |
      .enabledPlugins["ralph-skills@ralph-marketplace"] = true |
      .enabledPlugins["ui-ux-pro-max@ui-ux-pro-max-skill"] = true' \
    "$CLAUDE_DIR/settings.json" > "$tmp" && mv "$tmp" "$CLAUDE_DIR/settings.json"
fi

# --- Copy agents from ecosystem ---
if [ -d "$HOME/zel/ecosystem/agents" ]; then
  log "Copying agents..."
  cp -r "$HOME/zel/ecosystem/agents/"* "$CLAUDE_DIR/agents/" 2>/dev/null || true
fi

# --- Copy skills from ecosystem ---
if [ -d "$HOME/zel/ecosystem/skills" ]; then
  log "Copying skills..."
  cp -r "$HOME/zel/ecosystem/skills/"* "$CLAUDE_DIR/skills/" 2>/dev/null || true
fi

# --- Copy rules from ecosystem ---
if [ -d "$HOME/zel/ecosystem/rules" ]; then
  log "Copying rules..."
  cp -r "$HOME/zel/ecosystem/rules/"* "$CLAUDE_DIR/rules/" 2>/dev/null || true
fi

# ============================================================
# NGINX SETUP
# ============================================================

log "Checking nginx..."
if command -v nginx >/dev/null 2>&1; then
  NGINX_CONF="/etc/nginx/sites-available/zel"
  if [ ! -f "$NGINX_CONF" ]; then
    log "Creating nginx config..."
    sudo tee "$NGINX_CONF" > /dev/null <<'NGINX'
# Zel webhook — rate limited
limit_req_zone $binary_remote_addr zone=zel:10m rate=10r/m;

server {
    listen 80;
    server_name _;

    location /webhook/zel {
        limit_req zone=zel burst=5 nodelay;
        proxy_pass http://127.0.0.1:3333;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 180s;
    }

    location /health {
        proxy_pass http://127.0.0.1:3333;
        proxy_http_version 1.1;
    }
}
NGINX
    sudo ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/zel 2>/dev/null || true
    sudo nginx -t && sudo systemctl reload nginx
    log "Nginx configured."
  else
    log "Nginx config already exists."
  fi
else
  warn "nginx not found. Install: sudo apt install -y nginx"
fi

# ============================================================
# PM2 SETUP
# ============================================================

log "Starting PM2 processes..."
cd "$HOME/zel"

pm2 delete zel-server 2>/dev/null || true
pm2 delete zel-reminders 2>/dev/null || true

pm2 start server.js --name zel-server --cwd "$HOME/zel"
pm2 start reminder-checker.js --name zel-reminders --cwd "$HOME/zel"
pm2 save
pm2 startup 2>/dev/null || warn "Run the pm2 startup command manually if shown above"

# ============================================================
# CRONTAB SETUP
# ============================================================

log "Setting up cron jobs..."

# Remove existing zel crons
crontab -l 2>/dev/null | grep -v "zel" | crontab - 2>/dev/null || true

# Add zel crons
(crontab -l 2>/dev/null; cat <<CRON
# Zel — vault sync every 5min
*/5 * * * * bash $HOME/zel/vault-sync.sh >> $HOME/zel/logs/vault-sync.log 2>&1
# Zel — daily briefing 07:03 weekdays
3 7 * * 1-5 cd $HOME/zel && node proactive.js daily-briefing >> $HOME/zel/logs/proactive.log 2>&1
# Zel — day review 18:07 weekdays
7 18 * * 1-5 cd $HOME/zel && node proactive.js day-review >> $HOME/zel/logs/proactive.log 2>&1
CRON
) | crontab -

mkdir -p "$HOME/zel/logs"

# ============================================================
# SUMMARY
# ============================================================

echo ""
echo "============================================"
log "Zel ecosystem setup complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Edit .env:        nano $HOME/zel/.env"
echo "  2. Edit mcp.json:    nano $HOME/.claude/mcp.json"
echo "  3. Copy agents:      scp -r ~/.claude/agents/* vps:~/.claude/agents/"
echo "  4. Copy skills:      scp -r ~/.claude/skills/* vps:~/.claude/skills/"
echo "  5. Copy rules:       scp -r ~/.claude/rules/* vps:~/.claude/rules/"
echo "  6. Configure webhook in Evolution API:"
echo "     URL: https://YOUR-DOMAIN/webhook/zel"
echo "  7. Test: send 'oi' on WhatsApp"
echo ""
echo "PM2 status:  pm2 status"
echo "Logs:        pm2 logs zel-server"
echo "Health:      curl localhost:3333/health"
echo ""
