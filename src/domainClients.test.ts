import { test } from "node:test";
import assert from "node:assert/strict";
import type { RequestClient } from "./endpoints.js";
import {
  listDomainClients,
  createDomainClient,
  updateDomainClient,
  rotateDomainClientSecret,
  revokeDomainClientTokens,
  deleteDomainClient,
  rotateDomainSigningKey,
  listTrustedIssuers,
  setTrustedIssuer,
  deleteTrustedIssuer,
  checkTrustedIssuer,
} from "./domainClients.js";

type Call = { method: string; path: string; body?: unknown };

function fakeClient(handler: (call: Call) => unknown = () => ({ ok: true })): RequestClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      return handler({ method, path, body }) as T;
    },
  };
}

const refusing = () =>
  fakeClient(() => {
    throw new Error("should not be called");
  });

test("listDomainClients and listTrustedIssuers read without confirmation", async () => {
  const rc = fakeClient(() => ({ clients: [] }));

  await listDomainClients(rc, 7);
  await listTrustedIssuers(rc, 7);

  assert.deepEqual(rc.calls.map((c) => `${c.method} ${c.path}`), ["GET /api/v1/domains/7/clients", "GET /api/v1/domains/7/issuers"]);
});

test("every credential-changing call previews without a request until confirm:true", async () => {
  const rc = refusing();
  const previews = [
    await createDomainClient(rc, 7, { name: "worker", scopes: "orders:read" }),
    await updateDomainClient(rc, 7, "dcl_a", { active: false }),
    await rotateDomainClientSecret(rc, 7, "dcl_a"),
    await revokeDomainClientTokens(rc, 7, "dcl_a"),
    await deleteDomainClient(rc, 7, "dcl_a"),
    await rotateDomainSigningKey(rc, 7),
    await setTrustedIssuer(rc, 7, "auth0", { issuer: "https://t.auth0.com/", audience: "https://api.shop" }),
    await deleteTrustedIssuer(rc, 7, "auth0"),
  ];

  assert.equal(rc.calls.length, 0);
  for (const p of previews) {
    assert.equal(p.isError, undefined);
    assert.match(p.content[0].text, /Preview/);
    assert.match(p.content[0].text, /confirm:true/);
  }
});

test("createDomainClient: warns the secret is shown once, and never sends active", async () => {
  assert.match((await createDomainClient(refusing(), 7, {})).content[0].text, /ONLY in the reply/);

  const rc = fakeClient(() => ({ clientSecret: "dcs_x" }));
  const result = await createDomainClient(
    rc,
    7,
    { name: "worker", scopes: "a b", tokenLifetimeMinutes: 30, rateLimitPerMinute: 120, active: false },
    true,
  );

  assert.deepEqual(rc.calls[0], {
    method: "POST",
    path: "/api/v1/domains/7/clients",
    body: { name: "worker", scopes: "a b", tokenLifetimeMinutes: 30, rateLimitPerMinute: 120 },
  });
  assert.match(result.content[0].text, /dcs_x/);
});

test("updateDomainClient: a rate limit of 0 is sent as the removal, and the preview says so", async () => {
  const preview = await updateDomainClient(refusing(), 7, "dcl_a", { rateLimitPerMinute: 0 });
  assert.match(preview.content[0].text, /rate limit is removed/);

  const rc = fakeClient();
  await updateDomainClient(rc, 7, "dcl_a", { rateLimitPerMinute: 0 }, true);
  assert.deepEqual(rc.calls[0].body, { rateLimitPerMinute: 0 });
});

test("updateDomainClient: nothing to change is said, not sent", async () => {
  const rc = refusing();
  const result = await updateDomainClient(rc, 7, "dcl_a", {}, true);

  assert.equal(rc.calls.length, 0);
  assert.match(result.content[0].text, /Nothing to update/);
});

