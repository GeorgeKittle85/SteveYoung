/**
 * px — Worker entry point.
 *
 *   browser ──HTTPS──▶ Cloudflare edge (Access login) ──▶ this Worker
 *                                                          ├─▶ Static Assets (UI + proxy runtime)
 *                                                          └─▶ WispRelay container (one WebSocket)
 *
 * This Worker is the only thing between the internet and the container. It
 *   1. answers /health without touching auth or the container,
 *   2. verifies the Cloudflare Access JWT on everything else (fail closed),
 *   3. forwards the Wisp WebSocket to the caller's relay container,
 *   4. serves the browser UI and the vendored proxy runtime.
 *
 * Nothing here fetches, parses or rewrites web pages. That happens inside the
 * user's own browser (Scramjet in a service worker), which is what lets the
 * container be a 1/16-vCPU `lite` instance instead of a 2-vCPU desktop.
 */
import { getContainer } from "@cloudflare/containers";
import { extractToken, verifyAccessToken, type AccessIdentity } from "./access";
import type { Env } from "./env";

export { WispRelay } from "./relay";

/** WebSocket endpoint the browser-side transport connects to. */
const WISP_PATH = "/wisp/";
/** URL prefix Scramjet's service worker owns. Must match public/proxy-setup.js. */
const PROXY_PREFIX = "/scramjet/";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "healthy", service: "px-worker" });
    }

    const identity = await authenticate(request, env);
    if (identity instanceof Response) return identity;

    switch (url.pathname) {
      case WISP_PATH:
        return relayWebSocket(request, env, identity);
      case "/api/whoami":
        return Response.json({ email: identity.email });
      case "/api/relay":
        return relayStatus(env, identity);
    }

    // A proxied URL reaching the Worker means no service worker is controlling
    // this browser (fresh profile, evicted worker, hard reload). Hand back the
    // bootstrap page, which installs it and reloads the same URL.
    if (url.pathname.startsWith(PROXY_PREFIX)) {
      const page = await env.ASSETS.fetch(new Request(new URL("/bootstrap.html", url)));
      return withSecurityHeaders(new Response(page.body, { status: 200, headers: page.headers }));
    }

    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
} satisfies ExportedHandler<Env>;

// -----------------------------------------------------------------------------
//  Authentication
// -----------------------------------------------------------------------------

/** True once both Access values in wrangler.jsonc have been filled in. */
function accessConfigured(env: Env): boolean {
  return Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) && !/REPLACE-ME/.test(env.ACCESS_TEAM_DOMAIN + env.ACCESS_AUD);
}

async function authenticate(request: Request, env: Env): Promise<AccessIdentity | Response> {
  if (!accessConfigured(env)) {
    // Local development only: `.dev.vars` sets ACCESS_DEV_BYPASS=1. The bypass
    // is ignored the moment a real Access policy is configured, so it can
    // never weaken a production deployment.
    if (env.ACCESS_DEV_BYPASS === "1") {
      return { email: "dev@localhost", sub: "dev" };
    }
    console.error("Cloudflare Access is not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD in wrangler.jsonc");
    return new Response("px is not configured yet (missing Cloudflare Access settings).", { status: 503 });
  }

  const token = extractToken(request);
  if (!token) {
    return new Response("Forbidden: no Cloudflare Access token on this request.", { status: 403 });
  }
  try {
    return await verifyAccessToken(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD });
  } catch (err) {
    console.warn("Access token rejected:", err instanceof Error ? err.message : String(err));
    return new Response("Forbidden: invalid Cloudflare Access token.", { status: 403 });
  }
}

// -----------------------------------------------------------------------------
//  Relay routing
// -----------------------------------------------------------------------------

/**
 * Which container a caller lands on. Per-user by default: idle users cost
 * nothing, one user's heavy download cannot starve another's 1/16 vCPU, and
 * the name is a hash so container ids never carry an email address.
 */
async function relayName(identity: AccessIdentity, env: Env): Promise<string> {
  if (env.RELAY_MODE === "shared") return "shared";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity.email));
  const hex = Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `user-${hex}`;
}

async function relayWebSocket(request: Request, env: Env, identity: AccessIdentity): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("This endpoint only accepts WebSocket upgrades.", {
      status: 426,
      headers: { Upgrade: "websocket" },
    });
  }

  // The container never needs the caller's credentials; do not let them cross
  // the boundary.
  const clean = new Request(request);
  for (const h of ["cookie", "authorization", "cf-access-jwt-assertion", "cf-access-authenticated-user-email"]) {
    clean.headers.delete(h);
  }

  const relay = getContainer(env.RELAY, await relayName(identity, env));
  return relay.fetch(clean);
}

/** Lets the UI (and curl) see whether the caller's relay is up, without starting it. */
async function relayStatus(env: Env, identity: AccessIdentity): Promise<Response> {
  const name = await relayName(identity, env);
  try {
    const state = await getContainer(env.RELAY, name).getState();
    return Response.json({ relay: name, ...state });
  } catch (err) {
    console.error("relay status failed:", err);
    return Response.json({ relay: name, error: "relay status unavailable" }, { status: 503 });
  }
}

// -----------------------------------------------------------------------------
//  Response hardening for pages the Worker itself serves
// -----------------------------------------------------------------------------

function withSecurityHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("X-Frame-Options", "SAMEORIGIN");
  out.headers.set("Referrer-Policy", "no-referrer");
  // Cross-origin isolation gives the proxy runtime SharedArrayBuffer (used for
  // synchronous XHR emulation). Same as the upstream Scramjet reference app.
  out.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  out.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return out;
}
