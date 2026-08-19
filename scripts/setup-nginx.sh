#!/usr/bin/env bash
# =============================================================================
#  setup-nginx.sh — install nginx, deploy nginx/nginx.conf, start the service.
#
#  Usage:
#    ./scripts/setup-nginx.sh              # install + deploy + start
#    ./scripts/setup-nginx.sh --dry-run    # show what would happen, change nothing
#    ./scripts/setup-nginx.sh --no-start   # deploy and test, but do not (re)start
#    ./scripts/setup-nginx.sh --help
#
#  Environment overrides:
#    NGINX_CONF_DEST=/etc/nginx/nginx.conf   destination of the config file
#
#  The previous config is backed up first, and automatically restored if
#  `nginx -t` rejects the new one — a failed run never leaves you with a broken
#  nginx.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_CONF="${REPO_ROOT}/nginx/nginx.conf"
DEST_CONF="${NGINX_CONF_DEST:-/etc/nginx/nginx.conf}"
BACKUP_CONF=""
DRY_RUN=false
START_SERVICE=true

# ---------------------------------------------------------------------------
#  Output helpers
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
    RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'
    BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; BOLD=''; RESET=''
fi

info()  { printf '%s[*]%s %s\n' "${BLUE}"   "${RESET}" "$*"; }
ok()    { printf '%s[+]%s %s\n' "${GREEN}"  "${RESET}" "$*"; }
warn()  { printf '%s[!]%s %s\n' "${YELLOW}" "${RESET}" "$*" >&2; }
err()   { printf '%s[x]%s %s\n' "${RED}"    "${RESET}" "$*" >&2; }
step()  { printf '\n%s==>%s %s%s%s\n' "${BLUE}" "${RESET}" "${BOLD}" "$*" "${RESET}"; }
die()   { err "$*"; exit 1; }

# Restore the backup if we bailed out after overwriting the live config.
on_error() {
    local code=$?
    if [[ -n "${BACKUP_CONF}" && -f "${BACKUP_CONF}" ]]; then
        warn "Restoring previous config from ${BACKUP_CONF}"
        $SUDO cp -f "${BACKUP_CONF}" "${DEST_CONF}" || true
    fi
    err "setup-nginx.sh failed (exit ${code})"
    exit "${code}"
}
trap on_error ERR

usage() {
    # Print the comment banner at the top of this file, minus the ==== rules.
    awk 'NR>2 && /^# ={10,}/ { exit } NR>2 && /^#/ { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
    exit 0
}

# ---------------------------------------------------------------------------
#  Arguments
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)  DRY_RUN=true ;;
        --no-start) START_SERVICE=false ;;
        -h|--help)  usage ;;
        *)          die "Unknown option: $1 (try --help)" ;;
    esac
    shift
done

# ---------------------------------------------------------------------------
#  Privilege + platform detection
# ---------------------------------------------------------------------------
SUDO=""
if [[ ${EUID} -ne 0 ]]; then
    command -v sudo >/dev/null 2>&1 || die "Run as root, or install sudo."
    SUDO="sudo"
    info "Not running as root — privileged steps will use sudo."
fi
${DRY_RUN} && SUDO="echo    [dry-run] ${SUDO}"

detect_pkg_manager() {
    for mgr in apt-get dnf yum zypper pacman apk brew; do
        if command -v "${mgr}" >/dev/null 2>&1; then echo "${mgr}"; return; fi
    done
    echo "unknown"
}

# ---------------------------------------------------------------------------
#  1. nginx present?
# ---------------------------------------------------------------------------
step "Checking for nginx"
if command -v nginx >/dev/null 2>&1; then
    ok "nginx already installed: $(nginx -v 2>&1)"
else
    warn "nginx not found — installing."
    PKG="$(detect_pkg_manager)"
    info "Package manager: ${PKG}"
    case "${PKG}" in
        apt-get) $SUDO apt-get update -qq && $SUDO apt-get install -y nginx ;;
        dnf)     $SUDO dnf install -y nginx ;;
        yum)     $SUDO yum install -y nginx ;;
        zypper)  $SUDO zypper --non-interactive install nginx ;;
        pacman)  $SUDO pacman -Sy --noconfirm nginx ;;
        apk)     $SUDO apk add --no-cache nginx ;;
        brew)    brew install nginx ;;   # Homebrew must not run under sudo
        *)       die "No supported package manager found. Install nginx manually, then re-run." ;;
    esac
    if ! ${DRY_RUN}; then
        command -v nginx >/dev/null 2>&1 || die "Installation finished but nginx is still not on PATH."
        ok "Installed $(nginx -v 2>&1)"
    fi
fi

# ---------------------------------------------------------------------------
#  2. Back up whatever is there now
# ---------------------------------------------------------------------------
step "Deploying configuration"
[[ -f "${SRC_CONF}" ]] || die "Source config not found: ${SRC_CONF}"
info "Source:      ${SRC_CONF}"
info "Destination: ${DEST_CONF}"

