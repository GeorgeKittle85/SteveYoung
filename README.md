# px — a private web proxy on Cloudflare Workers + Containers

`px.tinyorbit.org` gives a small, trusted group a browser-in-a-tab that reaches
the web through Cloudflare, gated by Cloudflare Access. This version replaces
the streamed-desktop Firefox container (which needed a 2-vCPU `standard-3`
instance) with a design that runs on the smallest instance Cloudflare offers,
`lite` (1/16 vCPU, 256 MiB).

- How it works and why it is cheap: [ARCHITECTURE.md](ARCHITECTURE.md)
- The previous host-based stack (nginx + cloudflared + Docker on a Mac) is in
  git history at commit `1e3ef27`.

## Contents

- [What changed](#what-changed)
- [What you get](#what-you-get)
- [Cost](#cost)
- [Prerequisites](#prerequisites)
- [Deploy](#deploy)
- [Local development and tests](#local-development-and-tests)
- [Tuning](#tuning)
- [Operating it](#operating-it)
- [Limitations and security model](#limitations-and-security-model)
- [Decommissioning the old stack](#decommissioning-the-old-stack)

## What changed

The old service rendered every page inside a container (Firefox + Xvfb +
KasmVNC) and streamed video of it to the user. Rendering, compositing and
encoding video for a long session burns one to two CPU cores continuously,
which is why it needed `standard-3` and why long sessions were expensive.

The new service moves the work to where it is free: **the user's own browser
renders the page**. The container is reduced to a byte relay (a
[Wisp](https://github.com/MercuryWorkshop/wisp-protocol) server). Measured on
the real relay process (see [tests](#local-development-and-tests)):

| Relay activity                         | CPU cost                       | Memory       |
| -------------------------------------- | ------------------------------ | ------------ |
| Idle, session open                     | ~2 ms of CPU per second (0.2%) | ~75 MB RSS   |
| Page load, 150 requests                | ~0.3 ms of CPU per request     |              |
| Bulk download                          | 7–10 ms of CPU per MB          | ~120 MB peak |
| Sustainable on `lite` (62.5 ms CPU/s)  | ≈ 6–9 MB/s (≈ 50–70 Mbit/s)    | fits 256 MiB |

Above that throughput a `lite` relay is throttled, not broken: transfers slow
down. Normal browsing sits far below it.

## What you get

| Path                       | What it is                                                                      |
| -------------------------- | ------------------------------------------------------------------------------- |
| `wrangler.jsonc`           | The whole deployment: Worker, Static Assets, the container class, Access vars   |
| `src/index.ts`             | Worker: Access JWT check on every request, routes, security headers             |
| `src/access.ts`            | Cloudflare Access token verification (issuer, audience, signature, expiry)      |
| `src/relay.ts`             | `WispRelay` — the Durable Object that owns one container instance              |
| `container/`               | The image: Node 22 + `wisp-js`, ~75 MB RSS, one process                         |
| `public/`                  | The browser UI (`index.html`, `app.js`), service worker, and the vendored proxy runtime (generated: `scram/`, `baremux/`, `epoxy/`) |
| `scripts/sync-vendor.mjs`  | Copies Scramjet, bare-mux and epoxy-transport from `node_modules` into `public/` |
| `scripts/dev-local.mjs`    | UI + relay locally with no Docker or wrangler                                    |
| `scripts/e2e.mjs`          | Headless-Chromium test that browses through the relay and measures its CPU       |
| `src/access.test.ts`       | Unit tests for the Access verifier                                               |

Request flow:

```
user's browser ──HTTPS──▶ Cloudflare edge (Access login) ──▶ Worker
      │                                                       ├─▶ Static Assets: UI + proxy runtime
      │  one WebSocket (/wisp/), carrying every TCP stream    └─▶ WispRelay container (lite)
      └──────────────────────────────────────────────────────────────┘        │ plain TCP
                                                                     destination websites
```

## Cost

Rates are Cloudflare's published Workers Paid rates at the time of writing
(see [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)
and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
Memory and disk are billed on what the instance type provisions; CPU on what
is actually used.

Per hour of one user actively browsing:

| Item                                   | Old: Firefox on `standard-3`                | New: relay on `lite`                          |
| -------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| Memory (provisioned)                   | 8 GiB × 3600 s × $0.0000025 = **$0.072**    | 0.25 GiB × 3600 s × $0.0000025 = **$0.0023**  |
| CPU (used)                             | 1–2 vCPU busy ≈ **$0.07–0.14**              | ≈ 3 vCPU-s ≈ **$0.00006**                     |
| Disk (provisioned)                     | 16 GB ≈ $0.004                              | 2 GB ≈ $0.0005                                |
| Durable Object fronting the WebSocket  | ≈ $0.0056                                   | ≈ $0.0056                                     |
| **Total**                              | **≈ $0.15–0.22**                            | **≈ $0.009**                                  |

The Durable Object line is the same in both designs: every container is
fronted by one, and `@cloudflare/containers` relays the WebSocket through it,
so it is active for the length of the session (128 MB × wall-clock time).

Included monthly usage on the $5 plan covers a lot of this: 25 GiB-hours of
container memory (100 hours of a `lite` relay), 375 vCPU-minutes (thousands
of hours at the measured rate), and 400,000 GB-s of Durable Object time
(about 890 session-hours). A small group is likely to stay inside those.

Idle users cost nothing: a relay is stopped `RELAY_SLEEP_AFTER` after its last
byte, and the next connection starts it again in a few seconds.

## Prerequisites

- A Cloudflare account on the **Workers Paid** plan (Containers require it).
- The zone `tinyorbit.org` on Cloudflare, and a Zero Trust team.
- **Node.js 22+** and **Docker** on the machine you deploy from. `wrangler
  deploy` builds the container image locally and pushes it to Cloudflare's
  registry (Docker Desktop on the Mac is fine).

## Deploy

### 1. Install

```bash
npm install
```

### 2. Cloudflare Access application

Zero Trust dashboard → **Access** → **Applications** → **Add an application**
→ *Self-hosted*:

- Application domain: `px.tinyorbit.org`
- Policy: allow — reuse the existing `Proxy-Users` policy (email one-time PIN,
  allow-listed addresses).
- Session duration: whatever suits; the WebSocket keeps working until the
  cookie expires, then the next page load logs in again.

After saving, open the application's **Overview** and copy the **Application
Audience (AUD) Tag**. Your team domain is `https://<team>.cloudflareaccess.com`.

### 3. Configure

In `wrangler.jsonc`, replace the two placeholders:

```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "https://myteam.cloudflareaccess.com",
  "ACCESS_AUD": "0123…the AUD tag…cdef",
  ...
}
```

The Worker refuses every request with `503` until both are set, and it
verifies the Access JWT itself on every request — Access at the edge is the
front door, the Worker is the lock on the container.

### 4. Remove the old DNS record

`px.tinyorbit.org` currently is a CNAME to the tunnel
(`<tunnel-id>.cfargotunnel.com`). Delete that record (dashboard → DNS), or the
custom domain step below will refuse to claim the name. Also delete the
hostname's ingress rule / public hostname from the old tunnel.

### 5. Deploy

```bash
npx wrangler login
npx wrangler deploy
```

This builds `container/Dockerfile` with Docker, pushes the image, uploads the
Worker and `public/`, and creates the `px.tinyorbit.org` custom domain
(DNS + certificate) automatically. The first container provisioning can take
a few minutes; `/api/relay` reports `"status"` while it happens.

### 6. Verify

Open `https://px.tinyorbit.org`, log in through Access, type an address.
The dot in the toolbar turns green when the service worker and transport are
ready, and shows your email on the right.

From a shell, with an Access service token or a browser cookie:

```bash
curl -I https://px.tinyorbit.org/health         # 200 once Access lets you through
curl https://px.tinyorbit.org/api/relay         # {"relay":"user-…","status":"healthy",…}
```

> `/health` is unauthenticated inside the Worker, but Access still sits in
> front of the hostname. For an uptime monitor, add an Access *Bypass* policy
> for the `/health` path or give the monitor a service token.

## Local development and tests

```bash
npm test                 # typecheck + Access verifier unit tests
npm run build            # vendor the proxy runtime into public/ (also runs on dev/deploy)
```

**Without Docker or wrangler** — the UI and the real relay process, in two
terminals:

```bash
npm run relay            # container/server.mjs on :8080 (set WISP_ALLOW_PRIVATE=1 to reach local sites)
npm run dev:local        # http://127.0.0.1:8787 — public/ + /wisp/ forwarded to the relay
```

**With wrangler** (real Worker code, container too if Docker is running):

```bash
cp .dev.vars.example .dev.vars    # ACCESS_DEV_BYPASS=1, honoured only while Access is unconfigured
npm run dev                       # http://localhost:8787
```

**End to end**: boots a local website, the relay and the UI, then drives
headless Chromium through the proxy and prints the relay's CPU per request
and per MB. Needs Playwright's Chromium (`npx playwright install chromium`).

```bash
npm run test:e2e         # results in e2e-output/results.json + a screenshot
```

## Tuning

| Knob                       | Where             | Default    | Notes                                                                 |
| -------------------------- | ----------------- | ---------- | --------------------------------------------------------------------- |
| `instance_type`            | `wrangler.jsonc`  | `lite`     | `basic` (1/4 vCPU, 1 GiB) if a shared relay or video-heavy use feels throttled |
| `max_instances`            | `wrangler.jsonc`  | `5`        | Cap on relays running at once; with `per-user` mode, users online at once |
| `RELAY_MODE`               | `vars`            | `per-user` | `shared` packs everyone into one relay (cheapest when everyone is online together) |
| `RELAY_SLEEP_AFTER`        | `vars`            | `5m`       | Idle time before a relay stops. Shorter = cheaper, more cold starts    |
| `WISP_MAX_STREAMS`         | container env     | `256`      | Open TCP streams per WebSocket; a runaway page cannot exhaust the relay |
| `SEARCH`                   | `public/app.js`   | DuckDuckGo | Search engine for non-URL input                                        |

Change container environment variables in `src/relay.ts` (`envVars`); a
redeploy rolls the new image out.

## Operating it

```bash
npx wrangler tail                          # live Worker + relay lifecycle logs
npx wrangler containers list               # running instances
npx wrangler deploy --containers-rollout=immediate   # roll a new image to every instance at once
```

Dashboard: **Workers & Pages → px-proxy** for requests and errors,
**Containers** for instance state and resource graphs, **Zero Trust → Logs →
Access** for who logged in.

Access rejections are logged by the Worker with the reason (`wrangler tail`).
A relay that dies is restarted by the next WebSocket; the browser-side
transport reconnects on its own.

## Limitations and security model

**What is isolated.** Nothing runs on the Mac any more. The container sees
only TLS-encrypted bytes (the browser does TLS with the destination); it
cannot read page content, and a proxied page cannot reach the container's
private network (`allow_private_ips` is off) or send mail (port 25 blocked).
Each signed-in user gets their own relay by default.

**What is different from the old design.** Pages now execute in the user's
browser, under the proxy's origin, the way any website's JavaScript does —
inside the browser sandbox, not inside a throwaway container. That is the
standard trade-off every browser-side web proxy makes. Do not use it to visit
sites you would not visit directly.

**Known limitations**

- Some sites do not survive URL/JS rewriting. Scramjet's own list of working
  sites covers Google, YouTube, Discord, Reddit and similar; very hostile
  sites may not.
- Egress comes from Cloudflare's IP space. Sites that dislike datacenter IPs
  (Google search, some captchas) may challenge or block.
- No UDP, so no WebRTC media through the proxy.
- Downloads are saved by the user's own browser, not held in a container.
- Access session expiry closes the WebSocket; the next navigation re-logs in.

**Licences.** Scramjet, epoxy-transport and wisp-js are AGPL-3.0; bare-mux
is MIT. They are shipped unmodified, and the running site links to their
sources at `/credits.html` (generated by `scripts/sync-vendor.mjs`).

## Decommissioning the old stack

On the Mac, after the new deployment works:

```bash
git show 1e3ef27:scripts/stop.sh > /tmp/stop.sh && bash /tmp/stop.sh   # tunnel, browser container, nginx
docker volume rm steveyoung_browser-config                              # the old Firefox profile
```

Then remove `px.tinyorbit.org` from the tunnel's public hostnames and delete
the tunnel if nothing else uses it.
