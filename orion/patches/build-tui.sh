#!/bin/bash
# Build the Hermes TUI component from source.
# Required for the dashboard's embedded chat to work.
set -e

HERMES_SITE="/opt/hermes/venv/lib/python3.13/site-packages"
REPO_DIR="/opt/hermes/repo"

echo "=== Checking Node.js ==="
node --version || { echo "Node.js required. Install with: apt install nodejs npm"; exit 1; }

echo "=== Cloning Hermes repo (if needed) ==="
if [ ! -d "$REPO_DIR/ui-tui" ]; then
    git clone --depth 1 https://github.com/nousresearch/hermes-agent.git "$REPO_DIR"
fi

echo "=== Building TUI ==="
cd "$REPO_DIR/ui-tui"
npm install --silent --no-fund --no-audit
npm run build

echo "=== Installing TUI bundle ==="
mkdir -p "$HERMES_SITE/hermes_cli/tui_dist"
cp dist/entry.js "$HERMES_SITE/hermes_cli/tui_dist/entry.js"

echo "=== Installing ptyprocess ==="
/opt/hermes/venv/bin/pip install ptyprocess 2>/dev/null

echo "=== Done ==="
ls -la "$HERMES_SITE/hermes_cli/tui_dist/entry.js"
