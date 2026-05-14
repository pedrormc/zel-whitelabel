# Arquitetura Detalhada

## Visao Geral do Sistema

```
┌─────────────── VPS (Ubuntu, TZ: America/Sao_Paulo) ──────────────┐
│                                                                    │
│  ┌──────────── Docker ──────────────┐                              │
│  │  Evolution API (:8080)           │                              │
│  │  └── Instancia "Zel"            │                              │
│  │      └── Conectada ao WhatsApp   │                              │
│  └──────────────────────────────────┘                              │
│          │ webhook POST              ▲ sendText POST               │
│          v                           │                             │
│  ┌─────────────────────────────────────────────────┐               │
│  │  nginx (HTTPS + rate limit 10req/min)           │               │
│  │  └── /webhook/zel → proxy_pass :3333            │               │
│  └─────────────────────────────────────────────────┘               │
│          │                                                         │
│          v                                                         │
│  ┌─────────────────────────────────────────────────┐               │
│  │  PM2: zel-server (server.js)                    │               │
│  │  ├── Express :3333                              │               │
│  │  ├── POST /webhook/zel                          │               │
│  │  │   ├── Filtra: so evento messages.upsert      │               │
│  │  │   ├── Filtra: so numero autorizado           │               │
│  │  │   ├── Dedup: ignora msg ID repetido          │               │
│  │  │   ├── Texto → fila                           │               │
│  │  │   └── Audio → Whisper API → fila             │               │
│  │  ├── Job Queue (sequencial)                     │               │
│  │  │   └── runClaude(msg) → sendText(resposta)    │               │
│  │  └── GET /health                                │               │
│  └─────────────────────────────────────────────────┘               │
│          │                                                         │
│          v                                                         │
│  ┌─────────────────────────────────────────────────┐               │
│  │  Claude Code CLI                                │               │
│  │  claude --print --output-format json             │               │
│  │  ├── cwd: ~/obsidiano (vault)                   │               │
│  │  ├── system prompt: CLAUDE.md                   │               │
│  │  ├── tools: Read,Glob,Grep,Write (modo basic)   │               │
│  │  ├── sessao persistente (--resume)              │               │
│  │  └── timeout: 120s                              │               │
│  └─────────────────────────────────────────────────┘               │
│                                                                    │
│  ┌─────────────────────────────────────────────────┐               │
│  │  PM2: zel-reminders (reminder-checker.js)       │               │
│  │  └── Checa ~/zel/reminders.json a cada 60s      │               │
│  │      └── Dispara via Evolution sendText          │               │
│  └─────────────────────────────────────────────────┘               │
│                                                                    │
│  ┌─────────────────────────────────────────────────┐               │
│  │  Cron Jobs                                       │               │
│  │  ├── */5min  → vault-sync.sh (git pull+push)    │               │
│  │  ├── 07:03   → proactive.js daily-briefing      │               │
│  │  └── 18:07   → proactive.js day-review          │               │
│  └─────────────────────────────────────────────────┘               │
│                                                                    │
│  ~/obsidiano/  (Obsidian vault, git repo)                          │
│  ├── Trabalho/     → Trabalho principal                            │
│  ├── Projetos/     → Projetos paralelos                            │
│  ├── Clientes/     → Freelancer                                    │
│  ├── Pessoal/      → Projetos pessoais                             │
│  ├── Reunioes/     → Pautas e recaps                               │
│  ├── Diario/       → Daily notes                                   │
│  └── ...                                                           │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## Componentes em Detalhe

### 1. server.js — Webhook Server

**Responsabilidade:** Receber webhooks da Evolution API, filtrar, e rotear para processamento.

**Fluxo de uma mensagem de texto:**

```
1. Evolution API envia POST /webhook/zel com JSON
2. Express retorna 200 imediatamente (nao bloqueia Evolution)
3. Filtra:
   - event != "messages.upsert" → ignora
   - key.fromMe == true → ignora (propria mensagem)
   - senderNumber != PEDRO_NUMBER → ignora
   - msgId ja visto (dedup 5min) → ignora
4. Extrai texto de msg.conversation ou msg.extendedTextMessage.text
5. Adiciona na fila: queue.push({ message, number })
6. Chama processQueue()
```

**Fluxo de um audio:**

```
1-3. Mesmo filtro acima
4. Detecta msg.audioMessage
5. Chama transcribeAudio(messageKey):
   a. POST /chat/getBase64FromMediaMessage/Zel → recebe base64
   b. Converte base64 → Buffer → Blob
   c. POST OpenAI /v1/audio/transcriptions (model: whisper-1, language: pt)
   d. Retorna texto transcrito
