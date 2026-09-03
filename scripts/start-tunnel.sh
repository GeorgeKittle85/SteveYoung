#!/usr/bin/env bash
# =============================================================================
#  start-tunnel.sh — run the Cloudflare Tunnel in the foreground.
#
#  Usage:
#    ./scripts/start-tunnel.sh                 # uses ~/.cloudflared/config.yml
#    ./scripts/start-tunnel.sh my-tunnel       # run a specific tunnel by name
#    TUNNEL_CONFIG=/etc/cloudflared/config.yml ./scripts/start-tunnel.sh
#
#  Ctrl-C stops it. For an always-on tunnel install the system service instead
#  (see scripts/setup-cloudflare-tunnel.sh) and use `systemctl start cloudflared`.
# =============================================================================
set -euo pipefail

CONFIG="${TUNNEL_CONFIG:-${HOME}/.cloudflared/config.yml}"
TUNNEL_NAME="${1:-${TUNNEL_NAME:-}}"

if [[ -t 1 ]]; then
    RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RESET=$'\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; RESET=''
fi
info() { printf '%s[*]%s %s\n' "${GREEN}"  "${RESET}" "$*"; }
warn() { printf '%s[!]%s %s\n' "${YELLOW}" "${RESET}" "$*" >&2; }
die()  { printf '%s[x]%s %s\n' "${RED}"    "${RESET}" "$*" >&2; exit 1; }

command -v cloudflared >/dev/null 2>&1 \
    || die "cloudflared is not installed. Run ./scripts/setup-cloudflare-tunnel.sh first."

[[ -f "${CONFIG}" ]] \
    || die "Config not found: ${CONFIG}. Run ./scripts/setup-cloudflare-tunnel.sh first."

# The tunnel name/UUID comes from the config file unless one was passed in.
if [[ -z "${TUNNEL_NAME}" ]]; then
    TUNNEL_NAME="$(awk '/^tunnel:/ { print $2; exit }' "${CONFIG}")"
    [[ -n "${TUNNEL_NAME}" ]] || die "No 'tunnel:' key in ${CONFIG} and no name given."
fi

if grep -q 'REPLACE_WITH_TUNNEL_ID' "${CONFIG}"; then
    die "${CONFIG} still contains placeholders. Run ./scripts/setup-cloudflare-tunnel.sh."
fi

# nginx is the origin for every ingress rule — warn early rather than serving 502s.
if command -v curl >/dev/null 2>&1; then
    if ! curl -fsS -m 3 -H 'Host: px.tinyorbit.org' http://127.0.0.1/health >/dev/null 2>&1; then
        warn "nginx did not answer on http://127.0.0.1/health — the tunnel will return 502 until it does."
        warn "Start it with: sudo systemctl start nginx"
    fi
fi

info "Config: ${CONFIG}"
info "Tunnel: ${TUNNEL_NAME}"
info "Starting — press Ctrl-C to stop."
echo

# `exec` hands the process over so Ctrl-C and systemd signals reach cloudflared.
exec cloudflared tunnel --config "${CONFIG}" run "${TUNNEL_NAME}"
