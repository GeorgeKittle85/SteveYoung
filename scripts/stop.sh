#!/usr/bin/env bash
# =============================================================================
#  stop.sh — stop the full local stack: the Cloudflare Tunnel + the browser
#            container + nginx.
#
#  Usage:
#    ./scripts/stop.sh
#
#  Stops the tunnel first so no new public traffic arrives while the rest is
#  going down, then the browser container, then quits nginx gracefully
#  (in-flight requests finish first). Pair with scripts/start.sh.
# =============================================================================
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TUNNEL_PID_FILE="${HOME}/.cloudflared/px-tunnel.pid"
BROWSER_COMPOSE="docker-compose.browser.yml"

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
# A pid file can outlive the process it names, and PIDs get recycled — so
# confirm the process is actually cloudflared before signalling it. Without
# this check a stale pid file makes this script SIGKILL an unrelated process.
is_our_tunnel() {
    local pid="$1"
    [[ -n "${pid}" ]] || return 1
    kill -0 "${pid}" 2>/dev/null || return 1
    ps -o command= -p "${pid}" 2>/dev/null | grep -q 'cloudflared'
}

PID="$(cat "${TUNNEL_PID_FILE}" 2>/dev/null || true)"
if is_our_tunnel "${PID}"; then
    kill "${PID}"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        kill -0 "${PID}" 2>/dev/null || break
        sleep 1
    done
    # Re-check identity before escalating: between SIGTERM and here the pid
    # could have been freed and reused.
    if is_our_tunnel "${PID}"; then
        warn "Tunnel (pid ${PID}) did not exit in time — sending SIGKILL."
        kill -9 "${PID}" 2>/dev/null || true
    fi
    rm -f "${TUNNEL_PID_FILE}"
    ok "Tunnel stopped."
elif [[ -n "${PID}" ]]; then
    warn "Stale pid file: pid ${PID} is not a cloudflared process. Not signalling it."
    rm -f "${TUNNEL_PID_FILE}"
else
    info "Tunnel not running."
    rm -f "${TUNNEL_PID_FILE}"
fi

# ---------------------------------------------------------------------------
#  2. Browser container
# ---------------------------------------------------------------------------
step "Browser container"
if command -v docker >/dev/null 2>&1 && [[ -n "$(docker compose -f "${BROWSER_COMPOSE}" ps --quiet 2>/dev/null)" ]]; then
    docker compose -f "${BROWSER_COMPOSE}" down
    ok "Browser container stopped."
else
    info "Browser container not running."
fi

# ---------------------------------------------------------------------------
#  3. nginx
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
