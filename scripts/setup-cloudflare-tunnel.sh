#!/usr/bin/env bash
# =============================================================================
#  setup-cloudflare-tunnel.sh — install cloudflared, authenticate, create the
#  tunnel, install the config and (optionally) register DNS + a system service.
#
#  Usage:
#    ./scripts/setup-cloudflare-tunnel.sh                     # interactive
#    ./scripts/setup-cloudflare-tunnel.sh -n my-tunnel -d example.com -y
#
#  Options:
#    -n, --name NAME      tunnel name          (default: repo-tunnel)
#    -d, --domain DOMAIN  domain to substitute for example.com in config.yml
#    -y, --yes            assume yes: create DNS records and install the service
#        --no-dns         skip DNS record creation
#        --no-service     skip system service installation
#    -h, --help
#
#  Environment overrides: TUNNEL_NAME, TUNNEL_DOMAIN
#
#  Idempotent: re-running reuses an existing tunnel of the same name and backs
#  up any config it replaces.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_CONFIG="${REPO_ROOT}/cloudflare/config.yml"
CF_DIR="${HOME}/.cloudflared"
DEST_CONFIG="${CF_DIR}/config.yml"

TUNNEL_NAME="${TUNNEL_NAME:-}"
TUNNEL_DOMAIN="${TUNNEL_DOMAIN:-}"
ASSUME_YES=false
DO_DNS=true
DO_SERVICE=true

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

on_error() {
    local code=$?
    err "setup-cloudflare-tunnel.sh failed (exit ${code})"
    exit "${code}"
}
trap on_error ERR

usage() {
    # Print the comment banner at the top of this file, minus the ==== rules.
    awk 'NR>2 && /^# ={10,}/ { exit } NR>2 && /^#/ { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
    exit 0
}

# Ask a yes/no question; honours --yes and non-interactive shells.
confirm() {
    local prompt="$1" reply
    ${ASSUME_YES} && return 0
    [[ -t 0 ]] || { info "${prompt} -> no (non-interactive)"; return 1; }
    read -r -p "$(printf '%s[?]%s %s [y/N] ' "${YELLOW}" "${RESET}" "${prompt}")" reply
    [[ "${reply}" =~ ^[Yy]([Ee][Ss])?$ ]]
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -n|--name)   TUNNEL_NAME="${2:?--name needs a value}"; shift ;;
        -d|--domain) TUNNEL_DOMAIN="${2:?--domain needs a value}"; shift ;;
        -y|--yes)    ASSUME_YES=true ;;
        --no-dns)    DO_DNS=false ;;
        --no-service) DO_SERVICE=false ;;
        -h|--help)   usage ;;
        *)           die "Unknown option: $1 (try --help)" ;;
    esac
    shift
done

SUDO=""
if [[ ${EUID} -ne 0 ]] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

# ---------------------------------------------------------------------------
#  1. Install cloudflared
# ---------------------------------------------------------------------------
step "Checking for cloudflared"
install_cloudflared() {
    local os arch pkg url
    os="$(uname -s)"; arch="$(uname -m)"

    if [[ "${os}" == "Darwin" ]]; then
        command -v brew >/dev/null 2>&1 || die "Install Homebrew, or download cloudflared manually."
        brew install cloudflared
        return
    fi

    case "${arch}" in
        x86_64|amd64) arch=amd64 ;;
        aarch64|arm64) arch=arm64 ;;
        armv7l|armv6l) arch=arm ;;
        i386|i686)     arch=386 ;;
        *) die "Unsupported architecture: ${arch}" ;;
    esac

    # Prefer the native package so the OS can update it later.
    if command -v dpkg >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
        pkg="$(mktemp -t cloudflared-XXXXXX.deb)"
        url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb"
        info "Downloading ${url}"
        curl -fsSL --retry 3 -o "${pkg}" "${url}"
        $SUDO dpkg -i "${pkg}" || { $SUDO apt-get install -f -y && $SUDO dpkg -i "${pkg}"; }
        rm -f "${pkg}"
    elif command -v rpm >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
        pkg="$(mktemp -t cloudflared-XXXXXX.rpm)"
        url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.rpm"
        info "Downloading ${url}"
        curl -fsSL --retry 3 -o "${pkg}" "${url}"
        $SUDO rpm -i --replacepkgs "${pkg}"
        rm -f "${pkg}"
    else
        # Fall back to the raw binary.
        url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}"
        info "Downloading ${url}"
        curl -fsSL --retry 3 -o /tmp/cloudflared "${url}"
        chmod +x /tmp/cloudflared
        $SUDO install -m 0755 /tmp/cloudflared /usr/local/bin/cloudflared
        rm -f /tmp/cloudflared
    fi
}

if command -v cloudflared >/dev/null 2>&1; then
    ok "cloudflared already installed: $(cloudflared --version 2>&1 | head -1)"