6. Adiciona transcricao na fila
```

**Deduplicacao:**
- Mapa in-memory de message IDs com timestamp
- TTL de 5 minutos (limpo via setInterval a cada 60s)
- Previne processamento duplicado quando Evolution envia o mesmo webhook 2x

**Job Queue:**
- Array simples in-memory
- Processamento sequencial (uma mensagem por vez)
- Se `runClaude` falha com TIMEOUT → mensagem de erro pro usuario
- Se falha por outro motivo → retry 1x → mensagem de erro

### 2. claude-runner.js — Claude Process Wrapper

**Responsabilidade:** Gerenciar execucao do Claude CLI, sessoes, lockfile, e timeouts.

**Lockfile (`~/zel/claude.lock`):**
- Criado antes de executar Claude (flag `wx` = exclusivo)
- Contem o PID do processo
- Removido no `finally` (sempre, mesmo em erro)
- Se lock existe e tem >130s → considerado stale → removido
- Se lock existe e tem <130s → aguarda (spin lock com 100ms sleep)
- Se aguarda >130s → erro `LOCK_TIMEOUT`

**Sessao persistente:**
- `session-id`: arquivo com o ID da sessao Claude
- `session-count`: contador de mensagens
- Rotacao automatica quando:
  - Mais de 50 mensagens (`SESSION_MAX_MESSAGES`)
  - Sessao e de um dia anterior (00:00)
- Na rotacao: pede resumo da sessao anterior → inicia nova com contexto

**Execucao do Claude:**

```
claude -p \
  --output-format json \
  --resume SESSION_ID \
  --allowedTools "Read,Glob,Grep,Write" \
  --append-system-prompt "conteudo do CLAUDE.md"
```

- Input: mensagem via stdin
- Output: JSON com `result`, `session_id`, etc
- Timeout: 120s (SIGTERM)
- CWD: `~/obsidiano` (vault Obsidian)

**Tool profiles (modos):**

```javascript
const TOOL_PROFILES = {
  basic:    'Read,Glob,Grep,Write',
  standard: 'Read,Glob,Grep,Write,Agent,WebSearch,WebFetch',
  full:     null,  // sem restricao
};
```

### 3. send-whatsapp.js — Envio de Mensagens

**Responsabilidade:** Enviar mensagens via Evolution API com retry e split.

**Split de mensagens:**
- Limite: 3500 chars por mensagem (WhatsApp tem ~4000)
- Split inteligente: quebra em `\n` ou espaco, nunca no meio de palavra
- Envia cada chunk sequencialmente

**Retry:**
- 3 tentativas com backoff: 1s, 3s, 10s
- Loga erro em cada tentativa
- Se todas falharem → loga erro final (nao lanca excecao)

**Endpoint usado:**

```
POST {EVOLUTION_URL}/message/sendText/{EVOLUTION_INSTANCE}
Headers: apikey, Content-Type: application/json
Body: { "number": "5561999999999@s.whatsapp.net", "text": "..." }
```

### 4. reminder-checker.js — Lembretes

**Responsabilidade:** Processo PM2 persistente que checa lembretes a cada 60s.

**Fluxo:**
1. Le `~/zel/reminders.json` (array de `{time, text}`)
2. Compara cada `time` com `Date.now()`
3. Se `time <= now` → envia via `sendText` → remove do array
4. Escreve array atualizado (atomic: `.tmp` + rename)
5. Se envio falha → mantem no array (retry no proximo ciclo)

**Como lembretes sao criados:**
O usuario manda "me lembra as 15h de X" no WhatsApp → Claude interpreta e escreve em `reminders.json` via tool Write.

### 5. proactive.js — Briefing e Review

**Responsabilidade:** Mensagens proativas agendadas via cron.

**Daily Briefing (07:03 seg-sex):**
1. Le `tasks.md` do vault (tarefas pendentes)
2. Le ultimas 3 notas de `Reunioes/` (reunioes recentes)
3. Monta prompt com data atual + dados coletados
4. Chama `runClaude(prompt, { isProactive: true })` — sessao separada
5. Envia resposta via WhatsApp

**Day Review (18:07 seg-sex):**
1. Roda `git log --since="today 00:00" --oneline` no vault
2. Monta prompt com o log
3. Chama Claude com sessao separada
4. Envia resposta via WhatsApp

### 6. vault-sync.sh — Sync do Vault

**Responsabilidade:** Manter vault da VPS sincronizado com GitHub.

**Fluxo (a cada 5min via cron):**
1. `git stash` (salva mudancas locais do Claude)
2. `git pull --rebase origin main` (puxa novas notas do PC)
3. `git stash pop` (restaura mudancas locais)
4. `git add -A && git commit -m "zel: auto-sync" && git push`
5. Se pull ou push falhar → alerta via WhatsApp

**Bidirecional:**
- PC → VPS: Notas criadas no Obsidian (PC) sao puxadas via `git pull`
- VPS → PC: Notas criadas pelo Zel sao pushadas via `git push`
- PC precisa de auto-pull (plugin Obsidian Git ou cron)

### 7. CLAUDE.md — System Prompt

Define a personalidade e regras do Zel:

- **Identidade:** "Zel, assistente pessoal do dono"
- **Idioma:** PT-BR, casual, direto
- **Formato:** Max 3 paragrafos (e WhatsApp, nao email)
- **Capacidades:** Ler/escrever vault, agendar lembretes
- **Restricoes:** Nao inventa dados, nao faz deploy, nao deleta arquivos
- **Categorias:** pessoal, trabalho, freelancer, estudos (mapeadas para pastas do vault)

## Fluxo Completo — Mensagem de Texto

```
1. Usuario manda "o que tenho pra hoje?" no WhatsApp
2. WhatsApp → Evolution API (protocolo interno)
3. Evolution API envia POST /webhook/zel:
   {
     "event": "messages.upsert",
     "instance": "Zel",
     "data": {
       "key": {"remoteJid": "55619...@s.whatsapp.net", "fromMe": false, "id": "ABC123"},
       "message": {"conversation": "o que tenho pra hoje?"}
     }
   }
