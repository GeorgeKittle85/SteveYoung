import type { WispRelay } from "./relay";

/** Bindings and variables declared in wrangler.jsonc (plus .dev.vars locally). */
export interface Env {
  /** Static Assets: the browser UI and the vendored proxy runtime under public/. */
  ASSETS: Fetcher;
  /** The relay container class (a Durable Object namespace). */
  RELAY: DurableObjectNamespace<WispRelay>;

  /** Zero Trust team domain, e.g. "https://myteam.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN: string;
  /** Application Audience (AUD) tag of the Access application in front of this hostname. */
  ACCESS_AUD: string;
  /** "1" skips the Access check, but only while Access is not configured. Lives in .dev.vars. */
  ACCESS_DEV_BYPASS?: string;

  /** "per-user" (default) or "shared" — how callers are mapped onto relay containers. */
  RELAY_MODE?: string;
  /** Idle time before a relay container is stopped, e.g. "5m". */
  RELAY_SLEEP_AFTER?: string;
}