else
    warn "cloudflared not found — installing."
    command -v curl >/dev/null 2>&1 || die "curl is required to download cloudflared."
    install_cloudflared
    command -v cloudflared >/dev/null 2>&1 || die "Installation finished but cloudflared is not on PATH."
    ok "Installed $(cloudflared --version 2>&1 | head -1)"
fi

mkdir -p "${CF_DIR}"
chmod 700 "${CF_DIR}"

# ---------------------------------------------------------------------------
#  2. Authenticate
#
#  `cloudflared tunnel login` opens a browser so you can pick the zone to
#  authorise; it writes ~/.cloudflared/cert.pem, which is what lets this host
#  create tunnels and DNS records.
# ---------------------------------------------------------------------------
step "Authenticating with Cloudflare"
if [[ -f "${CF_DIR}/cert.pem" ]]; then
    ok "Already authenticated (${CF_DIR}/cert.pem exists)."
    info "Delete that file and re-run if you need to switch accounts or zones."
else
    cat <<EOF
${BOLD}A browser window will open on Cloudflare's site.${RESET}
Log in, then pick the domain (zone) this tunnel should serve.
On a headless box, copy the printed URL into a browser on another machine.

EOF
    confirm "Open the Cloudflare login now?" || die "Authentication is required. Re-run when ready."
    cloudflared tunnel login
    [[ -f "${CF_DIR}/cert.pem" ]] || die "Login did not produce ${CF_DIR}/cert.pem."
    ok "Authenticated."
fi

# ---------------------------------------------------------------------------
#  3. Create (or reuse) the tunnel
# ---------------------------------------------------------------------------
step "Creating the tunnel"
if [[ -z "${TUNNEL_NAME}" ]]; then
    if [[ -t 0 ]] && ! ${ASSUME_YES}; then
        read -r -p "$(printf '%s[?]%s Tunnel name [repo-tunnel]: ' "${YELLOW}" "${RESET}")" TUNNEL_NAME
    fi
    TUNNEL_NAME="${TUNNEL_NAME:-repo-tunnel}"
fi
info "Tunnel name: ${TUNNEL_NAME}"

# `tunnel list` output columns are ID NAME CREATED CONNECTIONS.
lookup_tunnel_id() {
    cloudflared tunnel list 2>/dev/null \
        | awk -v name="${TUNNEL_NAME}" '$2 == name { print $1; exit }'
}

TUNNEL_ID="$(lookup_tunnel_id || true)"
if [[ -n "${TUNNEL_ID}" ]]; then
    ok "Reusing existing tunnel '${TUNNEL_NAME}' (${TUNNEL_ID})."
else
    cloudflared tunnel create "${TUNNEL_NAME}"
    TUNNEL_ID="$(lookup_tunnel_id || true)"
    [[ -n "${TUNNEL_ID}" ]] || die "Tunnel was created but its ID could not be read from 'cloudflared tunnel list'."
    ok "Created tunnel '${TUNNEL_NAME}' (${TUNNEL_ID})."
fi

CREDS_FILE="${CF_DIR}/${TUNNEL_ID}.json"
[[ -f "${CREDS_FILE}" ]] || warn "Credentials file not found at ${CREDS_FILE} — check 'cloudflared tunnel create' output."
chmod 600 "${CREDS_FILE}" 2>/dev/null || true

# ---------------------------------------------------------------------------
#  4. Install config.yml
# ---------------------------------------------------------------------------
step "Installing ${DEST_CONFIG}"
[[ -f "${SRC_CONFIG}" ]] || die "Source config not found: ${SRC_CONFIG}"

if [[ -f "${DEST_CONFIG}" ]]; then
    BACKUP="${DEST_CONFIG}.backup.$(date +%Y%m%d-%H%M%S)"
    cp -f "${DEST_CONFIG}" "${BACKUP}"
    ok "Backed up existing config to ${BACKUP}"
fi

cp -f "${SRC_CONFIG}" "${DEST_CONFIG}"

# Fill in the values we just discovered. `|` as the sed delimiter keeps paths readable.
sed -i.tmp \
    -e "s|^tunnel: .*|tunnel: ${TUNNEL_ID}|" \
    -e "s|^credentials-file: .*|credentials-file: ${CREDS_FILE}|" \
    "${DEST_CONFIG}" && rm -f "${DEST_CONFIG}.tmp"

if [[ -n "${TUNNEL_DOMAIN}" ]]; then
    sed -i.tmp "s|example\.com|${TUNNEL_DOMAIN}|g" "${DEST_CONFIG}" && rm -f "${DEST_CONFIG}.tmp"
    ok "Substituted domain: ${TUNNEL_DOMAIN}"
else
    warn "No --domain given: hostnames in ${DEST_CONFIG} still say example.com. Edit them before starting the tunnel."
