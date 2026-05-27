#!/usr/bin/env python3
"""Auto-refresh Claude OAuth tokens for Hermes gateway.
Runs as cron every 4h. Refreshes token, updates credentials, restarts gateway.
"""
import json, os, sys, time, subprocess

HOME = os.environ.get("HOME", os.path.expanduser("~"))
CRED_PATH = os.path.join(HOME, ".claude", ".credentials.json")
AUTH_PATH = os.path.join(HOME, ".hermes", "auth.json")

sys.path.insert(0, "/opt/hermes/venv/lib/python3.13/site-packages")

from agent.anthropic_adapter import (
    refresh_anthropic_oauth_pure,
    read_claude_code_credentials,
    is_claude_code_token_valid,
)

def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)

def main():
    creds = read_claude_code_credentials()
    if not creds:
        log("ERROR: No Claude credentials found")
        return 1

    if is_claude_code_token_valid(creds):
        exp = creds.get("expiresAt", 0)
        remaining = (exp - int(time.time() * 1000)) / 1000 / 60
        if remaining > 120:
            log(f"Token still valid ({remaining:.0f}min remaining), skipping refresh")
            return 0
        log(f"Token valid but expiring soon ({remaining:.0f}min), refreshing...")
    else:
        log("Token expired, refreshing...")

    refresh_token = creds.get("refreshToken", "")
    if not refresh_token:
        log("ERROR: No refresh token available")
        return 1

    try:
        result = refresh_anthropic_oauth_pure(refresh_token, use_json=False)
    except Exception as e:
        log(f"ERROR: Refresh failed: {e}")
        return 1

    new_access = result["access_token"]
    new_refresh = result["refresh_token"]
    new_expires = result["expires_at_ms"]
    remaining = (new_expires - int(time.time() * 1000)) / 1000 / 60

    log(f"Refreshed! New token: {new_access[:25]}... expires in {remaining:.0f}min")

    # Update Claude Code credentials
    try:
        existing = json.load(open(CRED_PATH)) if os.path.exists(CRED_PATH) else {}
    except Exception:
        existing = {}

    if "claudeAiOauth" not in existing:
        existing["claudeAiOauth"] = {}
    existing["claudeAiOauth"]["accessToken"] = new_access
    existing["claudeAiOauth"]["refreshToken"] = new_refresh
    existing["claudeAiOauth"]["expiresAt"] = new_expires
    if "scopes" not in existing["claudeAiOauth"]:
        existing["claudeAiOauth"]["scopes"] = [
            "user:file_upload", "user:inference", "user:mcp_servers",
            "user:profile", "user:sessions:claude_code"
        ]

    with open(CRED_PATH, "w") as f:
        json.dump(existing, f, indent=2)
    os.chmod(CRED_PATH, 0o600)
    log("Claude credentials updated")

    # Update Hermes auth.json
    try:
        auth = json.load(open(AUTH_PATH)) if os.path.exists(AUTH_PATH) else {}
    except Exception:
        auth = {}

    if "credential_pool" not in auth:
        auth["credential_pool"] = {}
    auth["credential_pool"]["anthropic"] = [{
        "id": "auto_refresh",
        "label": "claude_code_auto",
        "auth_type": "oauth",
        "priority": 0,
        "source": "claude_code",
        "access_token": new_access,
        "refresh_token": new_refresh,
        "last_status": "ok",
        "expires_at_ms": new_expires,
        "request_count": 0,
    }]
    auth["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S+00:00")

    with open(AUTH_PATH, "w") as f:
        json.dump(auth, f, indent=2)
    os.chmod(AUTH_PATH, 0o600)
    log("Hermes auth.json updated")

    log("Done - token refreshed successfully")
    return 0

if __name__ == "__main__":
    sys.exit(main())
