# Setup VPS — do zero ao Zel rodando

Guia completo pra montar a infra do Zel numa VPS Ubuntu 22+. Estimativa: 1-2 horas se tudo der certo.

---

## Pré-requisitos

- VPS Ubuntu 22.04 LTS+ (1vCPU / 2GB RAM mínimo — DigitalOcean, Hetzner, Vultr)
- Domínio apontado pra IP da VPS (pode ser subdomínio: zel.seu-dominio.com)
- Acesso SSH como root ou sudo
- Conta OpenAI com saldo (~US$1/mês cobre transcrição)
- Conta Anthropic (Claude Code) — gratuito até certo limite, paid acima

---

## 1. Setup inicial da VPS

```bash
# Como root, ou sudo
apt update && apt upgrade -y
apt install -y curl git ufw nginx certbot python3-certbot-nginx

# Firewall
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable

# Crie user dedicado pro Zel (sem sudo)
adduser --disabled-password zel
su - zel
```

## 2. Instale ferramentas (como user `zel`)

```bash
# Node.js 20 via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

# Bun (pros .ts)
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude login   # segue o fluxo OAuth no browser

# PM2 (process manager)
npm install -g pm2
```

## 3. Evolution API (gateway WhatsApp)

Você pode rodar a Evolution na MESMA VPS ou em outra. Recomendado: outra VPS pra isolamento.

### Docker compose básico

```yaml
# ~/evolution/docker-compose.yml
version: "3.8"

services:
  evolution:
    image: atendai/evolution-api:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      - AUTHENTICATION_TYPE=apikey
      - AUTHENTICATION_API_KEY=GERE-COM-openssl-rand-hex-32
      - DATABASE_ENABLED=true
      - DATABASE_PROVIDER=postgresql
      - DATABASE_CONNECTION_URI=postgresql://evo:senha@postgres:5432/evolution
      - DATABASE_CONNECTION_CLIENT_NAME=evolution
      - REDIS_ENABLED=true
      - REDIS_URI=redis://redis:6379
      - QRCODE_LIMIT=30
      - WEBHOOK_GLOBAL_URL=https://SEU-DOMINIO/webhook/zel
      - WEBHOOK_GLOBAL_ENABLED=true
      - WEBHOOK_EVENTS_MESSAGES_UPSERT=true
    depends_on:
      - postgres
      - redis
    volumes:
      - ./instances:/evolution/instances

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: evo
      POSTGRES_PASSWORD: senha
      POSTGRES_DB: evolution
    volumes:
      - pg_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis_data:/data

volumes:
  pg_data:
  redis_data:
```

```bash
docker compose up -d
```

### Criar instância e parear celular

```bash
# Crie a instância
curl -X POST https://evolution.SEU-DOMINIO/instance/create \
  -H "apikey: GLOBAL_APIKEY" \
  -H "Content-Type: application/json" \
  -d '{"instanceName":"Zel","integration":"WHATSAPP-BAILEYS"}'

# Pegue o QR code
curl https://evolution.SEU-DOMINIO/instance/connect/Zel \
  -H "apikey: GLOBAL_APIKEY"
# → imagem base64 do QR. Cola no celular.
```

Anota:
- `EVOLUTION_URL`: https://evolution.SEU-DOMINIO (ou http://localhost:8080)
- `EVOLUTION_INSTANCE`: Zel
- `EVOLUTION_APIKEY`: a apikey da INSTÂNCIA (não a global) — pega no painel da Evolution após criar

## 4. Clone e configure o Zel

```bash
cd ~
git clone https://github.com/SEU_USER/zel-whitelabel.git zel
cd zel
bun install

cp .env.example .env
chmod 600 .env
nano .env
```

Preencha:
```bash
EVOLUTION_URL=https://evolution.SEU-DOMINIO
EVOLUTION_INSTANCE=Zel
EVOLUTION_APIKEY=apikey-da-instancia

OWNER_WHATSAPP_NUMBER=5500000000000  # seu número

OPENAI_API_KEY=sk-...

PORT=3333

VAULT_PATH=/home/zel/vault   # se você usa Obsidian
ZEL_HOME=/home/zel/zel
```

