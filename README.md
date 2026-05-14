# Zel — WhatsApp AI Assistant (White Label)

Assistente pessoal via WhatsApp construído sobre **Claude Code** + **Evolution API** + **Obsidian** (opcional). Você manda texto ou áudio no WhatsApp e o Zel processa, executa tarefas, busca em notas, agenda lembretes, gera documentos. Sessão persistente — o Zel mantém contexto entre mensagens.

Este é o **white label**: um template pra você montar SEU próprio Zel, com sua persona, seu vault e suas regras. Fork, personalize, deploye.

> **Fork upstream:** baseado em [pedrormc/zel](https://github.com/pedrormc/zel) (privado). Esta versão tira informações pessoais e generaliza pra qualquer um usar.

---

## Como funciona

```
Você (WhatsApp)
    |
    v
Evolution API (gateway WhatsApp, Docker self-hosted)
    |
    v  POST /webhook/zel
Nginx (HTTPS + rate limit)
    |
    v  proxy_pass :3333
webhook-server.ts (Bun, PM2)
    |
    ├── Texto → escreve direto na FIFO
    ├── Áudio → OpenAI Whisper (transcreve) → FIFO
    |
    v
FIFO (named pipe) → stdin do Claude Code
    |
    v
Claude Code (sessão persistente, com seu CLAUDE.md como system prompt)
    |
    v
whatsapp-mcp.ts (MCP reply tool)
    |
    v  POST /message/sendText
Evolution API → WhatsApp (resposta)
```

## Features

- **Texto e áudio** — recebe mensagens de texto e áudio (transcrição via Whisper)
- **Vault Obsidian** (opcional) — Claude tem acesso completo ao vault como base de conhecimento
- **Daily briefing** — manda resumo do dia automaticamente (configurável)
- **Day review** — manda review do dia automaticamente (configurável)
- **Lembretes** — "me lembra às 15h de ligar pro cliente" → cron / `reminders.json`
- **Plaud integration** (opcional) — recebe transcrições de gravações e processa via Claude
- **Trigger endpoint** — qualquer cron/automação pode disparar uma mensagem proativa
- **Single-user gate** — só responde do número configurado
- **Tools de permissão via WhatsApp** — Claude pede aprovação direto no chat ("sim &lt;codigo&gt;")

---

## Quick Start

### Requisitos
- VPS Ubuntu 22+ (1vCPU / 2GB RAM já roda)
- Node.js 18+ e [Bun](https://bun.sh)
- [Claude Code](https://github.com/anthropics/claude-code) instalado e logado
- [Evolution API](https://github.com/EvolutionAPI/evolution-api) rodando (Docker recomendado)
- Domínio com HTTPS apontando pra VPS (Nginx + Let's Encrypt)
- Conta OpenAI (pra transcrição Whisper)
- (Opcional) Vault Obsidian num repo git

### Instalação

```bash
# 1. Clone o template
git clone https://github.com/SEU_USER/zel-whitelabel.git ~/zel
cd ~/zel

# 2. Instale dependências
bun install
npm install -g pm2

# 3. Configure variáveis
cp .env.example .env
chmod 600 .env
nano .env   # preencha: EVOLUTION_URL, EVOLUTION_INSTANCE, EVOLUTION_APIKEY,
            #            OWNER_WHATSAPP_NUMBER, OPENAI_API_KEY, VAULT_PATH, ZEL_HOME

# 4. Configure MCP servers
cp .mcp.json.example .mcp.json
nano .mcp.json   # ajuste paths e habilite/desabilite servidores

# 5. Personalize o Zel
nano CLAUDE.md   # edite a persona, regras, capacidades

# 6. (Opcional) Clone seu vault Obsidian
git clone https://github.com/SEU_USER/seu-vault.git ~/vault

# 7. Setup do webhook na Evolution API
# Painel da Evolution → instância → Webhooks
# URL: https://SEU-DOMINIO/webhook/zel
# Events: messages.upsert

# 8. Inicie via PM2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup

# 9. Mande "oi" no WhatsApp pelo número OWNER_WHATSAPP_NUMBER
```

Pro guia completo passo a passo (incluindo nginx + certbot + Evolution Docker), veja [`docs/SETUP-VPS.md`](docs/SETUP-VPS.md).

---

## Personalização

O Zel é só um **template**. Pra que ele seja útil pra você, você precisa personalizar:

1. **CLAUDE.md** — a persona do assistente (nome, idioma, tom, regras)
2. **Vault** — seu próprio Obsidian vault como base de conhecimento (ou pule essa parte)
3. **Lembretes diários** — adicione em `reminders.json` lembretes fixos
4. **Crons** — daily briefing, day review, ou qualquer trigger automático

Veja [`docs/CUSTOMIZATION.md`](docs/CUSTOMIZATION.md) pro guia completo de personalização.

---

## Segurança

⚠️ **Leia [`docs/SECURITY.md`](docs/SECURITY.md) antes de deploy.** TL;DR:

- Single-user gate: o Zel só responde ao `OWNER_WHATSAPP_NUMBER` configurado. Mensagens de outros números são descartadas
- `.env` com `chmod 600` — nunca commitar
- Nunca pedir/enviar credenciais pelo WhatsApp (regra inalienável do CLAUDE.md)
- Use `permission-mode bypassPermissions` com cautela — o WhatsApp é um canal de baixa fricção, fácil de cair em phishing
- Rate limit no nginx
- Atualize Claude Code e dependências regularmente

---

## Estrutura do projeto

```
zel/
├── webhook-server.ts        # Bun HTTP server (recebe Evolution webhooks, escreve na FIFO)
├── whatsapp-channel.ts      # MCP channel + webhook server (alternativa v2)
├── whatsapp-mcp.ts          # MCP server com tool 'reply' (Claude usa pra responder)
├── proactive.js             # Daily briefing, day review, task reminder (via cron)
├── reminder-checker.js      # Loop que checa reminders.json a cada 60s
├── lib/
│   └── evolution-send.js    # Helper standalone pra enviar texto via Evolution API
├── start-zel.sh             # Inicia a sessão Claude Code com FIFO + MCP
├── ecosystem.config.cjs     # PM2 config (3 processos)
├── vault-sync.sh            # Cron: git pull/push do vault a cada 5min (opcional)
├── CLAUDE.md                # System prompt do Zel — EDITE PRA PERSONALIZAR
├── .env.example             # Template de variáveis
├── .mcp.json.example        # Template MCP servers
├── docs/
│   ├── SETUP-VPS.md         # Setup completo da VPS do zero
│   ├── EVOLUTION-API.md     # Configuração da Evolution
│   ├── ARCHITECTURE.md      # Arquitetura detalhada
│   ├── CUSTOMIZATION.md     # Como personalizar a persona, lembretes, crons
│   ├── SECURITY.md          # Boas práticas de segurança
│   └── TROUBLESHOOTING.md   # Problemas comuns
└── scripts/
    └── setup-vps.sh         # Script semi-automatizado de setup
```

## Processos PM2

| Processo | Arquivo | Função |
|---|---|---|
| `zel-claude` | `start-zel.sh` | Sessão Claude Code persistente (lê da FIFO) |
| `zel-webhook` | `webhook-server.ts` | Bun HTTP server porta 3333 (recebe Evolution) |
| `zel-reminders` | `reminder-checker.js` | Checa lembretes a cada 60s |

## Cron jobs sugeridos

```cron
# Sync de vault (se você usa Obsidian)
*/5 * * * * bash ~/zel/vault-sync.sh >> ~/zel/logs/vault-sync.log 2>&1

# Briefing matinal
0 10 * * * cd ~/zel && node proactive.js daily-briefing >> ~/zel/logs/proactive.log 2>&1

# Review do dia
0 22 * * * cd ~/zel && node proactive.js day-review >> ~/zel/logs/proactive.log 2>&1
```

---

## Stack

- **Runtime:** Node.js 18+ e Bun (pros .ts)
- **AI:** Claude Code CLI (`claude --print` em sessão persistente)
- **WhatsApp:** Evolution API (self-hosted Docker)
- **Áudio:** OpenAI Whisper API
- **Conhecimento:** Obsidian vault (Markdown, git sync) — opcional
- **Process Manager:** PM2
- **Reverse Proxy:** nginx + Let's Encrypt
- **Servidor:** VPS Ubuntu 22+

## Licença

MIT — fork, modifique, use no que quiser. Veja [`LICENSE`](LICENSE).

## Créditos

Baseado no Zel original do [@pedrormc](https://github.com/pedrormc), agora generalizado pra qualquer pessoa montar o próprio assistente pessoal.

Pull requests e melhorias bem-vindos.
