# Setup guide

nginx reverse proxy behind a Cloudflare Tunnel: public HTTPS for your app
without opening a single inbound port.

- Architecture and request flow: [ARCHITECTURE.md](ARCHITECTURE.md)

## Contents

- [What you get](#what-you-get)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Step-by-step setup](#step-by-step-setup)
- [Configuring DNS in the Cloudflare dashboard](#configuring-dns-in-the-cloudflare-dashboard)
- [Local testing with Docker](#local-testing-with-docker)
- [Customising for your own backends](#customising-for-your-own-backends)
- [Logs and monitoring](#logs-and-monitoring)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)

## What you get

| File | Purpose |
| ---- | ------- |
| `nginx/nginx.conf` | Production nginx config: reverse proxy, rate limiting, WebSockets |
| `cloudflare/config.yml` | Tunnel ingress rules for `example.com`, `www.`, `api.` + catch-all |
| `scripts/setup-nginx.sh` | Installs nginx, deploys the config, validates and starts it |
| `scripts/setup-cloudflare-tunnel.sh` | Installs `cloudflared`, authenticates, creates the tunnel, wires DNS |
| `scripts/start-tunnel.sh` | Runs the tunnel in the foreground |
| `scripts/start.sh` / `scripts/stop.sh` | Idempotent start/stop for the whole local stack (nginx + browser container + tunnel) |
| `scripts/reset-browser.sh` | Wipes the browser container's profile/downloads back to a clean slate |
| `docker-compose.yml` | Local test rig for `nginx.conf` itself, with three mock backends |
| `docker/mock-backend/server.py` | Dependency-free mock backend (HTTP + WebSocket echo) |
| `docker-compose.browser.yml` | **The actual production service**: a containerized, remotely-driven Firefox — see [Remote browser service](#remote-browser-service) below |
| `.env` (not committed) | `BROWSER_USER` / `BROWSER_PASSWORD` — the browser container's own login. Create it yourself; `.gitignore` covers it |

Routing that the shipped config implements by default (the generic template):

| Public URL | Goes to | Notes |
| ---------- | ------- | ----- |
| `example.com/` | `127.0.0.1:3000` + `:3001` | load balanced, `least_conn` |
| `example.com/api/*` | `127.0.0.1:5000` | rate limited to 10 r/s per IP |
| `example.com/ws/*` | `127.0.0.1:3000` + `:3001` | WebSocket upgrade, sticky per client |
| `example.com/*.css`, `*.js`, images… | `127.0.0.1:3000` + `:3001` | cached 30 days |
| `example.com/health` | nginx itself | liveness probe, no backend needed |
| `api.example.com/*` | `127.0.0.1:5000` | the API on its own hostname |
| anything else | — | connection dropped (`444`) |

> The live `px.tinyorbit.org` deployment in this repo has diverged from this
> generic multi-tier template — see [Remote browser service](#remote-browser-service).

## Remote browser service

`px.tinyorbit.org` doesn't run a generic app/api tier — the whole point of
this deployment is a single containerized, web-accessible Firefox
([`lscr.io/linuxserver/firefox`](https://docs.linuxserver.io/images/docker-firefox/))
that a small, known group can drive from a browser tab to get online. Every
byte of actual browsing (page content, downloads, any exploit a malicious
site throws) stays inside that container's own throwaway storage — never the
host's filesystem.

**What that does and does not cover.** The filesystem guarantee is real: the
container has one named Docker volume and no host bind mount, so nothing a
session does becomes a file on this Mac. It is *not* a network boundary. From
inside the container you can reach this Mac's listening services (including
SSH and nginx, via `host.docker.internal`, which Docker Desktop NATs into the
host's **loopback**), every other device on the LAN, the router, and the open
internet. Read the isolation as "the host's filesystem is unreachable", not
"the host is unreachable".

| Piece | What it does |
| ----- | ------------- |
| `docker-compose.browser.yml` | Runs the container, loopback-only (`127.0.0.1:3000`), with resource limits (`4 CPUs` / `3GB` / `512 pids`), `no-new-privileges`, and a **named Docker volume** for `/config` — not a host bind mount, so nothing a session does becomes a file on this Mac |
| `nginx/nginx.conf` | `px.tinyorbit.org`'s server block proxies everything (UI + the WebSocket stream that carries frames/input) straight to that container — see the file's own comments |
| Cloudflare Access | Gates the hostname at the Cloudflare **edge** — email one-time-PIN login, allow-listed via the `Proxy-Users` reusable Access policy in the Zero Trust dashboard. This is the front door, but it only sees traffic that arrives through Cloudflare |
| Container login (`.env`) | The origin-side gate. `CUSTOM_USER` / `PASSWORD` from a gitignored `.env` put HTTP basic auth on the container itself, so reaching port 3000 or nginx directly — which any process on this Mac and any other container can do — is not enough to drive the browser. Expect to enter it once after the Access login |
| `scripts/reset-browser.sh` | One command to wipe the shared profile/downloads/cookies and start clean |

Known v1 limitations, not bugs:

- **One shared session.** Everyone who logs in sees and drives the same
  browser — there's no per-user isolation yet. Fine for a small trusted
  group; a bigger group would want per-user ephemeral containers instead.
- **LAN and host reachability.** The container reaches other devices on the
  local network, the router, and this Mac's own listening services through
  `host.docker.internal` — normal Docker bridge egress, the same as any
  browser on this Mac. The isolation guarantee is specifically "the host's
  filesystem is unreachable," not network segmentation.

### Credentials

`docker-compose.browser.yml` reads the container's login from a `.env` file
beside it. `.gitignore` already covers `.env`, so it never reaches git:

```bash
cat > .env <<'EOF'
BROWSER_USER=px
BROWSER_PASSWORD=<a long random string>
EOF
chmod 600 .env
```

Compose refuses to start without both values rather than silently bringing up
an unauthenticated browser. To rotate, edit `.env` and re-run `up -d`.

Bring it up/down with the rest of the stack via `scripts/start.sh` /
`scripts/stop.sh`, or directly:

```bash
docker compose -f docker-compose.browser.yml up -d --wait
docker compose -f docker-compose.browser.yml down
```

## Prerequisites

- **A Linux host** (Debian/Ubuntu, RHEL/Fedora, Arch, Alpine) or macOS.
  `sudo` access is required.
- **A domain on Cloudflare.** The domain's nameservers must already point at
  Cloudflare — a free plan is enough. Adding a domain:
  <https://dash.cloudflare.com> → *Add a site*.
- **`curl`** (used to download `cloudflared`).
- **Your application** listening on `127.0.0.1:3000`, `:3001` and `:5000`, or
  edit the upstreams (see [Customising](#customising-for-your-own-backends)).
- **A browser** for the one-time Cloudflare login. On a headless server you can
  paste the printed URL into a browser elsewhere.
- *Optional:* Docker + Compose, to try everything locally first.

You do **not** need: a public IP, a port-forward, a TLS certificate, or an open
port 80/443.

## Quick start

```bash
git clone https://github.com/GeorgeKittle85/RandyMoss.git
cd RandyMoss

# 1. nginx
./scripts/setup-nginx.sh

# 2. Cloudflare Tunnel (interactive: opens a browser to log in)
./scripts/setup-cloudflare-tunnel.sh --name repo-tunnel --domain yourdomain.com

# 3. Start it
./scripts/start-tunnel.sh
```

Then open `https://yourdomain.com`.

## Step-by-step setup

### 1. Replace the placeholder domain

Every file uses `example.com`. Swap in your own:

```bash
grep -rl 'example\.com' nginx cloudflare | xargs sed -i 's/example\.com/yourdomain.com/g'
```

> On macOS, `sed -i` needs an argument: `sed -i '' 's/…/…/g'`.

`scripts/setup-cloudflare-tunnel.sh --domain yourdomain.com` does this for the
tunnel config automatically, but the nginx `server_name` directives are yours to
change.

### 2. Install and configure nginx

```bash
./scripts/setup-nginx.sh
```

The script installs nginx if missing, **backs up** any existing
`/etc/nginx/nginx.conf`, installs the repo config, runs `nginx -t`, and starts
the service. If validation fails it **restores your previous config** and exits
non-zero — a failed run never leaves nginx broken.

Useful flags:

```bash
./scripts/setup-nginx.sh --dry-run    # print actions, change nothing
./scripts/setup-nginx.sh --no-start   # deploy and validate only
NGINX_CONF_DEST=/tmp/test.conf ./scripts/setup-nginx.sh   # write elsewhere
```

Verify:

```bash
curl -H 'Host: yourdomain.com' http://127.0.0.1/health
# {"status":"healthy","service":"nginx"}
```

> The `Host` header is required. The default server answers unknown hostnames
> with `444` (drops the connection), so a bare `curl http://127.0.0.1/` returns
> "Empty reply from server" — that is the config working, not a fault.

### 3. Start your backends

nginx expects something on `127.0.0.1:3000`, `:3001` and `:5000`. Until then
you will get `502` — the [Docker rig](#local-testing-with-docker) gives you
stand-ins.

### 4. Create the Cloudflare Tunnel

```bash
./scripts/setup-cloudflare-tunnel.sh --name repo-tunnel --domain yourdomain.com
```

It will:

1. Install `cloudflared` (native `.deb`/`.rpm` where possible, else the binary).
2. Run `cloudflared tunnel login` — **a browser opens**; log in and select your
   domain. This writes `~/.cloudflared/cert.pem`.
3. Create the tunnel (or reuse an existing one with the same name) and record
   its UUID and credentials file.
4. Install `~/.cloudflared/config.yml` with the UUID and credentials path filled
   in, then run `cloudflared tunnel ingress validate`.
5. Offer to create the DNS CNAMEs for every hostname in the config.
6. Offer to install `cloudflared` as a system service so it survives reboots.

Non-interactive (CI, provisioning):

```bash
./scripts/setup-cloudflare-tunnel.sh -n repo-tunnel -d yourdomain.com -y
./scripts/setup-cloudflare-tunnel.sh -n repo-tunnel --no-dns --no-service
```

> `cloudflared tunnel login` always needs a browser once. Automate around it by
> copying an existing `~/.cloudflared/cert.pem` onto the host beforehand.

### 5. Run the tunnel

Foreground, easiest to watch:

```bash
./scripts/start-tunnel.sh
```

As a service (if you accepted step 6 above):

```bash
sudo systemctl start cloudflared
sudo systemctl enable cloudflared
sudo systemctl status cloudflared
```

Confirm connectivity — a healthy tunnel shows **four** connections:

```bash
cloudflared tunnel info repo-tunnel
```

### 6. Verify end to end

```bash
curl -I https://yourdomain.com
curl    https://yourdomain.com/health
curl    https://api.yourdomain.com/
```

## Configuring DNS in the Cloudflare dashboard

`scripts/setup-cloudflare-tunnel.sh` offers to do this for you. To do it by
hand:

1. <https://dash.cloudflare.com> → select your domain → **DNS** → **Records**.
2. **Add record** for each hostname:

   | Type | Name | Target | Proxy status |
   | ---- | ---- | ------ | ------------ |
   | CNAME | `@` | `<TUNNEL-ID>.cfargotunnel.com` | **Proxied** (orange cloud) |
   | CNAME | `www` | `<TUNNEL-ID>.cfargotunnel.com` | **Proxied** |
   | CNAME | `api` | `<TUNNEL-ID>.cfargotunnel.com` | **Proxied** |

3. Get `<TUNNEL-ID>` from `cloudflared tunnel list` (the script also prints it).

Or from the command line:

```bash
cloudflared tunnel route dns repo-tunnel yourdomain.com
cloudflared tunnel route dns repo-tunnel www.yourdomain.com
cloudflared tunnel route dns repo-tunnel api.yourdomain.com
```

**The record must be Proxied (orange cloud).** A grey-cloud (DNS-only) record
hands out `*.cfargotunnel.com`, which does not resolve publicly, and the
hostname will fail to load.

Recommended zone settings, under **SSL/TLS**:

- Encryption mode: **Full** or **Full (strict)**. *Flexible* causes redirect
  loops when an app redirects to HTTPS.
- **Always Use HTTPS**: on.

Anything you add to the `ingress` list in `cloudflare/config.yml` needs its own
DNS record — the tunnel will not serve a hostname that does not resolve to it.

## Local testing with Docker

Runs the **real** `nginx/nginx.conf` against three mock backends, so what you
test is what you deploy. No Cloudflare account needed.

```bash
docker compose up -d --wait
```

The mock backends join nginx's network namespace, so `127.0.0.1:3000/:3001/:5000`
resolve inside the nginx container exactly as on a real host — the config runs
unmodified, with no Docker-specific upstream names.

nginx binds `127.0.0.1:80` inside the container, so a plain `-p 8080:80`
publish would forward to the container's eth0 and reach nothing — every test
would return `Empty reply from server`, which is also what a correctly-dropped
unknown Host looks like. A `socat` sidecar (`mock-portproxy`) relays
`eth0:8080` to `127.0.0.1:80` so the rig actually exercises the config.

nginx is published on **`localhost:8080`**. Every request needs a `Host` header
matching a `server_name` that exists in `nginx.conf` — today that is
`px.tinyorbit.org`:

```bash
# Health (answered by nginx itself)
curl -H 'Host: px.tinyorbit.org' http://localhost:8080/health

# Load balancing — run it a few times, watch "backend" alternate
curl -H 'Host: px.tinyorbit.org' http://localhost:8080/

# Proxy headers actually forwarded (null means nginx is not sending it)
curl -H 'Host: px.tinyorbit.org' http://localhost:8080/ | grep -A9 proxy_headers

# API routing, both ways in
curl -H 'Host: example.com'     http://localhost:8080/api/v1/users
curl -H 'Host: api.example.com' http://localhost:8080/v1/users

# Static caching → Cache-Control: public, max-age=2592000, immutable
curl -I -H 'Host: px.tinyorbit.org' http://localhost:8080/assets/app.css

# Unknown Host is dropped → "Empty reply from server" (444, by design)
curl -H 'Host: nope.test' http://localhost:8080/

# Upstream failover — traffic shifts to app-2, no errors
docker compose stop app-1
curl -H 'Host: px.tinyorbit.org' http://localhost:8080/
docker compose start app-1
```

**Rate limiting** needs concurrency — sequential `curl` calls are slower than
10 r/s and will all return `200`:

```bash
python3 - <<'PY'
import urllib.request, collections, concurrent.futures as cf
def hit(_):
    r = urllib.request.Request("http://localhost:8080/api/test", headers={"Host": "example.com"})
    try:    return urllib.request.urlopen(r, timeout=10).status
    except urllib.error.HTTPError as e: return e.code
with cf.ThreadPoolExecutor(max_workers=60) as ex:
    print(collections.Counter(ex.map(hit, range(60))))
PY
# Counter({429: 39, 200: 21})   <- 1 immediate + 20 burst pass, rest rejected
```

**WebSockets:**

```bash
python3 - <<'PY'
import base64, os, socket
key = base64.b64encode(os.urandom(16)).decode()
s = socket.create_connection(("localhost", 8080), timeout=10)
s.sendall(f"GET /ws/chat HTTP/1.1\r\nHost: example.com\r\nUpgrade: websocket\r\n"
          f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
          f"Sec-WebSocket-Version: 13\r\n\r\n".encode())
print(s.recv(4096).decode(errors="replace").split("\r\n")[0])   # 101 Switching Protocols
PY
```

Applying config changes — **reload, do not restart**:

```bash
docker compose exec nginx nginx -t          # validate first
docker compose exec nginx nginx -s reload   # apply
```

> `docker compose restart nginx` recreates nginx's network namespace and orphans
> the backends that share it, giving you `502`s. Use `nginx -s reload` for config
> changes, or `docker compose down && docker compose up -d --wait` for a clean
> rebuild.

Tear down:

```bash
docker compose down
```

Optionally run the real tunnel against this stack (needs `~/.cloudflared`
already set up):

```bash
docker compose --profile tunnel up
```

## Customising for your own backends

### Different ports

Edit the `upstream` blocks at the top of the `http { }` section in
`nginx/nginx.conf`:

```nginx
upstream app_backend {
    least_conn;
    server 127.0.0.1:8080 max_fails=2 fail_timeout=15s;
    server 127.0.0.1:8081 max_fails=2 fail_timeout=15s;
    keepalive 32;
}
```

Then `sudo nginx -t && sudo systemctl reload nginx`.

### Add another app instance

```nginx
upstream app_backend {
    least_conn;
    server 127.0.0.1:3000 max_fails=2 fail_timeout=15s;
    server 127.0.0.1:3001 max_fails=2 fail_timeout=15s;
    server 127.0.0.1:3002 max_fails=2 fail_timeout=15s;   # new
    keepalive 32;
}
```

Weighted, or a spare that is only used when the others are down:

```nginx
server 127.0.0.1:3002 weight=3;    # gets ~3x the traffic
server 127.0.0.1:3003 backup;      # only when all others fail
```

### Add a route

Insert a new `location` in the `example.com` server block. Use `^~` so the
static-asset regex cannot intercept it:

```nginx
location ^~ /admin/ {
    proxy_pass http://127.0.0.1:9000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $forwarded_proto;

    # Restrict to your own network, for example:
    # allow 10.0.0.0/8;
    # deny all;
}
```

### Add a hostname

Two changes are needed:

1. A `server { server_name new.example.com; … }` block in `nginx/nginx.conf`.
2. An ingress rule in `cloudflare/config.yml`, **above the catch-all**:

   ```yaml
     - hostname: new.example.com
       service: http://localhost:80
       originRequest:
         httpHostHeader: new.example.com
   ```

3. Then create the DNS record:
   `cloudflared tunnel route dns repo-tunnel new.example.com`

### Bypass nginx for one service

Point the ingress rule straight at the process:

```yaml
  - hostname: metrics.example.com
    service: http://localhost:9090
```

### Tune the rate limit

In the `http { }` block:

```nginx
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=30r/s;   # was 10r/s
```

and per location:

```nginx
limit_req zone=api_limit burst=50 nodelay;   # was burst=20
```

Raise `burst` before `rate` — burst absorbs legitimate spikes without raising
the sustained ceiling. Dropping `nodelay` queues excess requests instead of
rejecting them.

### Larger uploads

```nginx
client_max_body_size 100m;   # default here is 25m
```

## Logs and monitoring

### nginx

```bash
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# Which upstream served each request, and how slowly
sudo tail -f /var/log/nginx/access.log | awk '{print $NF, $(NF-3), $(NF-2)}'

# Rate-limited clients
sudo grep 'limiting requests' /var/log/nginx/error.log

# Live connection counters (loopback only)
curl http://127.0.0.1/nginx-status

sudo systemctl status nginx
sudo journalctl -u nginx -n 100 --no-pager
```

The access log format includes `upstream=`, `rt=` (total request time),
`urt=` (upstream response time) and `cf_ray=`. Search a `cf_ray` value in the
Cloudflare dashboard to line an nginx line up with the edge's view of the same
request.

### cloudflared

```bash
sudo journalctl -u cloudflared -f
cloudflared tunnel info repo-tunnel     # connection count and edge locations
cloudflared tunnel list

# Prometheus metrics + readiness (enabled in config.yml)
curl http://127.0.0.1:20241/metrics
curl http://127.0.0.1:20241/ready
```

### Cloudflare dashboard

**Analytics & Logs** → traffic, cached bandwidth, threats blocked.
**Zero Trust → Networks → Tunnels** → tunnel health and connector uptime.

## Troubleshooting

### `502 Bad Gateway`

nginx is up but the backend is not answering.

```bash
curl http://127.0.0.1:3000/          # is the backend actually listening?
sudo ss -tlnp | grep -E ':(3000|3001|5000)'
sudo tail -20 /var/log/nginx/error.log
```

- `connect() failed (111: Connection refused)` — the backend is down, or bound
  to a different interface. A backend listening on `0.0.0.0` or `127.0.0.1` is
  fine; one bound only to a container-internal address is not reachable.
- `no live upstreams` — every backend in the group failed its health check.
  After `max_fails` failures nginx ejects a backend for `fail_timeout` (15s
  here), so it can keep returning `502` for a few seconds *after* you fix the
  backend. Wait it out or reload nginx.

### `Empty reply from server` on `curl http://127.0.0.1/`

Working as intended — unknown `Host` headers get `444`. Send a real one:

```bash
curl -H 'Host: example.com' http://127.0.0.1/health
```

### Cloudflare error 1033 — "Argo Tunnel error"

`cloudflared` is not connected.

```bash
sudo systemctl status cloudflared
sudo journalctl -u cloudflared -n 50 --no-pager
cloudflared tunnel info repo-tunnel
```

### Cloudflare error 1016 — "Origin DNS error"

The DNS record is missing, or points somewhere other than the tunnel.

```bash
dig +short example.com
cloudflared tunnel route dns repo-tunnel example.com
```

Also confirm the record is **Proxied** (orange cloud), not DNS-only.

### Redirect loop (`ERR_TOO_MANY_REDIRECTS`)

SSL/TLS mode is **Flexible** while the app redirects HTTP→HTTPS. Set the zone to
**Full** in the dashboard, and make sure the app trusts `X-Forwarded-Proto`
(nginx sets it) rather than checking the scheme it was reached on.

### WebSockets fail to connect

```bash
# A handshake needs the key and version headers too — without them you get 400.
curl -I -H 'Host: example.com' \
     -H 'Upgrade: websocket' -H 'Connection: Upgrade' \
     -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
     -H 'Sec-WebSocket-Version: 13' \
     http://127.0.0.1/ws/test          # expect: HTTP/1.1 101 Switching Protocols
```

- Confirm the path starts with `/ws/` — the upgrade headers are only set there.
- Enable **Network → WebSockets** in the Cloudflare dashboard (on by default).
- Cloudflare closes idle WebSockets after ~100s. Send application-level pings
  more often than that; nginx's own `proxy_read_timeout` here is 1 hour.

### `429 Too Many Requests`

The `/api/` rate limit is doing its job. Confirm the limit is keyed on real
client IPs rather than the loopback address:

```bash
sudo tail -5 /var/log/nginx/access.log   # first field must be a public IP
```

If it shows `127.0.0.1`, the `set_real_ip_from` / `real_ip_header` block is not
matching, and every visitor shares one bucket. See below.

### Access logs show `127.0.0.1` for every visitor

The `real_ip` block trusts the peer address, so it must list whatever address
`cloudflared` connects from. Loopback is covered by default; under Docker,
uncomment this line in `nginx/nginx.conf`:

```nginx
set_real_ip_from 172.16.0.0/12;
```

Only ever trust addresses you control — trusting a public range would let
anyone spoof `CF-Connecting-IP` and evade the rate limit.

### `nginx -t` fails with `open() "/var/log/nginx/error.log" failed (2: No such file or directory)`

The config writes its logs to `/var/log/nginx/`. Distro packages create that
directory; Homebrew's nginx on macOS does not, and a macOS upgrade has been seen
to remove it again. Recreate it and retry:

```bash
sudo mkdir -p /var/log/nginx
sudo nginx -t
```

`scripts/start.sh` does this itself before starting nginx, so the stack comes
back up after an upgrade without manual steps.

### `nginx -t` fails with `getpwnam("nginx") failed`

The config deliberately omits the `user` directive so nginx falls back to the
account chosen at build time (`www-data` on Debian, `nginx` elsewhere). If you
added a `user` line, make sure that account exists.

### Changes to `nginx.conf` have no effect

Reload, and check you edited the deployed copy, not just the repo one:

```bash
sudo nginx -t && sudo systemctl reload nginx
diff nginx/nginx.conf /etc/nginx/nginx.conf
```

`scripts/setup-nginx.sh` copies the file — it does not symlink it, so a repo
edit needs a re-run (or a manual `cp`).

### `conf.d` / `sites-enabled` files are being ignored

Intentional. This config is self-contained and does not `include` those
directories, so distro defaults cannot bind port 80 and conflict. To use them,
add `include /etc/nginx/conf.d/*.conf;` inside the `http { }` block — and remove
the distro's `default.conf` first, or you will get a duplicate default server.

## Security notes

- **Keep port 80 closed to the internet.** Only `cloudflared` needs to reach
  nginx. If the origin is reachable directly, visitors can bypass Cloudflare's
  WAF entirely.

  ```bash
  sudo ufw deny 80/tcp
  # or
  sudo firewall-cmd --permanent --remove-service=http && sudo firewall-cmd --reload
  ```

  For nginx running directly on the host (not Docker), you can go further and
  bind to loopback only — see the commented `listen 127.0.0.1:80;` in the config.

- **Never commit tunnel credentials.** `~/.cloudflared/*.json` and `cert.pem`
  authenticate as your tunnel and your account. The setup script `chmod 600`s
  them; keep them out of git.

- **`CF-Connecting-IP` is trusted only from listed addresses.** That is what
  makes it safe to key rate limits on. Do not add public ranges to
  `set_real_ip_from`. Note that the commented-out `set_real_ip_from
  172.16.0.0/12` in `nginx.conf` is *not* free either: enabling it lets any
  container on this host spoof `CF-Connecting-IP`, and so evade `limit_conn`
  and any IP-based `allow`/`deny`. Only uncomment it when nginx itself runs in
  Docker and that bridge range is genuinely the tunnel's source address.

- **Loopback is not a boundary against containers on this host.** Docker
  Desktop for Mac NATs `host.docker.internal` into the host's loopback, so a
  `listen 127.0.0.1:80` binding is reachable from any container — nginx even
  sees those connections as `127.0.0.1`, which is why the `allow 127.0.0.1`
  ACL on `/nginx-status` does not exclude them. Consequences:

  - Cloudflare Access is enforced at the Cloudflare **edge**. Anything that
    reaches nginx or port 3000 locally bypasses it entirely.
  - That is precisely why the browser container carries its own
    `CUSTOM_USER`/`PASSWORD` login. Access is the front door; the container
    login is what makes the local path useless to an attacker. Do not remove
    it, and do not have nginx inject the credentials on the proxied request —
    that would hand the bypass straight back.

- **Two gates, deliberately.** Signing in means an Access login *and* the
  container's basic-auth prompt. The second one is the one that still protects
  you if Access is misconfigured, disabled, or bypassed locally.

- **Consider Cloudflare Access** for admin routes — it puts SSO in front of a
  hostname or path with no application changes:
  Zero Trust → Access → Applications.