test("confirmed calls hit the right routes, with ids encoded as one path segment", async () => {
  const rc = fakeClient();

  await updateDomainClient(rc, 7, "dcl_a/b", { active: true }, true);
  await rotateDomainClientSecret(rc, 7, "dcl_a", true);
  await revokeDomainClientTokens(rc, 7, "dcl_a", true);
  await deleteDomainClient(rc, 7, "dcl_a", true);
  await rotateDomainSigningKey(rc, 7, true);
  await setTrustedIssuer(rc, 7, "auth0", { issuer: "https://t.auth0.com/", audience: "aud", scopeClaim: "permissions" }, true);
  await deleteTrustedIssuer(rc, 7, "auth0", true);

  assert.deepEqual(rc.calls.map((c) => `${c.method} ${c.path}`), [
    "PATCH /api/v1/domains/7/clients/dcl_a%2Fb",
    "POST /api/v1/domains/7/clients/dcl_a/rotate-secret",
    "POST /api/v1/domains/7/clients/dcl_a/revoke-tokens",
    "DELETE /api/v1/domains/7/clients/dcl_a",
    "POST /api/v1/domains/7/signing-keys/rotate",
    "PUT /api/v1/domains/7/issuers/auth0",
    "DELETE /api/v1/domains/7/issuers/auth0",
  ]);
  assert.deepEqual(rc.calls[5].body, { issuer: "https://t.auth0.com/", audience: "aud", scopeClaim: "permissions" });
});

test("a 204 from a revoke or delete still reads as a success sentence", async () => {
  const rc = fakeClient(() => undefined);

  const revoked = await revokeDomainClientTokens(rc, 7, "dcl_a", true);
  const deleted = await deleteTrustedIssuer(rc, 7, "auth0", true);

  assert.match(revoked.content[0].text, /Revoked/);
  assert.match(deleted.content[0].text, /no longer trusts/);
});

test("checkTrustedIssuer probes without a token and checks with one", async () => {
  const rc = fakeClient(() => ({ accepted: false, failure: "token.audience_mismatch" }));

  await checkTrustedIssuer(rc, 7, "auth0");
  const checked = await checkTrustedIssuer(rc, 7, "auth0", "eyJ.x.y");

  assert.deepEqual(rc.calls[0], { method: "POST", path: "/api/v1/domains/7/issuers/auth0/probe", body: undefined });
  assert.deepEqual(rc.calls[1], { method: "POST", path: "/api/v1/domains/7/issuers/auth0/check", body: { token: "eyJ.x.y" } });
  assert.match(checked.content[0].text, /audience_mismatch/);
});

test("a failed request is an error result, not a thrown exception", async () => {
  const rc = fakeClient(() => {
    throw new Error("400 issuer.audience_required");
  });

  const result = await setTrustedIssuer(rc, 7, "auth0", { issuer: "https://t.auth0.com/", audience: "" }, true);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /audience_required/);
});

test("a shared secret is sent when confirmed and never repeated in the preview", async () => {
  const secret = "super-secret-jwt-token-with-at-least-32-characters-long";
  const fields = { issuer: "https://abcd.supabase.co/auth/v1", audience: "authenticated", kind: "hs256" as const, secret };

  const preview = await setTrustedIssuer(refusing(), 7, "supabase", fields);
  const text = preview.content.map((c) => ("text" in c ? c.text : "")).join("\n");
  assert.doesNotMatch(text, /super-secret/);
  assert.match(text, /shared secret of 55 bytes/);
  assert.match(text, /kind="hs256"/);

  const keeping = await setTrustedIssuer(refusing(), 7, "supabase", { ...fields, secret: undefined });
  assert.match(keeping.content.map((c) => ("text" in c ? c.text : "")).join("\n"), /stored one is kept/);

  const rc = fakeClient(() => ({ name: "supabase", kind: "hs256", hasSecret: true }));
  await setTrustedIssuer(rc, 7, "supabase", fields, true);
  assert.deepEqual(rc.calls[0].body, fields);
});
