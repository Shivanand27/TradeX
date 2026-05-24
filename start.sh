#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# TradeX — unified dev launcher
# Usage:  ./start.sh
# Stops:  Ctrl+C  (kills both backend and frontend)
# ─────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$ROOT/venv/bin"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
BACKEND_PORT=8001
FRONTEND_PORT=5173

# ── colour helpers ───────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo -e "${CYAN}[tradex]${RESET} $*"; }
ok()   { echo -e "${GREEN}[tradex]${RESET} $*"; }
warn() { echo -e "${YELLOW}[tradex]${RESET} $*"; }
err()  { echo -e "${RED}[tradex]${RESET} $*" >&2; }

# ── cleanup on exit ──────────────────────────────────────────
BACKEND_PID=""
FRONTEND_PID=""
SCHEDULER_PID=""

cleanup() {
    echo ""
    log "Shutting down..."
    [[ -n "$BACKEND_PID"   ]] && kill "$BACKEND_PID"   2>/dev/null && log "Backend stopped"
    [[ -n "$FRONTEND_PID"  ]] && kill "$FRONTEND_PID"  2>/dev/null && log "Frontend stopped"
    [[ -n "$SCHEDULER_PID" ]] && kill "$SCHEDULER_PID" 2>/dev/null && log "Scheduler stopped"
    [[ -n "$BACKEND_PID"   ]] && pkill -P "$BACKEND_PID"   2>/dev/null || true
    [[ -n "$FRONTEND_PID"  ]] && pkill -P "$FRONTEND_PID"  2>/dev/null || true
    [[ -n "$SCHEDULER_PID" ]] && pkill -P "$SCHEDULER_PID" 2>/dev/null || true
    ok "Done. Goodbye."
}
trap cleanup EXIT INT TERM

# ── pre-flight checks ────────────────────────────────────────
if [[ ! -f "$VENV/python" ]]; then
    err "Virtual environment not found at $ROOT/venv"
    err "Run: python3 -m venv venv && venv/bin/pip install -r backend/requirements.txt"
    exit 1
fi

if ! command -v node &>/dev/null; then
    err "Node.js not found. Install via: sudo apt install nodejs npm"
    exit 1
fi

if [[ ! -d "$FRONTEND/node_modules" ]]; then
    warn "node_modules missing — installing frontend deps..."
    cd "$FRONTEND" && npm install --silent
    cd "$ROOT"
fi

# ── check ports ──────────────────────────────────────────────
check_port() {
    if lsof -Pi :"$1" -sTCP:LISTEN -t &>/dev/null; then
        warn "Port $1 already in use — attempting to free it..."
        lsof -ti :"$1" | xargs kill -9 2>/dev/null || true
        sleep 0.5
    fi
}
check_port "$BACKEND_PORT"
check_port "$FRONTEND_PORT"

# ── start backend ────────────────────────────────────────────
log "Starting backend on :${BACKEND_PORT}..."
cd "$BACKEND"
"$VENV/uvicorn" api:app \
    --host 0.0.0.0 \
    --port "$BACKEND_PORT" \
    --reload \
    --log-level warning \
    2>&1 | sed "s/^/${BOLD}[backend]${RESET} /" &
BACKEND_PID=$!
cd "$ROOT"

# Wait for backend to be ready (max 15s)
log "Waiting for backend..."
for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${BACKEND_PORT}/health" &>/dev/null; then
        ok "Backend ready at http://0.0.0.0:${BACKEND_PORT}"
        break
    fi
    sleep 0.5
    if [[ $i -eq 30 ]]; then
        err "Backend did not start within 15s — check logs above"
        exit 1
    fi
done

# ── start scheduler ──────────────────────────────────────────
log "Starting data scheduler..."
cd "$BACKEND"
"$VENV/python" scheduler.py 2>&1 | sed "s/^/${BOLD}[scheduler]${RESET} /" &
SCHEDULER_PID=$!
cd "$ROOT"

# ── start frontend ───────────────────────────────────────────
log "Starting frontend on :${FRONTEND_PORT}..."
cd "$FRONTEND"
npm run dev -- --port "$FRONTEND_PORT" 2>&1 | sed "s/^/${BOLD}[frontend]${RESET} /" &
FRONTEND_PID=$!
cd "$ROOT"

# ── ready ────────────────────────────────────────────────────
sleep 2
echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}  TradeX Terminal is running${RESET}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  Frontend : ${CYAN}http://localhost:${FRONTEND_PORT}${RESET}  /  ${CYAN}http://13.202.31.186:${FRONTEND_PORT}${RESET}"
echo -e "  Backend  : ${CYAN}http://localhost:${BACKEND_PORT}${RESET}  /  ${CYAN}http://13.202.31.186:${BACKEND_PORT}${RESET}"
echo -e "  Docs     : ${CYAN}http://13.202.31.186:${BACKEND_PORT}/docs${RESET}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  Press ${BOLD}Ctrl+C${RESET} to stop both servers"
echo ""

# ── keep alive ───────────────────────────────────────────────
wait "$BACKEND_PID" "$FRONTEND_PID" "$SCHEDULER_PID"
