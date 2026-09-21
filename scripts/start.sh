#!/usr/bin/env bash
# =============================================================================
#  start.sh — start the full local stack: nginx + the browser container +
#             the Cloudflare Tunnel.
#
#  Usage:
#    ./scripts/start.sh
#
#  Environment overrides:
#    TUNNEL_CONFIG   path to the tunnel's config.yml (default: ~/.cloudflared/config-px.yml)
#    TUNNEL_LOG      where cloudflared's own log output goes
#
#  Idempotent: running this while the stack is already up leaves it alone.
#  Pair with scripts/stop.sh.
# =============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TUNNEL_CONFIG="${TUNNEL_CONFIG:-${HOME}/.cloudflared/config-px.yml}"
TUNNEL_PID_FILE="${HOME}/.cloudflared/px-tunnel.pid"
TUNNEL_LOG="${TUNNEL_LOG:-${HOME}/.cloudflared/px-tunnel.log}"
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
err()  { printf '%s[x]%s %s\n' "${RED}"    "${RESET}" "$*" >&2; }
step() { printf '\n%s==>%s %s%s%s\n' "${BLUE}" "${RESET}" "${BOLD}" "$*" "${RESET}"; }
die()  { err "$*"; exit 1; }

SUDO=""
if [[ ${EUID} -ne 0 ]]; then
    command -v sudo >/dev/null 2>&1 || die "Run as root, or install sudo."
    SUDO="sudo"
fi

# ---------------------------------------------------------------------------
#  1. nginx
# ---------------------------------------------------------------------------
step "nginx"
command -v nginx >/dev/null 2>&1 || die "nginx is not installed. Run ./scripts/setup-nginx.sh first."

if pgrep -f "nginx: master process" >/dev/null 2>&1; then
    ok "nginx already running."
else
    # nginx.conf logs to /var/log/nginx/, which nothing on macOS owns: Homebrew
    # does not create it and a macOS upgrade removes it again, after which
    # `nginx -t` fails with `open() "/var/log/nginx/error.log" failed (2: No
    # such file or directory)`. setup-nginx.sh creates it on first install;
    # recreate it here so the stack still comes up after the next OS upgrade.
    [[ -d /var/log/nginx ]] || $SUDO mkdir -p /var/log/nginx || die "Could not create /var/log/nginx"
    $SUDO nginx -t || die "nginx config is invalid — run: sudo nginx -t"
    $SUDO nginx
    ok "nginx started."
fi

# ---------------------------------------------------------------------------
#  2. Browser container
# ---------------------------------------------------------------------------
step "Browser container"
command -v docker >/dev/null 2>&1 || die "docker is not installed."

if [[ -n "$(docker compose -f "${BROWSER_COMPOSE}" ps --status running --quiet 2>/dev/null)" ]]; then
    ok "Browser container already running."
else
    docker compose -f "${BROWSER_COMPOSE}" up -d --wait
    ok "Browser container started."
fi

# ---------------------------------------------------------------------------
#  3. Cloudflare Tunnel
# ---------------------------------------------------------------------------
step "Cloudflare Tunnel"
command -v cloudflared >/dev/null 2>&1 || die "cloudflared is not installed. Run ./scripts/setup-cloudflare-tunnel.sh first."
[[ -f "${TUNNEL_CONFIG}" ]] || die "Tunnel config not found: ${TUNNEL_CONFIG}"

if [[ -f "${TUNNEL_PID_FILE}" ]] && kill -0 "$(cat "${TUNNEL_PID_FILE}")" 2>/dev/null; then
    ok "Tunnel already running (pid $(cat "${TUNNEL_PID_FILE}"))."
else
    rm -f "${TUNNEL_PID_FILE}"
    nohup cloudflared tunnel --config "${TUNNEL_CONFIG}" run >>"${TUNNEL_LOG}" 2>&1 &
    echo $! > "${TUNNEL_PID_FILE}"
    disown

    # Give cloudflared a moment to either register connections or die on a bad config.
    sleep 2
    if kill -0 "$(cat "${TUNNEL_PID_FILE}")" 2>/dev/null; then
        ok "Tunnel started (pid $(cat "${TUNNEL_PID_FILE}")). Logging to ${TUNNEL_LOG}"
    else
        rm -f "${TUNNEL_PID_FILE}"
        err "Tunnel failed to start. Last lines of ${TUNNEL_LOG}:"
        tail -n 15 "${TUNNEL_LOG}" >&2 || true
        # The usual cause on this host is a metrics-port clash: the other
        # cloudflared instances here do not pin `metrics:`, so they auto-assign
        # from 20241-20245 and can take a port this tunnel pins. Check with:
        #   lsof -nP -iTCP:<port> -sTCP:LISTEN
        die "Tunnel failed to start — see the log output above."
    fi
fi

# ---------------------------------------------------------------------------
#  4. Smoke test
# ---------------------------------------------------------------------------
step "Smoke test"
if command -v curl >/dev/null 2>&1; then
    if curl -fsS -m 5 -H 'Host: px.tinyorbit.org' http://127.0.0.1/health >/dev/null 2>&1; then
        ok "nginx health check passed (Host: px.tinyorbit.org)."
    else
        warn "nginx did not answer yet. Check: sudo tail -f /var/log/nginx/error.log"
    fi

    # The container answers / with its own basic-auth challenge, so 401 is the
    # healthy response and the only one we accept: a 200 here would mean the
    # origin login is gone and Access is the only thing left guarding it.
    # (`curl -f` is wrong for this check — it treats the correct 401 as failure.)
    browser_code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3000/ || true)"
    case "${browser_code}" in
        401) ok "Browser container responding on 127.0.0.1:3000 (401, origin auth enforced)." ;;
        000) warn "Browser container did not answer. Check: docker logs px-browser" ;;
        *)   warn "Browser container answered ${browser_code}, expected 401 — is its login still configured? Check: docker logs px-browser" ;;
    esac
fi

echo
ok "Stack is up."
info "Stop it with: ./scripts/stop.sh"
