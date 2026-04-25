#!/usr/bin/env bash
# Stop everything start.sh started. Targets specific ports/patterns to avoid
# killing unrelated processes you may have running.

set -u

BACKEND_PORT=8001
FRONTEND_PORT=5180

stop_port() {
  local port="$1" label="$2"
  local pids
  pids=$(lsof -i ":$port" -sTCP:LISTEN -t 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill 2>/dev/null
    sleep 0.5
    pids=$(lsof -i ":$port" -sTCP:LISTEN -t 2>/dev/null)
    if [ -n "$pids" ]; then echo "$pids" | xargs kill -9 2>/dev/null; fi
    echo "✗ stopped $label (:$port)"
  else
    echo "· $label not running on :$port"
  fi
}

stop_pattern() {
  local pattern="$1" label="$2"
  if pgrep -f "$pattern" >/dev/null; then
    pkill -f "$pattern"
    sleep 0.5
    pgrep -f "$pattern" >/dev/null && pkill -9 -f "$pattern"
    echo "✗ stopped $label"
  else
    echo "· $label not running"
  fi
}

echo "── stopping CrisisLine stack ──"
stop_port    "$BACKEND_PORT"  "backend"
stop_port    "$FRONTEND_PORT" "frontend"
stop_pattern "ngrok start"    "ngrok"
stop_pattern "cloudflared tunnel --url http://localhost:$FRONTEND_PORT" "cloudflared"
echo "── done ──"