fi

chmod 600 "${DEST_CONFIG}"
ok "Config installed (tunnel=${TUNNEL_ID})."

# `ingress validate` catches an unreachable service or a missing catch-all rule.
if cloudflared tunnel --config "${DEST_CONFIG}" ingress validate; then
    ok "Ingress rules are valid."
else
    warn "Ingress validation reported problems — review ${DEST_CONFIG}."
fi

# ---------------------------------------------------------------------------
#  5. DNS records
#
#  Each hostname needs a CNAME to <tunnel-id>.cfargotunnel.com. `route dns`
#  creates it through the API so you do not have to touch the dashboard.
# ---------------------------------------------------------------------------
HOSTNAMES=()
while IFS= read -r h; do HOSTNAMES+=("${h}"); done < <(
    grep -E '^[[:space:]]*-?[[:space:]]*hostname:' "${DEST_CONFIG}" \
        | sed -E 's/.*hostname:[[:space:]]*//' | tr -d '"' | sort -u
)

step "DNS records"
if ! ${DO_DNS}; then
    info "--no-dns given; skipping."
elif [[ ${#HOSTNAMES[@]} -eq 0 ]]; then
    warn "No hostnames found in ${DEST_CONFIG}."
else
    printf '    Hostnames to route: %s\n' "${HOSTNAMES[*]}"
    if confirm "Create/update the CNAME records for these hostnames now?"; then
        for h in "${HOSTNAMES[@]}"; do
            if cloudflared tunnel route dns "${TUNNEL_NAME}" "${h}"; then
                ok "${h} -> ${TUNNEL_ID}.cfargotunnel.com"
            else
                warn "Could not route ${h}. It may already point elsewhere — see the manual steps below."
            fi
        done
    else
        info "Skipped. Add them by hand (instructions printed at the end)."
    fi
fi

# ---------------------------------------------------------------------------
#  6. Run as a system service
# ---------------------------------------------------------------------------
step "System service"
if ! ${DO_SERVICE}; then
    info "--no-service given; skipping."
elif confirm "Install cloudflared as a system service so the tunnel starts at boot?"; then
    # The installer reads the config from /etc/cloudflared, so copy both files there.
    $SUDO mkdir -p /etc/cloudflared
    $SUDO cp -f "${DEST_CONFIG}" /etc/cloudflared/config.yml
    [[ -f "${CREDS_FILE}" ]] && $SUDO cp -f "${CREDS_FILE}" "/etc/cloudflared/$(basename "${CREDS_FILE}")"
    $SUDO sed -i "s|^credentials-file: .*|credentials-file: /etc/cloudflared/$(basename "${CREDS_FILE}")|" /etc/cloudflared/config.yml
    $SUDO chmod 600 /etc/cloudflared/config.yml "/etc/cloudflared/$(basename "${CREDS_FILE}")" 2>/dev/null || true

    if $SUDO cloudflared service install; then
        if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
            $SUDO systemctl enable --now cloudflared || true
            $SUDO systemctl --no-pager --lines=0 status cloudflared || true
        fi
        ok "Service installed."
    else
        warn "Service install failed — run ./scripts/start-tunnel.sh in the foreground instead."
    fi
else
    info "Skipped. Start the tunnel manually with ./scripts/start-tunnel.sh"
fi

# ---------------------------------------------------------------------------
#  Summary
# ---------------------------------------------------------------------------
cat <<EOF

${GREEN}${BOLD}Cloudflare Tunnel is ready.${RESET}

  ${BOLD}Tunnel name${RESET}   ${TUNNEL_NAME}
  ${BOLD}Tunnel ID${RESET}     ${TUNNEL_ID}
  ${BOLD}Credentials${RESET}   ${CREDS_FILE}
  ${BOLD}Config${RESET}        ${DEST_CONFIG}
  ${BOLD}CNAME target${RESET}  ${TUNNEL_ID}.cfargotunnel.com

${BOLD}Manual DNS setup${RESET} (only if you skipped step 5)
  Cloudflare dashboard -> your domain -> DNS -> Add record
    Type:    CNAME
    Name:    @    (and www, api)
    Target:  ${TUNNEL_ID}.cfargotunnel.com
    Proxy:   Proxied (orange cloud) — required, a grey cloud will not work
  Or from this machine:
    cloudflared tunnel route dns ${TUNNEL_NAME} example.com

${BOLD}Start the tunnel${RESET}
  ./scripts/start-tunnel.sh                 # foreground, easy to watch
  sudo systemctl start cloudflared          # if you installed the service

${BOLD}Verify${RESET}
  cloudflared tunnel info ${TUNNEL_NAME}    # should show 4 active connections
  curl -I https://example.com
  sudo journalctl -u cloudflared -f
EOF
