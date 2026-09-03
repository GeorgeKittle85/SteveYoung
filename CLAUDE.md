# CLAUDE.md

## Read first

**[SECURITY.md](SECURITY.md) governs every change in this repo.** Read it before
editing anything, and work through its pre-merge checklist before committing.
Its rules are grounded in real findings from this codebase, not generic advice —
several of them exist because a plausible-sounding assumption here turned out to
be false under test.

The three that most often get violated by a well-meaning change:

1. `127.0.0.1` is **not** a boundary against containers on this host.
2. Cloudflare Access runs at the **edge**; it does not protect the origin.
3. Never make nginx inject the browser container's credentials — it looks like a
   usability fix and silently re-opens the bypass those credentials exist to close.

## What this repo is

A containerized remote browser published at `px.tinyorbit.org`:

```
Internet -> Cloudflare edge (Access login) -> Cloudflare Tunnel
         -> nginx (127.0.0.1:80) -> px-browser container (127.0.0.1:3000)
```

| File | Role |
| ---- | ---- |
| `docker-compose.browser.yml` | **The production service.** Firefox in a container, digest-pinned, `cap_drop: ALL`, its own basic-auth login |
| `nginx/nginx.conf` | The live reverse proxy config |
| `cloudflare/config.yml` | Tunnel ingress template; the deployed copy is `~/.cloudflared/config-px.yml` |
| `docker-compose.yml` | Local test rig for `nginx.conf` — mock backends, unrelated to production |
| `scripts/` | Setup and lifecycle (`start.sh`, `stop.sh`, `reset-browser.sh`) |
| `.env` | Not committed. `BROWSER_USER` / `BROWSER_PASSWORD` for the container login |

## Working here

- **Two logins are by design.** Access, then the container's basic auth. Do not
  "fix" this.
- **The repo is not the deployment.** `~/.cloudflared/config-px.yml` and
  `/opt/homebrew/etc/nginx/nginx.conf` are the live copies. Changing a file here
  changes nothing until it is deployed; check for drift before assuming.
- **This is a shared host.** Other Cloudflare tunnels run on this Mac
  (`api.tools-for-students.com`, `demo.stardatastorage.com`) pointing at
  `localhost:8000` and `:8020` — they do not route through nginx, but
  `scripts/stop.sh` and `setup-nginx.sh` still act on host-wide services.
- `sudo` requires an interactive password here, so nginx deploys and reloads
  cannot be automated. Hand the user the command instead.

## Verifying a change

Test claims rather than asserting them — for anything security-relevant, run the
check that would have caught the bug:

```bash
docker run --rm -v "$PWD/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" \
  nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 nginx -t
bash -n scripts/*.sh
docker compose config --quiet && docker compose -f docker-compose.browser.yml config --quiet

# The rig must actually serve — "Empty reply from server" means it is broken,
# not that it is correctly dropping an unknown Host.
docker compose up -d && sleep 20
curl -H 'Host: px.tinyorbit.org' http://localhost:8080/health
docker compose ps          # mock-nginx must report (healthy)
docker compose down

# Container capabilities really took effect
docker exec px-browser sh -c 'grep ^CapEff /proc/self/status'   # expect 00000000000000eb
```

## Deploying

```bash
sudo install -m 0644 nginx/nginx.conf /opt/homebrew/etc/nginx/nginx.conf \
  && sudo nginx -t && sudo nginx -s reload
docker compose -f docker-compose.browser.yml up -d --wait
```