4. Nginx recebe, checa rate limit, passa pra :3333
5. server.js recebe, retorna 200 imediatamente
6. Filtra: messages.upsert ✓, nao fromMe ✓, numero autorizado ✓, nao duplicado ✓
7. Extrai "o que tenho pra hoje?" → adiciona na fila
8. processQueue() → runClaude("o que tenho pra hoje?")
9. claude-runner.js:
   a. Adquire lock (cria claude.lock)
   b. Le session-id (sessao existente)
   c. Spawna: claude -p --output-format json --resume SESSION --allowedTools "..."
   d. Escreve mensagem no stdin
   e. Claude executa: le vault, busca notas, monta resposta
   f. Retorna JSON com resultado
   g. Salva novo session-id, incrementa contador
   h. Remove lock
10. server.js recebe resposta
11. sendText("55619...", "Bom dia! Hoje voce tem...")
12. send-whatsapp.js: POST /message/sendText/Zel
13. Evolution API envia pro WhatsApp
14. Usuario recebe resposta no celular
```

## Fluxo Completo — Audio

```
1-5. Igual texto
6. Detecta audioMessage no payload
7. transcribeAudio(messageKey):
   a. POST /chat/getBase64FromMediaMessage/Zel → base64 do audio
   b. Buffer.from(base64) → Blob("audio/ogg")
   c. POST OpenAI Whisper API → "pesquisa sobre a marca Power Coffee..."
8. Texto transcrito → fila → runClaude → resposta
9-14. Igual texto
```

## Persistencia

| Dado | Local | Formato | Durabilidade |
|------|-------|---------|-------------|
| Sessao Claude | `~/zel/session-id` | Texto (UUID) | Sobrevive restart |
| Contador msgs | `~/zel/session-count` | Texto (numero) | Sobrevive restart |
| Lembretes | `~/zel/reminders.json` | JSON array | Sobrevive restart |
| Lockfile | `~/zel/claude.lock` | Texto (PID) | Transitorio |
| Vault (notas) | `~/obsidiano/` | Markdown (git) | Permanente |
| Fila de mensagens | In-memory (array) | Runtime | **Perde no restart** |
| Dedup cache | In-memory (Map) | Runtime | Perde no restart |
| Logs | PM2 + `~/zel/logs/` | Texto | Rotacionado |

## Seguranca

```
Camadas de protecao:

1. Nginx: HTTPS + rate limit (10 req/min)
2. server.js: Filtra so numero autorizado + dedup
3. claude-runner.js: --allowedTools restringe o que Claude pode fazer
4. CLAUDE.md: Instrucoes de nao deletar, nao fazer deploy
5. .env: chmod 600, nunca commitado
6. vault: repo privado no GitHub
```