$SUDO mkdir -p "$(dirname "${DEST_CONF}")"

if [[ -f "${DEST_CONF}" ]]; then
    CANDIDATE="${DEST_CONF}.backup.$(date +%Y%m%d-%H%M%S)"
    if cmp -s "${SRC_CONF}" "${DEST_CONF}"; then
        info "Destination already matches the repo config — nothing to back up."
    else
        $SUDO cp -f "${DEST_CONF}" "${CANDIDATE}"
        ${DRY_RUN} || BACKUP_CONF="${CANDIDATE}"
        ok "Backed up existing config to ${CANDIDATE}"
    fi
fi

$SUDO install -m 0644 "${SRC_CONF}" "${DEST_CONF}"
ok "Config installed."

# Distro packages ship a default vhost that binds :80 as well. This config is
# self-contained (it does not include conf.d/ or sites-enabled/), so those files
# are inert — but say so, because people expect them to be in play.
for d in /etc/nginx/conf.d /etc/nginx/sites-enabled; do
    if [[ -d "${d}" ]] && compgen -G "${d}/*" >/dev/null 2>&1; then
        info "Note: ${d} is NOT included by this config; files there are ignored."
    fi
done

# ---------------------------------------------------------------------------
#  3. Syntax check
# ---------------------------------------------------------------------------
step "Validating configuration"
if ${DRY_RUN}; then
    info "[dry-run] would run: nginx -t"
else
    if $SUDO nginx -t; then
        ok "Configuration is valid."
    else
        die "nginx -t rejected the configuration (previous config will be restored)."
    fi
fi

# ---------------------------------------------------------------------------
#  4. Enable + start
# ---------------------------------------------------------------------------
step "Starting nginx"
if ! ${START_SERVICE}; then
    info "--no-start given; skipping service start."
elif ${DRY_RUN}; then
    info "[dry-run] would enable and (re)start the nginx service."
elif command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    $SUDO systemctl enable nginx  >/dev/null 2>&1 || warn "Could not enable nginx at boot."
    if $SUDO systemctl is-active --quiet nginx; then
        $SUDO systemctl reload nginx || $SUDO systemctl restart nginx
        ok "nginx reloaded."
    else
        $SUDO systemctl start nginx
        ok "nginx started."
    fi
    $SUDO systemctl --no-pager --lines=0 status nginx || true
elif command -v rc-service >/dev/null 2>&1; then           # OpenRC / Alpine
    $SUDO rc-update add nginx default >/dev/null 2>&1 || true
    $SUDO rc-service nginx restart
    ok "nginx started via OpenRC."
elif command -v service >/dev/null 2>&1; then              # SysV
    $SUDO service nginx restart
    ok "nginx started via service(8)."
else
    warn "No init system detected — starting nginx directly."
    $SUDO nginx -s reload 2>/dev/null || $SUDO nginx
fi

# ---------------------------------------------------------------------------
#  5. Smoke test
# ---------------------------------------------------------------------------
if ${START_SERVICE} && ! ${DRY_RUN} && command -v curl >/dev/null 2>&1; then
    step "Smoke test"
    # The default server answers unknown Hosts with 444 (connection closed), so
    # the probe must send a Host header that matches a configured vhost.
    if curl -fsS -m 5 -H 'Host: example.com' http://127.0.0.1/health >/dev/null 2>&1; then
        ok "http://127.0.0.1/health responded (Host: example.com)."
    else
        warn "Health endpoint did not respond yet. Check: journalctl -u nginx -n 50"
    fi
fi

# ---------------------------------------------------------------------------
#  Next steps
# ---------------------------------------------------------------------------
cat <<EOF

${GREEN}${BOLD}nginx is set up.${RESET}

${BOLD}Next steps${RESET}
  1. Replace the placeholder domain:
       sudo sed -i 's/example\.com/yourdomain.com/g' ${DEST_CONF}
       sudo nginx -t && sudo systemctl reload nginx

  2. Start your backends on 127.0.0.1:3000, :3001 and :5000
     (or edit the \`upstream\` blocks in ${DEST_CONF}).

  3. Create the Cloudflare Tunnel:
       ./scripts/setup-cloudflare-tunnel.sh

  4. Keep port 80 closed to the internet — only cloudflared needs it:
       sudo ufw deny 80/tcp        # ufw
       sudo firewall-cmd --remove-service=http --permanent && sudo firewall-cmd --reload

${BOLD}Handy commands${RESET}
  sudo nginx -t                      # validate config
  sudo systemctl reload nginx        # apply changes with zero downtime
  sudo tail -f /var/log/nginx/access.log
  sudo tail -f /var/log/nginx/error.log
  curl -H 'Host: example.com' http://127.0.0.1/health
  curl http://127.0.0.1/nginx-status # active connections / requests
EOF
