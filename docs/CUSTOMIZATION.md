# Customization Guide

O Zel sai do template como um esqueleto funcional. Pra ele se tornar SEU assistente, você precisa personalizar 4 camadas:

1. **Persona** (CLAUDE.md) — quem é o Zel, como ele fala, o que sabe
2. **Vault** (opcional) — sua base de conhecimento em Obsidian
3. **Lembretes** — recorrentes e pontuais
4. **Automações proativas** — briefing, review, triggers externos

---

## 1. Persona — `CLAUDE.md`

O CLAUDE.md é o **system prompt** que vai pra cada sessão do Claude. É a coisa mais importante do projeto.

### Mínimo essencial pra editar

- **Nome do dono** — substitua `{{OWNER_NAME}}` pelo seu nome real ou apelido
- **Idioma e tom** — PT-BR informal? formal? inglês? espanhol? mistura?
- **Regras de uso** — o que o Zel pode/não pode fazer

### Sugestões avançadas

- **Categorias de projeto** — se você organiza vault por projeto, descreva a estrutura
- **Atalhos** — "quando eu falar 'task X', adicione X ao reminders.json"
- **Restrições de domínio** — "não responda sobre Y / não pesquise sobre Z"
- **Estilo de resposta** — número máximo de parágrafos, uso de emoji, etc.

### Exemplos de persona

**Persona 1: assistente profissional / corporativo**
```
Você é o Atlas, assistente do João Silva (CEO da AcmeCorp).
- Tom: formal mas direto
- Sem emojis
- Sempre referencia decisões a docs do Notion
- NUNCA discute conteúdo sigiloso (M&A, financeiros)
```

**Persona 2: companion / coach pessoal**
```
Você é a Rita, assistente da Maria.
- Tom: caloroso, encorajador, motivacional
- Use emojis com moderação
- Toda manhã pergunta como ela tá se sentindo
- Anota o humor diário em diary.md
```

**Persona 3: dev productivity buddy**
```
Você é o Cody, copiloto do dev Jamie.
- Sempre cita file:line ao referenciar código
- Roda lint/test antes de sugerir commit
- Mantém log de decisões técnicas em adr/
```

---

## 2. Vault Obsidian (opcional)

Se você usa Obsidian, configure no `.mcp.json`:

```json
"obsidian": {
  "command": "npx",
  "args": ["@bitbonsai/mcpvault@latest", "/home/USER/vault"]
}
```

O Zel terá acesso a:
- Ler qualquer nota
- Criar notas com frontmatter
- Buscar full-text e por tag
- Atualizar frontmatter

### Sugestão: estrutura mínima do vault

```
vault/
├── Inbox/              # entrada rápida (Zel coloca anotações aqui)
├── Projetos/           # projetos ativos
├── Clientes/           # se você atende clientes
├── Pessoal/            # vida pessoal, hábitos, journaling
├── Reuniões/           # atas e devolutivas
├── Diário/             # daily notes
└── Sistema/            # configs, automações, doc do próprio Zel
```

### Sync entre devices

Se você usa Obsidian Sync oficial (US$8/mês): ignore essa parte.

Se você quer self-hosted free:
```bash
# vault-sync.sh roda via cron a cada 5min
# bidirectional git sync: pull primeiro, depois push se houver mudança local
git -C ~/vault pull --quiet
git -C ~/vault add -A
git -C ~/vault commit -m "auto: sync $(date +%Y-%m-%d_%H:%M)" --quiet || true
git -C ~/vault push --quiet
```

---

## 3. Lembretes

### Lembretes pontuais (one-shot)

Você manda no WhatsApp: "me lembra às 15h de ligar pro João"

O Zel salva em `~/zel/reminders.json`:
```json
[{"time": "2026-05-15T15:00:00", "text": "ligar pro João", "_retries": 0}]
```

O processo `zel-reminders` checa a cada 60s e dispara via Evolution. Retry 3x, drop após 30min de atraso.

### Lembretes recorrentes (todo dia X horas)

Adicione no formato `{"type": "daily", "text": "..."}` no `reminders.json`. O `proactive.js daily-briefing` consome isso e inclui no briefing matinal:

