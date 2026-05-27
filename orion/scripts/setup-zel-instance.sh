#!/bin/bash
# Setup a new Zel instance on the Orion server.
# Run as root. Creates user, configures Hermes, installs skills.
#
# Usage: ./setup-zel-instance.sh <username> <owner_name> <port> <phone>
# Example: ./setup-zel-instance.sh adonai Adonai 3001 556199150109
set -e

USER=$1
OWNER=$2
PORT=$3
PHONE=$4

if [ -z "$USER" ] || [ -z "$OWNER" ] || [ -z "$PORT" ]; then
    echo "Usage: $0 <username> <owner_name> <port> [phone]"
    echo "Example: $0 adonai Adonai 3001 556199150109"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HERMES_VENV="/opt/hermes/venv"

echo "=== Creating user: $USER ==="
id "$USER" &>/dev/null || useradd -m -s /bin/bash "$USER"

echo "=== Setting up Hermes config ==="
mkdir -p /home/$USER/.hermes/{skills,logs,sessions,memories,hooks,cron,pairing}
mkdir -p /home/$USER/.claude/{agents,rules,skills,secrets}

# .env
cat > /home/$USER/.hermes/.env << EOF
# Zel $OWNER — Hermes Gateway Config
ZEL_USER=$USER
ZEL_OWNER_NAME=$OWNER
ZEL_BRIDGE_PORT=$PORT
GATEWAY_ALLOW_ALL_USERS=true
WHATSAPP_MODE=bot
WHATSAPP_DM_POLICY=open
WHATSAPP_GROUP_POLICY=disabled
EVOLUTION_URL=${EVOLUTION_URL:-https://your-evolution.example.com}
EVOLUTION_INSTANCE=${EVOLUTION_INSTANCE:-Zel3}
EVOLUTION_APIKEY=${EVOLUTION_APIKEY:-your-api-key}
EOF

echo "=== Installing Evolution Gateway Adapter ==="
cp "$SCRIPT_DIR/gateway/evolution_adapter.py" \
    "$HERMES_VENV/lib/python3.13/site-packages/gateway/platforms/evolution.py"

# Add import if not present
INIT_FILE="$HERMES_VENV/lib/python3.13/site-packages/gateway/platforms/__init__.py"
if ! grep -q "evolution" "$INIT_FILE" 2>/dev/null; then
    echo "" >> "$INIT_FILE"
    echo "# Evolution API custom adapter" >> "$INIT_FILE"
    echo "try:" >> "$INIT_FILE"
    echo "    from . import evolution" >> "$INIT_FILE"
    echo "except ImportError:" >> "$INIT_FILE"
    echo "    pass" >> "$INIT_FILE"
    echo "  Evolution adapter registered in __init__.py"
fi

echo "=== Configuring Hermes ==="
sudo -u $USER HOME=/home/$USER hermes config set model.default claude-opus-4-7 2>/dev/null
sudo -u $USER HOME=/home/$USER hermes config set model.provider anthropic 2>/dev/null
sudo -u $USER HOME=/home/$USER hermes config set tools.web.enabled true 2>/dev/null
sudo -u $USER HOME=/home/$USER hermes config set tools.terminal.enabled true 2>/dev/null
sudo -u $USER HOME=/home/$USER hermes config set tools.file.enabled true 2>/dev/null
sudo -u $USER HOME=/home/$USER hermes config set display.language pt-BR 2>/dev/null

# Add evolution platform to config
sudo -u $USER HOME=/home/$USER python3 -c "
import yaml
f = '/home/$USER/.hermes/config.yaml'
cfg = yaml.safe_load(open(f))
if 'platforms' not in cfg: cfg['platforms'] = {}
cfg['platforms']['evolution'] = {
    'enabled': True,
    'extra': {'bridge_port': $PORT, 'evolution_url': '${EVOLUTION_URL:-}', 'evolution_instance': '${EVOLUTION_INSTANCE:-Zel3}'}
}
yaml.dump(cfg, open(f, 'w'), default_flow_style=False, allow_unicode=True)
print('  Evolution platform enabled in config.yaml')
"

# Set persona
sudo -u $USER HOME=/home/$USER hermes config set persona \
    "Voce e o Zel, a inteligencia viva da Singular Group. Extensao digital do $OWNER. Firme e acessivel. Responda em portugues brasileiro. Formato WhatsApp: mensagens curtas. Se perguntarem quem voce e: Sou o Zel, da central de inteligencia da Singular." 2>/dev/null

echo "=== Installing HERMES.md ==="
sed "s/Adonai/$OWNER/g; s/adonai/$USER/g" "$SCRIPT_DIR/personality/HERMES.md" > /home/$USER/HERMES.md
cp /home/$USER/HERMES.md /home/$USER/.hermes/HERMES.md

echo "=== Installing CLAUDE.md ==="
sed "s/Adonai/$OWNER/g; s/adonai/$USER/g; s/3001/$PORT/g" "$SCRIPT_DIR/personality/CLAUDE.md" > /home/$USER/.claude/CLAUDE.md

echo "=== Installing skills ==="
if [ -d "$SCRIPT_DIR/../skills" ]; then
    cp -r "$SCRIPT_DIR/../skills/"* /home/$USER/.hermes/skills/ 2>/dev/null || true
    echo "  Skills from toolkit copied"
fi

echo "=== Installing token refresh cron ==="
CRON_MIN=$((RANDOM % 10))
echo "$CRON_MIN */4 * * * /opt/hermes/venv/bin/python3 /opt/hermes/scripts/refresh-token.py >> /home/$USER/.hermes/logs/refresh.log 2>&1" | crontab -u $USER -
echo "  Cron installed (every 4h at :${CRON_MIN})"

echo "=== Fixing permissions ==="
chown -R $USER:$USER /home/$USER/.hermes /home/$USER/.claude /home/$USER/HERMES.md

echo "=== Installing systemd service ==="
cp "$SCRIPT_DIR/systemd/hermes-gateway@.service" /etc/systemd/system/ 2>/dev/null || true
systemctl daemon-reload
systemctl enable hermes-gateway@$USER
echo "  Service: hermes-gateway@$USER"

echo ""
echo "============================================"
echo "  Zel instance '$USER' ($OWNER) configured!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Authenticate Claude: sudo -u $USER HOME=/home/$USER claude login"
echo "  2. Sync credentials: python3 /opt/hermes/scripts/refresh-token.py (as $USER)"
echo "  3. Start gateway: systemctl start hermes-gateway@$USER"
echo "  4. Test: curl http://127.0.0.1:$PORT/health"
echo ""
echo "WhatsApp routing (add to whitelist.json):"
echo "  \"$PHONE\": {\"name\": \"$OWNER\", \"target\": \"http://orion-ip:$PORT\"}"
