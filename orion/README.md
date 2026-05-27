# Orion — Hermes Agent WhatsApp Gateway

Multi-user WhatsApp assistant powered by [Hermes Agent](https://github.com/nousresearch/hermes-agent) + [Evolution API](https://github.com/EvolutionAPI/evolution-api).

**One WhatsApp number, multiple AI assistants** — a Router maps phone numbers to individual Hermes instances, each with its own personality, tools, skills, and memory.

## Architecture

```
WhatsApp Message
    |
    v
Evolution API (manages WhatsApp connection)
    |
    v
Router Service (phone number -> Zel mapping)
    |
    +--> Orion :3001 --> hermes-gateway@adonai (Zel Adonai)
    +--> Orion :3002 --> hermes-gateway@simon  (Zel Simon)
    +--> Orion :3003 --> hermes-gateway@zel3   (Zel 3 - slot)
    |
    v
Each Hermes Gateway:
  - Evolution Adapter (custom platform) receives webhook
  - Hermes Agent processes (tools + skills + persona)
  - Reply sent back via Evolution API
```

## What Each Zel Gets

| Feature | Details |
|---------|---------|
| LLM | Claude Opus 4.7 via Claude Max (OAuth, auto-refresh) |
| Tools | 17+ Hermes tools (browser, terminal, file, cronjob, delegation...) |
| Skills | 21+ skills (ata, contrato, documento, POP, slide, prospect...) |
| MCPs | HubSpot, n8n, SerpAPI, Google Drive |
| Personality | Full playbook persona via HERMES.md |
| Dashboard | Web UI at /hermes/<user>/ with live chat |
| Audio (STT) | Groq Whisper free — transcribes voice messages automatically |
| Image (Vision) | Groq Vision free — describes images sent via WhatsApp |
| Phone Filter | ALLOWED_PHONES per instance — multi-user single-number routing |
| Memory | Persistent memory + session search |
| RAG | Qdrant vector DB integration for organizational knowledge |
| Token Refresh | Automatic OAuth renewal every 4h via cron |

## Quick Start

### Prerequisites

- Debian/Ubuntu server with root access
- Node.js 22+ and npm
- Python 3.13+ (for Hermes venv)
- Evolution API instance with a connected WhatsApp number
- Claude Max subscription (for Claude Code CLI auth)

### 1. Install Hermes Agent

```bash
python3 -m venv /opt/hermes/venv
/opt/hermes/venv/bin/pip install hermes-agent
/opt/hermes/venv/bin/pip install aiohttp ptyprocess
ln -sf /opt/hermes/venv/bin/hermes /usr/local/bin/hermes
```

### 2. Install Node.js MCP packages

```bash
npm install -g @hubspot/mcp-server n8n-mcp @piotr-agier/google-drive-mcp
```

### 3. Clone this repo

```bash
git clone https://github.com/pedrormc/zel-whitelabel.git /opt/zel
```

### 4. Configure global secrets

```bash
cp /opt/zel/orion/configs/global-env.example /opt/hermes/.env
# Edit with your Evolution API credentials
nano /opt/hermes/.env
```

### 5. Install the Evolution Gateway Adapter

```bash
# This registers "evolution" as a native Hermes gateway platform
cp /opt/zel/orion/gateway/evolution_adapter.py \
    /opt/hermes/venv/lib/python3.13/site-packages/gateway/platforms/evolution.py

# Register the import
echo '
# Evolution API custom adapter
try:
    from . import evolution
except ImportError:
    pass' >> /opt/hermes/venv/lib/python3.13/site-packages/gateway/platforms/__init__.py
```

### 6. Install systemd templates

```bash
cp /opt/zel/orion/systemd/hermes-gateway@.service /etc/systemd/system/
systemctl daemon-reload
```

### 7. Create a Zel instance

```bash
# Usage: setup-zel-instance.sh <username> <owner_name> <port> [phone]
bash /opt/zel/orion/scripts/setup-zel-instance.sh adonai Adonai 3001 556199150109
```

### 8. Authenticate Claude

```bash
sudo -u adonai HOME=/home/adonai claude login
```

### 9. Start the gateway

```bash
systemctl start hermes-gateway@adonai
journalctl -u hermes-gateway@adonai -f
```

### 10. Configure Evolution webhook

Point Evolution's webhook to your Orion server:

```bash
curl -X POST "https://your-evolution/webhook/set/YourInstance" \
  -H "apikey: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"webhook":{"url":"https://your-domain/webhook/","enabled":true,"events":["MESSAGES_UPSERT"]}}'
```

Use `/webhook/` endpoint for multi-user fanout (nginx mirrors to all gateways, each filters by `ALLOWED_PHONES`).

## Media Support (Audio + Images)

The Evolution adapter processes audio and images automatically using Groq's free API.

### Setup

1. Get a free API key at [console.groq.com](https://console.groq.com) (no credit card)
2. Add to `.env`: `GROQ_API_KEY=gsk_your_key`

### How it works

| Media | Processing | Free Limit |
|-------|-----------|------------|
| Audio | Evolution downloads -> Groq Whisper transcribes -> text to Claude | 8h audio/day |
| Image | Evolution downloads -> Groq Vision describes -> text to Claude | 14,400 req/day |
| Video | Caption only (transcription not yet supported) | - |

### Audio flow
```
User records voice -> WhatsApp -> Evolution -> adapter detects audioMessage
  -> downloads base64 via Evolution API
  -> sends to Groq Whisper (whisper-large-v3-turbo, language=pt)
  -> transcribed text becomes the message for Hermes
```

### Image flow
```
User sends photo -> WhatsApp -> Evolution -> adapter detects imageMessage
  -> downloads base64 via Evolution API
  -> sends to Groq Vision (llama-4-scout-17b)
  -> image description becomes context for Hermes
```

## Dashboard Setup (Optional)

### Build TUI

```bash
bash /opt/zel/orion/patches/build-tui.sh
```

### Patch for external access

```bash
python3 /opt/zel/orion/patches/fix-dashboard-cors.py your-domain.com
```

### Start dashboard

```bash
# Add to systemd or run manually:
sudo -u adonai HOME=/home/adonai hermes dashboard --port 9119 --host 0.0.0.0 --no-open --tui --insecure
```

### Nginx reverse proxy

Copy and adapt `nginx/orion-zel.conf` to your nginx config. Key features:
- `/adonai/` -> gateway port 3001
- `/hermes/adonai/` -> dashboard port 9119 (with sub_filter for path rewriting)
- `/api/` -> dashboard API + WebSocket (with `$connection_upgrade` map)

## Directory Structure

```
orion/
  gateway/
    evolution_adapter.py    # Custom Hermes gateway platform for Evolution API
    zel-bridge.py           # Legacy bridge (hermes -z fallback mode)
  configs/
    mcp.json                # MCP server configs (HubSpot, n8n, SerpAPI, GDrive)
    hermes-env.example      # Per-instance .env template
    global-env.example      # Global secrets template
  scripts/
    refresh-token.py        # OAuth token auto-refresh (cron every 4h)
    setup-zel-instance.sh   # Automated instance setup
  systemd/
    hermes-gateway@.service # Gateway systemd template
    hermes-dashboard@.service # Dashboard systemd template
  nginx/
    nginx.conf              # Main nginx config with WebSocket map
    orion-zel.conf          # Site config with all routes
  personality/
    HERMES.md               # Zel personality template (edit for your brand)
    CLAUDE.md               # Claude Code identity template
  patches/
    fix-dashboard-cors.py   # Patch dashboard for external access
    build-tui.sh            # Build dashboard TUI from source
  docs/
    ARCHITECTURE.md         # Full architecture documentation
    TROUBLESHOOTING.md      # Common issues and fixes
```

## Token Lifecycle

OAuth tokens from Claude Max expire in ~8 hours. The system auto-refreshes:

```
Login once (claude login) --> refresh token (long-lived, weeks/months)
  --> cron every 4h checks expiry
    --> if < 2h remaining, refresh via platform.claude.com
      --> new access token written to credentials
        --> gateway picks up on next API call
```

If the refresh token itself expires (rare), run `claude login` again.

## Multi-User Router

For multiple Zels sharing one WhatsApp number, deploy a Router service that maps phone numbers:

```json
{
  "556199150109": {"name": "Adonai", "target": "http://orion-ip:3001"},
  "556198852129": {"name": "Simon",  "target": "http://orion-ip:3002"}
}
```

The Router receives Evolution webhooks and forwards to the correct Zel based on sender phone.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| 401 Invalid credentials | Run `claude login` as the zel user, then `systemctl restart hermes-gateway@user` |
| "Still working..." forever | Token expired. Check `~/.hermes/logs/refresh.log`. Re-login if needed. |
| No webhook delivery | Check Evolution webhook URL points to correct Orion endpoint |
| Dashboard WebSocket fails | Run `fix-dashboard-cors.py` and restart dashboard |
| Gateway won't start (port busy) | `systemctl kill -s SIGKILL hermes-gateway@user` then start |
| TUI shows "[session ended]" | Run `build-tui.sh` to build the TUI component |

## Credits

- [Hermes Agent](https://github.com/nousresearch/hermes-agent) by Nous Research
- [Evolution API](https://github.com/EvolutionAPI/evolution-api)
- [Claude Code](https://claude.ai/code) by Anthropic
- Built by Pedro Roberto ([@pedrormc](https://github.com/pedrormc)) — CTO @ Singular Group
