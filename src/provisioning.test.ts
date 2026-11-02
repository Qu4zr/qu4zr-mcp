import { test } from "node:test";
import assert from "node:assert/strict";
import { createDomain, createVault, setVaultSecret } from "./provisioning.js";
import type { RequestClient } from "./endpoints.js";

type Call = { method: string; path: string; body?: unknown };

function fakeClient(handler: (call: Call) => unknown): RequestClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      return handler({ method, path, body }) as T;
    },
  };
}

const refuse = () => {
  throw new Error("should not be called");
};

// ---- createDomain -----------------------------------------------------------

test("createDomain: without confirm previews the slug and makes no request", async () => {
  const client = fakeClient(refuse);

  const result = await createDomain(client, { name: "Orders API", slug: "orders-api" });

  assert.equal(client.calls.length, 0);
  assert.match(result.content[0].text, /preview/i);
  // The slug is what becomes permanent, so the preview must show it.
  assert.match(result.content[0].text, /orders-api/);
});

test("createDomain: the preview asserts no host of its own", async () => {
  // It used to promise "served at https://api.qu4zr.io/{slug}/{path}". Once a domain can also answer
  // at {slug}.{zone}, that is the form an author must NOT put in a canonical tag — and the preview is
  // the only screen read before confirming. Only the server knows which host is canonical; it says so
  // in `baseUrl`, and the preview now sends the reader there.
  const result = await createDomain(fakeClient(refuse), { name: "Orders API", slug: "orders-api" });
  const text = result.content[0].text;

  assert.ok(!/api\.qu4zr\.io/.test(text), `the preview should not name a host: ${text}`);
  assert.match(text, /baseUrl/);
});

test("createDomain: the preview shows the slug that will actually be used", async () => {
  const client = fakeClient(refuse);

  const result = await createDomain(client, { name: "Orders API" });

  assert.match(result.content[0].text, /"Orders API"/);
});

test("createDomain: confirm:true POSTs the domain", async () => {
  const client = fakeClient(() => ({ id: 7, slug: "orders-api" }));

  await createDomain(client, { name: "Orders API", slug: "orders-api" }, true);

  assert.deepEqual(client.calls[0], {
    method: "POST",
    path: "/api/v1/domains",
    body: { name: "Orders API", slug: "orders-api" },
  });
});

// ---- createVault ------------------------------------------------------------

test("createVault: creating a first vault needs no confirmation", async () => {
  // Creating is additive — nothing can break. Asking for confirmation here would be ceremony.
  const client = fakeClient((call) => (call.method === "GET" ? { vaultName: null } : { vaultName: "MyVault" }));

  const result = await createVault(client, 42, "MyVault");

  assert.equal(result.isError, undefined);
  assert.equal(client.calls[1].method, "PUT");
  assert.deepEqual(client.calls[1].body, { name: "MyVault" });
});

test("createVault: setting the SAME name again is not treated as a rename", async () => {
  const client = fakeClient((call) => (call.method === "GET" ? { vaultName: "MyVault" } : { vaultName: "MyVault" }));

  const result = await createVault(client, 42, "MyVault");

  assert.equal(result.isError, undefined);
  assert.equal(client.calls[1].method, "PUT");
});

test("createVault: renaming without confirm refuses and explains what breaks", async () => {
  // The vault name is the identifier block code uses. A rename leaves code that still parses and
  // still deploys, and fails at run time — so the user has to be in the loop.
  const client = fakeClient((call) => {
    if (call.method === "GET") return { vaultName: "OldVault" };
    throw new Error("should not have written");
  });

  const result = await createVault(client, 42, "NewVault");

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /OldVault/);
  assert.match(result.content[0].text, /confirm:true/);
  assert.equal(client.calls.length, 1, "it must not write when refusing");
});

test("createVault: renaming with confirm:true goes through", async () => {
  const client = fakeClient((call) => (call.method === "GET" ? { vaultName: "OldVault" } : { vaultName: "NewVault" }));

  const result = await createVault(client, 42, "NewVault", true);

  assert.equal(result.isError, undefined);
  assert.equal(client.calls[1].method, "PUT");
});

// ---- setVaultSecret ---------------------------------------------------------

test("setVaultSecret: the preview never reproduces the secret value", async () => {
  // The point of a write-only secret is that the plaintext lives in exactly one place, encrypted,
  // server-side. A confirmation step that echoes it into the transcript undoes that.
  const client = fakeClient(refuse);

  const result = await setVaultSecret(client, 42, {
    name: "stripeKey",
    kind: "string",
    value: "sk_live_SUPERSECRET",
  });

  assert.equal(client.calls.length, 0);
  assert.doesNotMatch(result.content[0].text, /SUPERSECRET/);
  assert.match(result.content[0].text, /stripeKey/);
  assert.match(result.content[0].text, /write-only/i);
});

test("setVaultSecret: confirm:true POSTs the secret", async () => {
  const client = fakeClient(() => ({ name: "stripeKey", kind: "String" }));

  await setVaultSecret(client, 42, { name: "stripeKey", kind: "string", value: "sk_live_x" }, true);

  assert.deepEqual(client.calls[0], {
    method: "POST",
    path: "/api/v1/workspaces/42/vault/secrets",
    body: { name: "stripeKey", kind: "string", value: "sk_live_x" },
  });
});

test("setVaultSecret: an empty value is refused before anything is sent", async () => {
  // Better to ask the user than to store a placeholder that fails opaquely at run time — and a
  // stored empty secret cannot be inspected afterwards to find out it was empty.
  const client = fakeClient(refuse);

  const result = await setVaultSecret(client, 42, { name: "stripeKey", kind: "string", value: "" }, true);

  assert.equal(client.calls.length, 0);
  assert.match(result.content[0].text, /ask the user/i);
});

test("setVaultSecret: a connection without a provider is refused", async () => {
  const client = fakeClient(refuse);

  const result = await setVaultSecret(
    client,
    42,
    { name: "prodDb", kind: "connection", value: "Host=db;Username=u" },
    true,
  );

  assert.equal(client.calls.length, 0);
  assert.match(result.content[0].text, /provider/i);
  assert.doesNotMatch(result.content[0].text, /Host=db/);
});
