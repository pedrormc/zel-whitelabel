# Troubleshooting

Problemas comuns e soluções rápidas.

---

## Webhook não chega

**Sintomas:** você manda mensagem no WhatsApp e nada acontece.

**Checklist:**
1. `pm2 logs zel-webhook --lines 30` — algum log de webhook recebido?
2. Se SIM mas mensagem ignorada → seu número não bate com `OWNER_WHATSAPP_NUMBER` no `.env`. Confira formato (DDI+DDD+número, sem +, sem espaços)
3. Se NÃO → o webhook não chegou. Checagens:
   - Evolution tá rodando? `docker compose ps` no servidor da Evolution
   - Webhook configurado na instância Evolution? URL bate com nginx?
   - nginx tá proxy_pass correto pra :3333? `sudo nginx -t && sudo systemctl reload nginx`
   - Firewall liberou 443? `sudo ufw status`
   - Certificado SSL válido? `curl -I https://SEU-DOMINIO/health`

---

## Áudio não transcreve

**Sintomas:** texto funciona, áudio retorna "Não consegui transcrever..."

1. `OPENAI_API_KEY` válida? `curl https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY"`
2. Conta OpenAI tem saldo?
3. Evolution tá com `Webhook Base64 Audio: ON`? (no painel da instância)
4. Logs: `pm2 logs zel-webhook | grep -i "transcrib\|whisper"`

---

## Claude não responde

**Sintomas:** webhook chega, mas resposta nunca vem.

1. `pm2 status` — `zel-claude` tá rodando? Se errored, `pm2 restart zel-claude`
2. FIFO existe? `ls -la ~/zel/zel-stdin.fifo` — deve aparecer `prw-...`
3. `pm2 logs zel-claude` — algum erro de auth do Claude?
4. Claude Code instalado e logado? `claude --version && claude doctor`
5. OAuth token expirado? Re-login: `claude logout && claude login`

---

## Mensagem chega duplicada

**Causa provável:** retry da Evolution ou bug na dedup.

1. Verifique se você não tá rodando duas instâncias do PM2: `pm2 list` — só deve ter UM `zel-claude` e UM `zel-webhook`
2. Reinicie tudo: `pm2 restart all`
3. Se persistir, é provável retry da Evolution. Confira nos logs:
   ```bash
   tail -f ~/zel/logs/webhook-out.log | grep -i "dedup\|already"
   ```

---

## "FIFO write failed"

**Causa:** o processo `zel-claude` morreu ou a FIFO não foi criada.

```bash
pm2 status
# Se zel-claude tá "errored" ou "stopped":
pm2 logs zel-claude --lines 50  # ver causa
pm2 restart zel-claude

# Recriar FIFO se necessário:
rm ~/zel/zel-stdin.fifo
mkfifo ~/zel/zel-stdin.fifo
pm2 restart all
```

---

## Resposta sai duplicada

Caso o Claude responda 2x mesmo pra 1 mensagem.

Causas conhecidas:
- Você reiniciou só `zel-webhook` enquanto havia mensagem na FIFO — agora o Claude processa de novo. Solução: `pm2 restart zel-claude` também.
- Tem mais de um Claude conectado à mesma FIFO. `ps aux | grep claude` — deve ter só 1.

---

## "Mensagem muito longa"

A Evolution corta mensagens > 4096 chars. O Zel tem auto-split em 3500 chars. Se mesmo assim cortar:
- Verifique em `whatsapp-mcp.ts` se `MAX_MSG_LENGTH = 3500`
- Se você ajustou pra mais, baixe pra 3000 e teste

---

## Lembrete não dispara

**Caso 1: Reminder.json**
```bash
cat ~/zel/reminders.json
# horário tá no futuro? formato ISO 8601?
pm2 logs zel-reminders --lines 30
```

**Caso 2: Cron**
```bash
crontab -l
grep CRON /var/log/syslog | tail -20   # se você tem permissão
# ou
journalctl -u cron | tail -20
```

---

## "Unauthorized" ao chamar Evolution

`EVOLUTION_APIKEY` errada. Use a key da **INSTÂNCIA**, não a global. Veja no painel da Evolution → instância → settings.

---

## Vault não sincroniza

```bash
cd ~/vault
git status
git pull origin main
# se conflito:
git stash
git pull --rebase origin main
git stash pop  # resolve conflitos manualmente
```

Se `vault-sync.sh` tá quebrando, vê o log: `tail ~/zel/logs/vault-sync.log`

---

## Memória da VPS estourando

Cada processo do Claude usa ~200-400 MB. 2GB de RAM aguenta tranquilo, mas se estourar:

```bash
free -h
top
```

- Reduza `SESSION_MAX_MESSAGES` no `.env` (default 50 → tente 20)
- Use `--model sonnet` em vez de `opus` (mais leve no context window)
- Considere upgrade da VPS pra 4GB

---

## Logs crescendo demais

```bash
du -sh ~/zel/logs/
# Se passou de 100MB:
sudo logrotate -f /etc/logrotate.d/zel
# ou rotate manual:
cd ~/zel/logs
for f in *.log; do
  tail -1000 "$f" > "$f.new"
  mv "$f.new" "$f"
done
pm2 reload all  # reabre os file handles
```

---

## "Permission denied" ao iniciar

Possíveis causas:
- `.env` sem read pra user: `chmod 600 .env`
- `start-zel.sh` sem +x: `chmod +x start-zel.sh`
- FIFO com owner errado: `ls -la zel-stdin.fifo` — deve ser do user que roda PM2

---

## Reinstalação total (último recurso)

```bash
pm2 delete all
pm2 save --force

cd ~/zel
git stash       # preserva seu .env, CLAUDE.md, etc
git pull origin master
bun install --force
git stash pop

pm2 start ecosystem.config.cjs
pm2 save
```

---

## Ainda não resolvido?

1. Abra issue no repo com:
   - Output de `pm2 status`
   - Últimas 30 linhas de cada log
   - Versão do Claude Code: `claude --version`
   - OS: `uname -a`
   - Sem incluir secrets (.env, tokens)

2. Procure issues existentes — alguém pode ter passado pelo mesmo.
