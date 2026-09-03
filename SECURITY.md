# Security rules

Rules every change to this repo must follow. They are not generic best
practice: each one exists because the opposite was true here at some point and
a test caught it. The "why" lines name the actual failure, so the rule can be
argued with rather than cargo-culted.

Audit that produced these: 2026-09-02.

---

## 1. Trust boundaries

### 1.1 `127.0.0.1` is not a boundary against containers on this host

Docker Desktop for Mac NATs `host.docker.internal` into the **host's loopback**.
A `listen 127.0.0.1:80` binding is reachable from every container on this Mac,
and nginx sees those connections as coming from `127.0.0.1`.

- Never justify a missing control with "it only listens on loopback".
- Never treat `allow 127.0.0.1; deny all;` as authentication or as protection
  against local containers. It is not — verified: `/nginx-status` returned 200
  from inside `px-browser` with no spoofing at all.
- If you need a boundary a container cannot cross, use a Unix domain socket, a
  network with no host-gateway route, or real authentication.

*Why: the whole original design rested on this assumption, and it was false.
A container reached nginx with `Host: px.tinyorbit.org` and got a 200,
bypassing Cloudflare Access entirely.*

### 1.2 Edge authentication is not origin authentication

Cloudflare Access is enforced at the Cloudflare edge. Anything reaching the
origin by another path never encounters it.

- Every service exposed through the tunnel must have its own origin-side
  authentication, independent of Access.
- **Never** have nginx inject the origin's credentials into a proxied request.
  That restores the bypass in one line — the proxy would authenticate on the
  attacker's behalf.
- Two login prompts is the intended design, not a bug to smooth away.

### 1.3 Only trust forwarded headers from addresses you control

`real_ip_header CF-Connecting-IP` is safe **only** because Cloudflare's edge
overwrites that header on every inbound request.

- Never add a public range to `set_real_ip_from`.
- Do not uncomment `set_real_ip_from 172.16.0.0/12` unless nginx itself runs in
  Docker and that range really is the tunnel's source. On this host it would
  let any local container spoof client IPs and evade `limit_conn` and every
  IP-based ACL.

---

## 2. Secrets

- Secrets live in `.env` (gitignored, mode `600`) or in `~/.cloudflared/`
  (mode `600`). Never in a tracked file, never in a compose file literal.
- **Never pass a secret as a command-line argument.** `argv` is world-readable
  via `ps`. Use a config file or an environment variable read from one.
  *Why: a `cloudflared` on this host runs with its tunnel token in argv, readable
  by any local process.*
- Credentials files are `600`. Anything that copies one — including backups —
  sets the mode explicitly rather than inheriting a umask.
  *Why: a tunnel credentials file sat at `644`; `cp` does not preserve modes.*
- Mount the **one** credential a service needs, never a whole credentials
  directory. `~/.cloudflared/` also holds `cert.pem`, which is account- and
  zone-level: it can create tunnels and DNS records.
- Before any push, scan the diff for secrets. A placeholder in documentation is
  fine; a real value never is.

---

## 3. Containers

- `cap_drop: [ALL]`, then add back only what is proven necessary. Document why
  each addition is there. Verify with `grep CapEff /proc/self/status` — do not
  assume the list took effect.
- Prefer an image's own configuration switch over granting a capability back.
  *Why: a `mknod` failure after dropping `CAP_MKNOD` turned out to be virtual
  gamepad nodes; `NO_GAMEPAD=true` fixed it without restoring the capability.*
- `no-new-privileges: true` always. Note it does little on its own when the
  container still starts as root with full capabilities — it is not a substitute
  for `cap_drop`.
- Set `mem_limit`, `cpus`, `pids_limit` on anything that renders untrusted
  content.
- Use named volumes, never host bind mounts, for anything a session can write.
- A hardening TODO deferred "until this is confirmed working" is due the day it
  is confirmed working. Do not let it become permanent.

---

## 4. Supply chain

- **Pin every image by digest**, not by tag. `:latest` on a container that
  renders hostile content means an unreviewed image lands on the next pull.
  Record the human-readable tag in a trailing comment.
- Prefer a signed package repository over a direct download. Cloudflare's apt
  repo is GPG-signed; their GitHub release artifacts have no published
  checksums.
- Never pipe an unverified download into a root install. Pin the version, and
  verify a checksum when one can be obtained out of band. If neither is
  possible, say so loudly at run time rather than silently.

---

## 5. nginx

- `add_header` **does not merge**. A location that declares any `add_header`
  replaces the entire inherited set. Re-declare the security headers in every
  location that adds one of its own.
  *Why: `/health` and `/50x.html` silently served no security headers at all.*
- Use `default_type`, not `add_header Content-Type`, with `return`. The latter
  emits two `Content-Type` headers and clients may honour the first.
- Any config change must pass `nginx -t` before it is deployed. Validate in a
  container against the pinned nginx image if you cannot reload locally.
- This config is self-contained: it does not `include` `conf.d/` or
  `sites-enabled/`. Installing it as `/etc/nginx/nginx.conf` takes every other
  site on the host offline. On a shared host, deploy it as an included fragment.

---

## 6. Scripts

- Validate any externally-supplied value before interpolating it into `sed`,
  a shell command, or a path. A `|` breaks out of `s|||` delimiters and an `&`
  expands to the matched text.
- Verify a process's identity before signalling it. A pid file outlives its
  process and PIDs are recycled — check the command name before `kill`, and
  again before escalating to `kill -9`.
- Back up before overwriting, restore on failure, and set the mode on the backup.
- Scripts that stop shared services (`nginx -s quit`) affect everything on the
  host, not just this project. Say so in the script.

---

## 7. Tests and documentation must be honest

- **A test that cannot fail is worse than no test.** It is a false assurance.
  *Why: the Docker rig published a port that reached nothing, so every
  documented command returned `Empty reply from server` — the exact symptom the
  docs described as expected success. It validated nothing for as long as it
  existed.*
- Health checks must reference something that actually exists. Confirm a rig
  reports `healthy`, and confirm a negative test fails for the intended reason.
- Documented commands must be run before they are documented.
- **Do not overstate an isolation guarantee.** State precisely what is and is
  not covered. "The host's filesystem is unreachable" is true here; "the host is
  unreachable" is false — the container reaches the host's SSH, the LAN, and the
  router.
- When a security claim in a comment or doc turns out to be wrong, fix the claim
  in the same change as the code. A stale reassurance is a live hazard.

---

## Pre-merge checklist

- [ ] `nginx -t` passes against the pinned image
- [ ] `bash -n` passes on every changed script
- [ ] `docker compose config --quiet` passes for both compose files
- [ ] Every image is digest-pinned
- [ ] No secret in the diff; `.env` still ignored
- [ ] New containers: `cap_drop: [ALL]`, limits set, `CapEff` verified
- [ ] Any new endpoint has origin-side auth, not just Access
- [ ] Security headers verified on **every** location, not just `/`
- [ ] Claims in comments and docs match tested behaviour
