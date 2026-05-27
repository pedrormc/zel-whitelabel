# Orion Architecture

## Overview

Orion is the intelligence layer of Singular Group. It uses Hermes Agent as the runtime for AI-powered WhatsApp assistants ("Zels"), with Evolution API handling the WhatsApp connection.

## Core Components

### 1. Evolution API
- Manages the WhatsApp connection via Baileys
- One instance, one number, multiple Zels via Router
- Sends webhooks on incoming messages
- Receives REST API calls to send replies

### 2. Router Service
- Node.js app on a Droplet/VPS with public IP
- Evolution webhook points here
- Maintains whitelist: phone number -> Zel mapping
- Forwards webhooks to the correct Hermes gateway port

### 3. Evolution Gateway Adapter (`evolution_adapter.py`)
- Custom `BasePlatformAdapter` registered in Hermes's `platform_registry`
- HTTP server on a per-instance port (3001, 3002, ...)
- Receives POST webhooks from Router
- Extracts message (jid, phone, text) from Evolution payload
- Creates `MessageEvent` for Hermes's agent pipeline
- `send()` method sends reply back via Evolution REST API
- Shows as native platform in `hermes gateway run`

### 4. Hermes Agent (per user)
- Each Zel user runs their own Hermes instance
- `hermes-gateway@<user>.service` systemd template
- Full Hermes tool suite: browser, terminal, file, cronjob, delegation
- 21+ skills from toolkit
- HERMES.md personality loaded per user
- OAuth tokens auto-refreshed via cron

### 5. Cloudflare Tunnel
- `orion.blackgroup-bia.shop` -> Orion server port 80
- Nginx handles routing:
  - `/adonai/` -> gateway 3001
  - `/simon/` -> gateway 3002
  - `/hermes/adonai/` -> dashboard 9119
  - `/api/` -> dashboard API + WebSocket

### 6. Dashboard
- Hermes built-in web UI (FastAPI + Vite)
- Config editor, session viewer, embedded TUI chat
- Patched for external access (CORS + WebSocket auth)
- TUI built from source (Node.js)

## Message Flow

```
1. User sends WhatsApp message to Zel number
2. Evolution API receives via Baileys connection
3. Evolution fires webhook POST to Router
4. Router checks whitelist, forwards to correct port
5. Evolution Adapter (Hermes gateway) receives POST
6. Adapter creates MessageEvent with user info
7. Hermes Agent processes:
   a. Loads HERMES.md persona
   b. Resolves Claude OAuth token
   c. Makes API call to Claude (Opus 4.7)
   d. Executes tools if needed (browser, file, terminal)
   e. Generates response
8. Adapter.send() posts reply to Evolution REST API
9. Evolution delivers reply to user on WhatsApp
```

## Token Management

```
claude login (1x manual) --> credentials.json
  |
  +--> accessToken (8h TTL)
  +--> refreshToken (weeks/months)
  |
  +--> cron (every 4h) runs refresh-token.py
        |
        +--> POST platform.claude.com/v1/oauth/token
        |    (with refresh_token, client_id)
        |
        +--> New accessToken written to:
             - ~/.claude/.credentials.json
             - ~/.hermes/auth.json
        |
        +--> Gateway picks up on next API call
```

## Errors We Solved

| Error | Root Cause | Fix |
|-------|-----------|-----|
| `invalid x-api-key` | Empty ANTHROPIC_API_KEY in .env creating bad pool entry | Remove empty env var, clean auth.json |
| `Invalid authentication credentials` | Expired OAuth token | Setup cron auto-refresh |
| `auth.anthropic.com NXDOMAIN` | Wrong refresh endpoint | Hermes uses platform.claude.com (resolves fine) |
| Rate limit 429 | Shared rate bucket with active Claude session | Use Claude Code CLI pipe mode |
| WebSocket 401 on dashboard | HTTP auth middleware blocks WS before handler | Add WS paths to _PUBLIC_API_PATHS |
| Dashboard CORS blocked | Only localhost allowed | Patch allow_origin_regex |
| TUI "[session ended]" | ui-tui not bundled in pip install | Build from source (build-tui.sh) |
| Evolution webhook dead | URL pointing to old server | Update via Evolution webhook/set API |
