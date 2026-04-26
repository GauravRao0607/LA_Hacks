#!/usr/bin/env bash
# Start backend, frontend, ngrok, and localhost.run. Logs to /tmp/.
# Idempotent: skips anything already running.

set -u

REPO="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="/tmp/lah-logs"
mkdir -p "$LOG_DIR"

BACKEND_PORT=8001
FRONTEND_PORT=5180

is_listening() {
  lsof -i ":$1" -sTCP:LISTEN -t >/dev/null 2>&1
}

is_running() {
  pgrep -f "$1" >/dev/null 2>&1
}

echo "── starting CrisisLine stack ──"

# Backend
if is_listening "$BACKEND_PORT"; then
  echo "✓ backend already on :$BACKEND_PORT"
else
  ( cd "$REPO/backend" && nohup .venv/bin/uvicorn main:app --port "$BACKEND_PORT" --reload \
    > "$LOG_DIR/backend.log" 2>&1 & )
  echo "→ backend starting on :$BACKEND_PORT (log: $LOG_DIR/backend.log)"
fi

# Frontend
if is_listening "$FRONTEND_PORT"; then
  echo "✓ frontend already on :$FRONTEND_PORT"
else
  ( cd "$REPO/frontend" && nohup npm run dev -- --port "$FRONTEND_PORT" --strictPort \
    > "$LOG_DIR/frontend.log" 2>&1 & )
  echo "→ frontend starting on :$FRONTEND_PORT (log: $LOG_DIR/frontend.log)"
fi

# ngrok (uses ~/Library/Application Support/ngrok/ngrok.yml — has the 'backend' tunnel)
if is_running "ngrok start"; then
  echo "✓ ngrok already running"
else
  nohup ngrok start --all --log=stdout > "$LOG_DIR/ngrok.log" 2>&1 &
  echo "→ ngrok starting (log: $LOG_DIR/ngrok.log)"
fi

# localhost.run (frontend) — tunnels over SSH, works on restrictive networks
LR_PATTERN="ssh -R 80:localhost:$FRONTEND_PORT"
if is_running "$LR_PATTERN"; then
  echo "✓ localhost.run already running"
else
  nohup ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 \
    -R "80:localhost:$FRONTEND_PORT" nokey@localhost.run \
    > "$LOG_DIR/localhostrun.log" 2>&1 &
  echo "→ localhost.run starting (log: $LOG_DIR/localhostrun.log)"
fi

# Wait for tunnels to come up and resolve their URLs.
echo ""
echo "waiting for tunnels..."

NGROK_URL=""
for _ in $(seq 1 20); do
  NGROK_URL=$(curl -s http://localhost:4040/api/tunnels 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); t=[x for x in d.get('tunnels',[]) if x['name']=='backend']; print(t[0]['public_url']) if t else print('')" 2>/dev/null)
  [ -n "$NGROK_URL" ] && break
  sleep 0.5
done

LR_URL=""
for _ in $(seq 1 30); do
  LR_URL=$(grep -oE 'https://[a-z0-9-]+\.lhr\.life' "$LOG_DIR/localhostrun.log" 2>/dev/null | head -1)
  [ -n "$LR_URL" ] && break
  sleep 0.5
done

echo ""
echo "── ready ──"
echo "  Local frontend:   http://localhost:$FRONTEND_PORT"
echo "  Local backend:    http://localhost:$BACKEND_PORT"
[ -n "$NGROK_URL" ] && echo "  Public backend:   $NGROK_URL"
[ -n "$LR_URL" ]    && echo "  Public frontend:  $LR_URL"
[ -z "$NGROK_URL" ] && echo "  ⚠ ngrok URL not detected — check $LOG_DIR/ngrok.log"
[ -z "$LR_URL" ]    && echo "  ⚠ localhost.run URL not detected yet — check $LOG_DIR/localhostrun.log"
echo ""
echo "stop with:  $REPO/stop.sh"
