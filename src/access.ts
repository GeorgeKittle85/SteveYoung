/**
 * Cloudflare Access token verification.
 *
 * Access already sits in front of the hostname at the edge, but the Worker
 * verifies the signed JWT again on every request so that the container (the
 * only thing that costs money) can never be reached without a valid identity,
 * whatever happens to routes or Access configuration later. Fail closed.
 *
 * Reference: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AccessIdentity {
  /** Lower-cased email from the token. Used as the relay sharding key. */
  email: string;
  /** Access user id (`sub`). Empty for service tokens, which are rejected anyway. */
  sub: string;
}

const HEADER = "cf-access-jwt-assertion";
const COOKIE = "CF_Authorization";

/** One remote JWKS per team domain, cached for the life of the isolate. */
const jwksCache = new Map<string, JWTVerifyGetKey>();

/** Normalise "myteam.cloudflareaccess.com" or with a trailing slash to the exact `iss` form. */
export function normaliseTeamDomain(teamDomain: string): string {
  const withScheme = /^https?:\/\//i.test(teamDomain) ? teamDomain : `https://${teamDomain}`;
  return withScheme.replace(/\/+$/, "");
}

function remoteJwks(teamDomain: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

/** The token arrives as a header (set by Access at the edge) or as the app cookie. */
export function extractToken(request: Request): string | null {
  const header = request.headers.get(HEADER);
  if (header) return header;
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

export interface VerifyOptions {
  teamDomain: string;
  audience: string;
  /** Override the key source (tests use a local JWKS). */
  jwks?: JWTVerifyGetKey;
}

/**
 * Verify signature, issuer, audience and time claims. Throws on any failure.
 * Only human logins are accepted: a service token has no `email` claim.
 */
export async function verifyAccessToken(token: string, opts: VerifyOptions): Promise<AccessIdentity> {
  const teamDomain = normaliseTeamDomain(opts.teamDomain);
  const { payload } = await jwtVerify(token, opts.jwks ?? remoteJwks(teamDomain), {
    issuer: teamDomain,
    audience: opts.audience,
    algorithms: ["RS256"],
    clockTolerance: 60,
  });
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email) throw new Error("token carries no email claim (service tokens are not accepted)");
  return { email, sub: typeof payload.sub === "string" ? payload.sub : "" };
}
