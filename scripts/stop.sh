#!/usr/bin/env bash
# =============================================================================
#  stop.sh — stop the full local stack: the Cloudflare Tunnel + nginx.
#
#  Usage:
#    ./scripts/stop.sh
#
#  Stops the tunnel first so no new public traffic arrives while nginx is
#  going down, then quits nginx gracefully (in-flight requests finish first).
#  Pair with scripts/start.sh.
# =============================================================================
set -uo pipefail

TUNNEL_PID_FILE="${HOME}/.cloudflared/px-tunnel.pid"

if [[ -t 1 ]]; then
    RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'
    BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; BOLD=''; RESET=''
fi

info() { printf '%s[*]%s %s\n' "${BLUE}"   "${RESET}" "$*"; }
ok()   { printf '%s[+]%s %s\n' "${GREEN}"  "${RESET}" "$*"; }
warn() { printf '%s[!]%s %s\n' "${YELLOW}" "${RESET}" "$*" >&2; }
step() { printf '\n%s==>%s %s%s%s\n' "${BLUE}" "${RESET}" "${BOLD}" "$*" "${RESET}"; }

SUDO=""
if [[ ${EUID} -ne 0 ]]; then
    command -v sudo >/dev/null 2>&1 && SUDO="sudo"
fi

FAILED=false

# ---------------------------------------------------------------------------
#  1. Cloudflare Tunnel
# ---------------------------------------------------------------------------
step "Cloudflare Tunnel"
if [[ -f "${TUNNEL_PID_FILE}" ]] && kill -0 "$(cat "${TUNNEL_PID_FILE}")" 2>/dev/null; then
    PID="$(cat "${TUNNEL_PID_FILE}")"
    kill "${PID}"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        kill -0 "${PID}" 2>/dev/null || break
        sleep 1
    done
    if kill -0 "${PID}" 2>/dev/null; then
        warn "Tunnel (pid ${PID}) did not exit in time — sending SIGKILL."
        kill -9 "${PID}" 2>/dev/null || true
    fi
    rm -f "${TUNNEL_PID_FILE}"
    ok "Tunnel stopped."
else
    info "Tunnel not running."
    rm -f "${TUNNEL_PID_FILE}"
fi

# ---------------------------------------------------------------------------
#  2. nginx
# ---------------------------------------------------------------------------
step "nginx"
if pgrep -f "nginx: master process" >/dev/null 2>&1; then
    if $SUDO nginx -s quit; then
        ok "nginx stopped (graceful)."
    else
        warn "Failed to stop nginx (sudo may need an interactive password prompt — run this script directly in a terminal)."
        FAILED=true
    fi
else
    info "nginx not running."
fi

echo
if ${FAILED}; then
    warn "Stack is only partially stopped — see above."
    exit 1
else
    ok "Stack is down."
fi
