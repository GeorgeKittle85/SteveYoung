// Run with: node --test src/access.test.ts   (Node 22+, type stripping built in)
import { test } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { extractToken, normaliseTeamDomain, verifyAccessToken } from "./access.ts";

const TEAM = "https://example.cloudflareaccess.com";
const AUD = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function fixture() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] });
  const sign = (claims: Record<string, unknown>, opts: { expired?: boolean } = {}) => {
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuedAt()
      .setIssuer(TEAM)
      .setAudience(AUD)
      .setExpirationTime(opts.expired ? "-2h" : "1h");
    return jwt.sign(privateKey);
  };
  return { jwks, sign };
}

test("accepts a valid Access token and lower-cases the email", async () => {
  const { jwks, sign } = await fixture();
  const token = await sign({ email: "Someone@Example.COM", sub: "u1", type: "app" });
  const id = await verifyAccessToken(token, { teamDomain: TEAM, audience: AUD, jwks });
  assert.deepEqual(id, { email: "someone@example.com", sub: "u1" });
});

test("accepts a bare team domain and one with a trailing slash", async () => {
  const { jwks, sign } = await fixture();
  const token = await sign({ email: "a@b.c", sub: "u1" });
  for (const teamDomain of ["example.cloudflareaccess.com", `${TEAM}/`]) {
    const id = await verifyAccessToken(token, { teamDomain, audience: AUD, jwks });
    assert.equal(id.email, "a@b.c");
  }
  assert.equal(normaliseTeamDomain("example.cloudflareaccess.com/"), TEAM);
});

test("rejects the wrong audience", async () => {
  const { jwks, sign } = await fixture();
  const token = await sign({ email: "a@b.c", sub: "u1" });
  await assert.rejects(verifyAccessToken(token, { teamDomain: TEAM, audience: "other-app", jwks }));
});

test("rejects the wrong issuer", async () => {
  const { jwks, sign } = await fixture();
  const token = await sign({ email: "a@b.c", sub: "u1" });
  await assert.rejects(verifyAccessToken(token, { teamDomain: "https://other.cloudflareaccess.com", audience: AUD, jwks }));
});

test("rejects an expired token", async () => {
  const { jwks, sign } = await fixture();
  const token = await sign({ email: "a@b.c", sub: "u1" }, { expired: true });
  await assert.rejects(verifyAccessToken(token, { teamDomain: TEAM, audience: AUD, jwks }));
});

test("rejects a token signed by a different key", async () => {
  const { jwks } = await fixture();
  const other = await fixture();
  const token = await other.sign({ email: "a@b.c", sub: "u1" });
  await assert.rejects(verifyAccessToken(token, { teamDomain: TEAM, audience: AUD, jwks }));
});

test("rejects service tokens (no email claim)", async () => {
  const { jwks, sign } = await fixture();
  const token = await sign({ common_name: "svc.access", sub: "", type: "app" });
  await assert.rejects(verifyAccessToken(token, { teamDomain: TEAM, audience: AUD, jwks }), /email/);
});

test("extractToken prefers the header and falls back to the CF_Authorization cookie", () => {
  const header = new Request("https://px.example/", { headers: { "cf-access-jwt-assertion": "h.h.h", cookie: "CF_Authorization=c.c.c" } });
  assert.equal(extractToken(header), "h.h.h");
  const cookie = new Request("https://px.example/", { headers: { cookie: "a=1; CF_Authorization=c.c.c; b=2" } });
  assert.equal(extractToken(cookie), "c.c.c");
  assert.equal(extractToken(new Request("https://px.example/")), null);
});
