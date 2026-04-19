#!/bin/bash
# start.sh — starts the NBA stats microservice then the Node.js server
# Usage: ./start.sh

set -e

echo "─── NBA Advanced Stats Service ───────────────────────────────────"

# Check Python deps
if ! python3 -c "import flask; import nba_api" 2>/dev/null; then
  echo "Installing Python deps..."
  pip3 install -r requirements_nba.txt --quiet
fi

# Kill any existing nba_service process
pkill -f "python3 nba_service.py" 2>/dev/null || true

# Start Python service in background
echo "[start] Launching nba_service.py on port ${NBA_SERVICE_PORT:-5001}..."
python3 nba_service.py &
NBA_PID=$!

# Wait for it to be ready
echo "[start] Waiting for NBA service..."
for i in $(seq 1 20); do
  if curl -sf "http://localhost:${NBA_SERVICE_PORT:-5001}/health" > /dev/null 2>&1; then
    echo "[start] NBA service is ready."
    break
  fi
  sleep 1
done

echo "─── Node.js Server ───────────────────────────────────────────────"
echo "[start] Launching server.js on port ${PORT:-3000}..."

# Trap to kill Python service when Node exits
trap "echo '[start] Shutting down...'; kill $NBA_PID 2>/dev/null" EXIT

# Start Node server (foreground)
node server.js
