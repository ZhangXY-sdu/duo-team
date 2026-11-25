#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${HOME}/.gemini/config/plugins"
TARGET="${PLUGIN_DIR}/duo-team"

echo "==> Installing Duo-Team (Gemini + GPT Multi-Agent Plugin)"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js >= 22.5.0 is required. Please install Node.js first." >&2
  exit 1
fi

node -e '
const [maj, min] = process.versions.node.split(".").map(Number);
if (!(maj > 22 || (maj === 22 && min >= 5))) {
  console.error(`Error: Node.js >= 22.5.0 required (found ${process.versions.node}).`);
  process.exit(1);
}
console.log(`✓ Node.js ${process.versions.node} OK`);
'

if command -v codex >/dev/null 2>&1; then
  echo "✓ Codex CLI found: $(codex --version 2>&1 | head -n 1)"
else
  echo "! Warning: 'codex' CLI not found on PATH."
  echo "  Install OpenAI Codex CLI and sign in with your ChatGPT account (Plus / Pro / Team / Edu / Enterprise):"
  echo "    brew install --cask codex   # or: npm i -g @openai/codex"
  echo "    codex login"
fi

echo "==> Installing dependencies and building server + MCP App UI..."
cd "$REPO_DIR"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
npm run build
chmod +x "${REPO_DIR}/bin/duo-team-server" "${REPO_DIR}/install.sh"

echo "==> Mounting plugin into Antigravity (${TARGET})..."
mkdir -p "$PLUGIN_DIR"
if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
  BACKUP="${TARGET}.backup.$(date +%s)"
  echo "Existing non-symlink directory found; backing up to ${BACKUP}"
  mv "$TARGET" "$BACKUP"
fi
ln -sfn "$REPO_DIR" "$TARGET"

echo ""
echo "✓ Duo-Team installed successfully!"
echo "  1. Open Antigravity (auto-discovers the plugin live; no restart required)."
echo "  2. Open the Duo-Team workbench from the side pane '+' menu or left sidebar."
echo "  3. Pick your preferred GPT model & reasoning effort, then start collaborating!"
