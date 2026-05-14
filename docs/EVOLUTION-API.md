# Evolution API — Configuracao Completa

A Evolution API e o gateway que conecta o WhatsApp ao Zel. Ela roda via Docker e expoe uma API REST para enviar/receber mensagens.

## O que e a Evolution API

- Gateway open-source para WhatsApp (nao oficial)
- Roda via Docker na sua VPS (ou em outra VPS)
- Conecta ao WhatsApp via QR Code (como WhatsApp Web)
- Envia webhooks quando recebe mensagens
- Permite enviar mensagens via REST API

**Repositorio:** https://github.com/EvolutionAPI/evolution-api

## Arquitetura do fluxo

```
WhatsApp (celular)
    |
    v  (protocolo WhatsApp)
Evolution API (Docker, porta 8080)
    |
    v  POST /webhook/zel (JSON com a mensagem)
Nginx (HTTPS, rate limit)
    |
    v  proxy_pass
Zel Server (Express, porta 3333)
    |
    v  (processa com Claude, gera resposta)
    |
    v  POST /message/sendText/Zel
Evolution API
    |
    v  (protocolo WhatsApp)
WhatsApp (celular) — recebe a resposta
```

## Passo 1 — Instalar Evolution API via Docker

### Opcao A: Docker Compose (recomendado)

Crie `~/evolution/docker-compose.yml`:

```yaml
version: '3.9'
services:
  evolution:
    image: atendai/evolution-api:latest
    container_name: evolution-api
    restart: always
    ports:
      - "8080:8080"
    environment:
      # Server
      - SERVER_URL=https://evolution.seu-dominio.com
      - SERVER_TYPE=https

      # Auth
      - AUTHENTICATION_API_KEY=SUA-CHAVE-GLOBAL-AQUI
      - AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=true

      # Webhook global (opcional — nos configuramos por instancia)
      # - WEBHOOK_GLOBAL_URL=
      # - WEBHOOK_GLOBAL_ENABLED=false

      # Database (SQLite padrao, funciona pra uso basico)
      - DATABASE_PROVIDER=sqlite
      - DATABASE_CONNECTION_URI=file:./data/evolution.db

    volumes:
      - evolution_data:/evolution/data
      - evolution_instances:/evolution/instances

volumes:
  evolution_data:
  evolution_instances:
```

```bash
cd ~/evolution
docker compose up -d

# Verificar
docker logs evolution-api --tail 20
# Deve mostrar "Evolution API is running on port 8080"
```

### Opcao B: Docker run direto

```bash
docker run -d \
  --name evolution-api \
  --restart always \
  -p 8080:8080 \
  -e SERVER_URL=https://evolution.seu-dominio.com \
  -e AUTHENTICATION_API_KEY=SUA-CHAVE-GLOBAL-AQUI \
  -e DATABASE_PROVIDER=sqlite \
  -v evolution_data:/evolution/data \
  -v evolution_instances:/evolution/instances \
  atendai/evolution-api:latest
```

## Passo 2 — Nginx para Evolution API

Se o Evolution roda na mesma VPS, adicione um bloco nginx:

```bash
sudo nano /etc/nginx/sites-available/evolution
```

```nginx
server {
    listen 80;
    server_name evolution.seu-dominio.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

```bash
sudo ln -sf /etc/nginx/sites-available/evolution /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# HTTPS
sudo certbot --nginx -d evolution.seu-dominio.com
```

## Passo 3 — Criar instancia WhatsApp

```bash
# Criar instancia "Zel"
curl -X POST 'https://evolution.seu-dominio.com/instance/create' \
  -H 'apikey: SUA-CHAVE-GLOBAL-AQUI' \
  -H 'Content-Type: application/json' \
  -d '{
    "instanceName": "Zel",
    "integration": "WHATSAPP-BAILEYS",
    "qrcode": true
  }'
```

A resposta contem:
- `instance.instanceName`: "Zel"
- `hash.apikey`: **ANOTE ESTA CHAVE** — e a `EVOLUTION_APIKEY` que vai no `.env` do Zel

## Passo 4 — Conectar WhatsApp (QR Code)

```bash
# Gerar QR Code
curl -X GET 'https://evolution.seu-dominio.com/instance/connect/Zel' \
  -H 'apikey: SUA-CHAVE-DA-INSTANCIA'
```

A resposta contem um campo `base64` com o QR Code. Voce pode:

1. **Via API:** Decodificar o base64 e abrir a imagem
2. **Via painel web:** Se a Evolution tem painel, acesse e escaneie direto
3. **Via terminal:** Use um decodificador de QR Code no terminal

Abra o WhatsApp no celular → Dispositivos conectados → Conectar dispositivo → Escaneie o QR Code.

**Verificar conexao:**

```bash
curl -X GET 'https://evolution.seu-dominio.com/instance/connectionState/Zel' \
  -H 'apikey: SUA-CHAVE-DA-INSTANCIA'

