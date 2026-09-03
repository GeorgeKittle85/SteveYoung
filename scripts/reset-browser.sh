#!/usr/bin/env bash
# =============================================================================
#  reset-browser.sh — wipe the browser container back to a clean slate.
#
#  Usage:
#    ./scripts/reset-browser.sh
#
#  Recreates the px-browser container and deletes its config volume, so any
#  downloads, cookies, history or profile changes from prior sessions are
#  gone. The container comes back up immediately with a fresh, empty profile.
#  Everything it touches lives in Docker's own volume storage (never a host
#  bind mount), so this is also the answer to "did anything a visited site
#  did leave a trace on this Mac" — after this runs, no.
# =============================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ -t 1 ]]; then
    GREEN=$'\033[0;32m'; BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
    GREEN=''; BLUE=''; BOLD=''; RESET=''
fi

info() { printf '%s[*]%s %s\n' "${BLUE}"  "${RESET}" "$*"; }
ok()   { printf '%s[+]%s %s\n' "${GREEN}" "${RESET}" "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "${BLUE}" "${RESET}" "${BOLD}" "$*" "${RESET}"; }

step "Resetting the browser container"
info "Stopping px-browser and deleting its config volume..."
docker compose -f docker-compose.browser.yml down -v

info "Starting a fresh container..."
docker compose -f docker-compose.browser.yml up -d --wait

ok "Browser reset — clean profile, no history, no downloads from prior sessions."