```bash
cp .mcp.json.example .mcp.json
nano .mcp.json   # ajuste paths, habilite/desabilite servidores
```

## 5. (Opcional) Vault Obsidian

```bash
# Se você já tem um vault no GitHub
git clone https://github.com/SEU_USER/seu-vault.git ~/vault
```

Ou crie um vazio:
```bash
mkdir ~/vault
cd ~/vault
git init
echo "# Meu Vault" > README.md
git add . && git commit -m "init"
```

## 6. Personalize CLAUDE.md

```bash
cd ~/zel
nano CLAUDE.md
```

Veja [`CUSTOMIZATION.md`](CUSTOMIZATION.md) pra guia detalhado.

## 7. Nginx + HTTPS

```bash
# Como root
sudo nano /etc/nginx/sites-available/zel
```

```nginx
limit_req_zone $binary_remote_addr zone=zel:10m rate=10r/s;

server {
  listen 80;
  server_name SEU-DOMINIO;
  return 301 https://$server_name$request_uri;
}

server {
  listen 443 ssl http2;
  server_name SEU-DOMINIO;

  ssl_certificate /etc/letsencrypt/live/SEU-DOMINIO/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/SEU-DOMINIO/privkey.pem;

  location /webhook/zel {
    limit_req zone=zel burst=20 nodelay;
    proxy_pass http://127.0.0.1:3333;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # Trigger e plaud só pela rede privada (ajuste seu CIDR)
  location ~ ^/(trigger|webhook/plaud-transcript)$ {
    allow 127.0.0.1;
    # allow IP_da_sua_outra_VPS;
    deny all;
    proxy_pass http://127.0.0.1:3333;
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/zel /etc/nginx/sites-enabled/
sudo nginx -t
sudo certbot --nginx -d SEU-DOMINIO
sudo systemctl reload nginx
```

## 8. Inicie o Zel

```bash
cd ~/zel
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # segue a instrução que aparece

# Verifique
pm2 status
pm2 logs zel-claude --lines 30
```

## 9. Configure webhook na Evolution

Painel Evolution → instância `Zel` → Webhooks → adicionar:
- URL: `https://SEU-DOMINIO/webhook/zel`
- Events: `messages.upsert`
- Webhook Base64 Audio: ON (se for usar áudio)

## 10. Teste

Mande "oi" do número configurado em `OWNER_WHATSAPP_NUMBER`. Você deve receber resposta em segundos.

Se não vier:
1. `pm2 logs zel-webhook` — vê se chegou
2. `pm2 logs zel-claude` — vê se o Claude processou
3. `~/zel/logs/*.log` — erros detalhados

---

## 11. Crons úteis

```bash
crontab -e
```

```cron
# Vault sync (se você usa Obsidian)
*/5 * * * * bash /home/zel/zel/vault-sync.sh >> /home/zel/zel/logs/vault-sync.log 2>&1

# Daily briefing — todo dia útil às 10h
0 10 * * 1-5 cd /home/zel/zel && node proactive.js daily-briefing >> /home/zel/zel/logs/proactive.log 2>&1

# Day review — todo dia útil às 22h
0 22 * * 1-5 cd /home/zel/zel && node proactive.js day-review >> /home/zel/zel/logs/proactive.log 2>&1
```

---

## Troubleshooting básico

Veja [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) pra problemas comuns.

Principais:
- **Webhook não chega** → verifique URL na Evolution, firewall, nginx
- **Áudio não transcreve** → OPENAI_API_KEY válida? saldo na conta?
- **Claude não responde** → `pm2 logs zel-claude`. FIFO existe? (`ls /home/zel/zel/zel-stdin.fifo`)
- **"Permissão negada"** → `chmod 600 .env` e veja owner do diretório
- **Resposta vem duplicada** → dedup pode estar com bug, reinicia PM2

---

## Próximos passos

Tá rodando? Bora personalizar:
- Leia [`CUSTOMIZATION.md`](CUSTOMIZATION.md) pra adaptar a persona
- Leia [`SECURITY.md`](SECURITY.md) e endurece a config
- Adicione integrações (HubSpot, Linear, GitHub, calendário, etc) via MCP

Boa.
