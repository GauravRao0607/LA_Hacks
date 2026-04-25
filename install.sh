#!/usr/bin/env bash
# Install system dependencies and configure tunnels.
# Run once before first ./start.sh

set -e

echo "── installing system dependencies ──"
brew install ngrok/ngrok/ngrok cloudflared

echo ""
echo "── configuring ngrok ──"
echo "Paste your ngrok authtoken when prompted:"
read -r -p "ngrok authtoken: " NGROK_TOKEN
ngrok config add-authtoken "$NGROK_TOKEN"

# Add the backend tunnel definition
NGROK_CFG="$HOME/Library/Application Support/ngrok/ngrok.yml"
if ! grep -q "tunnels:" "$NGROK_CFG" 2>/dev/null; then
  cat >> "$NGROK_CFG" <<'EOF'
tunnels:
  backend:
    proto: http
    addr: 8001
EOF
  echo "✓ backend tunnel added to ngrok config"
else
  echo "✓ ngrok tunnels already configured"
fi

echo ""
echo "── done ── run ./start.sh to launch the stack"