```json
{"type": "daily", "text": "Verificar caixa de entrada do email comercial"}
{"type": "daily", "text": "Beber 2L de água até as 14h"}
```

### Lembretes recorrentes em horário fixo

Use **cron** direto. Exemplo:

```cron
# Todo dia útil às 14h: lembrete pra revisar deals do Pipedrive
0 14 * * 1-5 curl -s -X POST http://127.0.0.1:3333/trigger \
  -H "Content-Type: application/json" \
  -d '{"prompt":"[PROATIVO] Lembrete: revisar deals do Pipedrive (estágio negociação). Mande mensagem curta.","source":"proactive"}'
```

---

## 4. Automações proativas

O endpoint `/trigger` aceita qualquer prompt arbitrário e enfileira na FIFO pro Claude processar. Útil pra:

- **Notificações de outras integrações** — webhook do GitHub, Linear, HubSpot, etc
- **Resumos periódicos** — diário, semanal, mensal
- **Reações a eventos** — alguém respondeu um email importante → mande mensagem
- **Briefing personalizado** — leia o calendário hoje, monte resumo da agenda

### Exemplo: GitHub PR aberto pra mim

```yaml
# .github/workflows/notify-zel.yml
on:
  pull_request:
    types: [review_requested]
jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -s -X POST https://SEU-DOMINIO/trigger \
            -H "Content-Type: application/json" \
            -d '{
              "prompt": "[PROATIVO - GitHub] PR ${{ github.event.pull_request.html_url }} foi aberto pedindo seu review. Manda mensagem pro dono.",
              "source": "github"
            }'
```

### Exemplo: webhook do Plaud (gravador)

Já implementado em `webhook-server.ts`: endpoint `/webhook/plaud-transcript`. Configurado via Bearer token `PLAUD_WEBHOOK_TOKEN`.

---

## 5. Trocando o LLM

O Zel usa Claude Code CLI por padrão (`claude --model opus`). Você pode trocar:

- **`--model sonnet`** — mais barato, ainda muito bom (recomendado pra uso intenso)
- **`--model haiku`** — mais barato ainda, bom pra respostas rápidas
- **`--model opus`** — mais caro, melhor pra raciocínio profundo

Edite `start-zel.sh`:
```bash
exec claude \
  -p \
  --model sonnet \    # <-- aqui
  --input-format stream-json \
  ...
```

---

## 6. Multi-user (avançado)

O template é **single-user** por design (gate no `OWNER_WHATSAPP_NUMBER`). Multi-user requer:

- Lookup de número → contexto/persona separados
- Vault separado por usuário (ou um vault com permissões)
- Sessões Claude separadas (uma por usuário, com FIFOs próprias)
- Billing/quota por usuário
- LGPD/privacy considerations

Pull requests de exemplos multi-user são bem-vindos.

---

## 7. Ideias do que automatizar

Pra inspirar:

- **Resumir reuniões** — receba transcrição, monte ata em .docx, mande pros participantes
- **Triagem de email** — categoriza inbox por prioridade, manda resumo 2x dia
- **Tracking de hábitos** — toda noite pergunta "água? exercício? leitura?" e anota
- **Code review** — webhook de PR → Zel revisa e responde no chat
- **Daily journaling** — toda manhã pede 1 linha sobre o dia anterior, anota
- **Customer support triage** — Zendesk webhook → Zel responde Q nível 1, escala restante
- **Smart home** — integrar com Home Assistant via REST API
- **Calendar wrangling** — leia agenda, sugira time-blocking, conflitos
- **Investment tracking** — webhook de corretora → resumo diário
- **Lembretes de remédio** — `reminders.json` com horários fixos

A capacidade do Zel = capacidade do Claude Code + as ferramentas que você configurar. Praticamente tudo que tem API pode ser plugado.

---

## Próximos passos

- Edite `CLAUDE.md` com sua persona
- Configure `.env` com seus dados
- Configure `.mcp.json` com servidores que você quer
- Adicione alguns lembretes/crons iniciais
- Reinicie via `pm2 restart all`
- Mande "oi" e converse pra calibrar

Boa montagem.