# Resposta esperada: {"instance":{"state":"open"}}
```

## Passo 5 — Configurar Webhook

Este e o passo mais importante. O webhook faz o Evolution enviar as mensagens recebidas para o Zel.

```bash
curl -X POST 'https://evolution.seu-dominio.com/webhook/set/Zel' \
  -H 'apikey: SUA-CHAVE-DA-INSTANCIA' \
  -H 'Content-Type: application/json' \
  -d '{
    "webhook": {
      "enabled": true,
      "url": "https://seu-dominio.com/webhook/zel",
      "webhookByEvents": false,
      "webhookBase64": true,
      "events": [
        "messages.upsert"
      ]
    }
  }'
```

**Parametros importantes:**

| Parametro | Valor | Explicacao |
|-----------|-------|-----------|
| `enabled` | `true` | Ativa o webhook |
| `url` | `https://seu-dominio.com/webhook/zel` | URL do Zel server (nginx) |
| `webhookByEvents` | `false` | Envia todos eventos pra mesma URL |
| `webhookBase64` | `true` | **Obrigatorio** — inclui audio em base64 no payload |
| `events` | `["messages.upsert"]` | So envia mensagens novas (nao status, presenca, etc) |

## Passo 6 — Verificar webhook

```bash
# Verificar config do webhook
curl -X GET 'https://evolution.seu-dominio.com/webhook/find/Zel' \
  -H 'apikey: SUA-CHAVE-DA-INSTANCIA'
```

## Como o Zel usa a Evolution API

### Recebendo mensagens (webhook)

O Evolution envia um POST para `/webhook/zel` com este formato:

```json
{
  "event": "messages.upsert",
  "instance": "Zel",
  "data": {
    "key": {
      "remoteJid": "5561999999999@s.whatsapp.net",
      "fromMe": false,
      "id": "3EB0A1B2C3D4E5F6"
    },
    "message": {
      "conversation": "oi, tudo bem?"
    }
  }
}
```

Para audio:

```json
{
  "event": "messages.upsert",
  "instance": "Zel",
  "data": {
    "key": {
      "remoteJid": "5561999999999@s.whatsapp.net",
      "fromMe": false,
      "id": "3EB0A1B2C3D4E5F6"
    },
    "message": {
      "audioMessage": {
        "mimetype": "audio/ogg; codecs=opus",
        "seconds": 15
      }
    }
  }
}
```

O Zel extrai o audio via endpoint `getBase64FromMediaMessage`:

```
POST /chat/getBase64FromMediaMessage/Zel
Body: { "message": { "key": { "remoteJid": "...", "fromMe": false, "id": "..." } } }
Response: { "base64": "UklGRi..." }
```

### Enviando mensagens

O Zel envia respostas via `sendText`:

```bash
POST https://evolution.seu-dominio.com/message/sendText/Zel
Headers:
  apikey: SUA-CHAVE-DA-INSTANCIA
  Content-Type: application/json
Body:
  {
    "number": "5561999999999@s.whatsapp.net",
    "text": "Oi! Tudo sim, como posso ajudar?"
  }
```

**Nota sobre o numero:** O endpoint `sendText` espera o numero com `@s.whatsapp.net`. O Zel adiciona automaticamente o sufixo no `send-whatsapp.js`.

## Docker — IP do container

Se o Evolution roda em Docker na mesma VPS, o IP do container pode ser diferente:

```bash
# Descobrir IP do container
docker inspect evolution-api | grep IPAddress
# Geralmente: 172.17.0.x
```

No `.env` do Zel, use:
- Se nginx faz proxy: `EVOLUTION_URL=https://evolution.seu-dominio.com`
- Se acesso direto: `EVOLUTION_URL=http://172.17.0.2:8080` (ou o IP que `docker inspect` retornar)

## Seguranca

- **API Key por instancia:** Cada instancia tem sua propria API key. Use a key da instancia Zel, nao a global.
- **webhookBase64:** Precisa estar `true` para o Zel receber audio.
- **HTTPS obrigatorio:** Tanto para o webhook do Zel quanto para a Evolution API. Webhooks HTTP (sem S) podem ser interceptados.
- **Rate limit:** O nginx do Zel tem rate limit de 10 req/min. Isso e suficiente para uso pessoal.

## Problemas comuns

| Problema | Causa | Solucao |
|----------|-------|---------|
| Webhook nao chega | URL errada ou nginx nao configurado | Verifique `curl -X POST https://seu-dominio.com/webhook/zel` retorna 200 |
| HTTP 400 no sendText | Numero com `@s.whatsapp.net` duplicado | O `send-whatsapp.js` ja adiciona o sufixo — passe so o numero |
| Audio nao transcreve | `webhookBase64` esta `false` | Reconfigure webhook com `webhookBase64: true` |
| QR Code expirou | Demora >60s | Gere outro com `GET /instance/connect/Zel` |
| Instancia desconectada | WhatsApp deslogou | Reconecte via QR Code |
