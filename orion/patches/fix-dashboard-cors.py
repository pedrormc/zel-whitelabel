"""
Patch Hermes Dashboard to allow external access via reverse proxy.

Fixes:
1. CORS — adds your domain to allowed origins
2. WebSocket auth — adds WS endpoints to public paths (they have own auth)

Usage:
    python3 fix-dashboard-cors.py <your-domain>

Example:
    python3 fix-dashboard-cors.py orion.blackgroup-bia.shop
"""
import sys

if len(sys.argv) < 2:
    print("Usage: python3 fix-dashboard-cors.py <your-domain>")
    sys.exit(1)

domain = sys.argv[1].replace(".", r"\.")
f = "/opt/hermes/venv/lib/python3.13/site-packages/hermes_cli/web_server.py"
lines = open(f).readlines()
patched = 0

for i, line in enumerate(lines):
    # Patch 1: CORS origin regex
    if 'allow_origin_regex' in line and 'localhost' in line and domain.replace(r'\.', '.') not in line:
        old_end = r')(:\d+)?$",'
        new_end = f'|{domain})(:\\d+)?$",'
        lines[i] = line.replace(r')(:\d+)?$",', new_end)
        patched += 1
        print(f"Patched CORS on line {i+1}")

    # Patch 2: WebSocket public paths
    if '"/api/dashboard/plugins/rescan",' in line:
        if i + 1 < len(lines) and '"/api/ws"' not in lines[i + 1]:
            lines.insert(i + 1, '    "/api/ws",\n')
            lines.insert(i + 2, '    "/api/events",\n')
            lines.insert(i + 3, '    "/api/pty",\n')
            lines.insert(i + 4, '    "/api/pub",\n')
            patched += 1
            print(f"Added WebSocket public paths after line {i+1}")
        break

open(f, "w").writelines(lines)
print(f"Done — {patched} patches applied")
