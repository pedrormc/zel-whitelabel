# Troubleshooting

## Auth Issues

### "invalid x-api-key" or "Invalid authentication credentials" (401)

**Cause:** OAuth token expired or bad entry in credential pool.

**Fix:**
```bash
# 1. Re-login
sudo -u <user> HOME=/home/<user> claude login

# 2. Sync credentials
sudo -u <user> HOME=/home/<user> /opt/hermes/venv/bin/python3 /opt/hermes/scripts/refresh-token.py

# 3. Restart gateway
systemctl restart hermes-gateway@<user>
```

### "Still working... (X min elapsed, starting API call #1)"

**Cause:** Gateway stuck — token expired mid-session.

**Fix:** Same as above. Kill stuck gateway first:
```bash
systemctl kill -s SIGKILL hermes-gateway@<user>
systemctl reset-failed hermes-gateway@<user>
# Fix token, then:
systemctl start hermes-gateway@<user>
```

### Token refresh cron not working

**Check logs:**
```bash
cat /home/<user>/.hermes/logs/refresh.log
```

**Verify cron:**
```bash
crontab -u <user> -l
```

**Test manually:**
```bash
sudo -u <user> HOME=/home/<user> /opt/hermes/venv/bin/python3 /opt/hermes/scripts/refresh-token.py
```

## WhatsApp / Evolution Issues

### No messages arriving at gateway

1. Check Evolution webhook URL:
```bash
curl -s "https://your-evolution/webhook/find/YourInstance" -H "apikey: YOUR_KEY"
```

2. Check gateway is listening:
```bash
curl -s http://127.0.0.1:3001/health
```

3. Check gateway logs:
```bash
journalctl -u hermes-gateway@<user> -f
tail -f /home/<user>/.hermes/logs/gateway.log
```

### Messages arrive but no response

Check agent log for API errors:
```bash
tail -30 /home/<user>/.hermes/logs/agent.log | grep -i error
```

### Evolution webhook keeps dying

Evolution pauses webhooks after too many failed deliveries. Reset:
```bash
curl -X POST "https://your-evolution/webhook/set/YourInstance" \
  -H "apikey: YOUR_KEY" -H "Content-Type: application/json" \
  -d '{"webhook":{"url":"https://your-domain/user/","enabled":true,"events":["MESSAGES_UPSERT"]}}'
```

## Dashboard Issues

### "WebSocket connection failed"

Run the CORS + auth patch:
```bash
python3 /opt/zel/orion/patches/fix-dashboard-cors.py your-domain.com
systemctl restart hermes-dashboard-<user>
```

### "[session ended]" in chat

Build the TUI:
```bash
bash /opt/zel/orion/patches/build-tui.sh
systemctl restart hermes-dashboard-<user>
```

### "Chat unavailable: ptyprocess missing"

```bash
/opt/hermes/venv/bin/pip install ptyprocess
systemctl restart hermes-dashboard-<user>
```

### Dashboard shows "Invalid Host header"

Use `--host 0.0.0.0 --insecure` in the dashboard service, and set `proxy_set_header Host localhost:9119;` in nginx.

## Gateway Issues

### Gateway stuck in "deactivating"

Active sessions prevent clean shutdown. Force kill:
```bash
systemctl kill -s SIGKILL hermes-gateway@<user>
systemctl reset-failed hermes-gateway@<user>
systemctl start hermes-gateway@<user>
```

### "No messaging platforms enabled"

The Evolution adapter isn't registered. Check:
```bash
grep evolution /opt/hermes/venv/lib/python3.13/site-packages/gateway/platforms/__init__.py
```

If missing, add the import. Then check `aiohttp` is installed:
```bash
/opt/hermes/venv/bin/pip install aiohttp
```

### Port already in use

Another process or old gateway is using the port:
```bash
lsof -i :<port>
# Kill it, then start the service
```
