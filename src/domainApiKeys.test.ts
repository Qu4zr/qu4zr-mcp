import { test } from "node:test";
import assert from "node:assert/strict";
import type { RequestClient } from "./endpoints.js";
import {
  listDomainApiKeys,
  createDomainApiKey,
  updateDomainApiKey,
  deleteDomainApiKey,
  rotateDomainApiKey,
} from "./domainApiKeys.js";

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

// ---- listDomainApiKeys --------------------------------------------------------

test("listDomainApiKeys: GETs the domain's keys route and returns passthrough data", async () => {
  const client = fakeClient(() => [{ id: 1, apiKey: "sk_****abcd" }]);

  const result = await listDomainApiKeys(client, 9);

  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0], { method: "GET", path: "/api/v1/domains/9/keys", body: undefined });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /sk_\*\*\*\*abcd/);
});

// ---- createDomainApiKey --------------------------------------------------------

test("createDomainApiKey: without confirm returns a preview and makes no request", async () => {
  const client = fakeClient(() => {
    throw new Error("should not be called");
  });

  const result = await createDomainApiKey(client, 9, { name: "prod" });

  assert.equal(client.calls.length, 0);
  assert.match(result.content[0].text, /preview/i);
  assert.match(result.content[0].text, /prod/);
  assert.match(result.content[0].text, /never again/i);
});

test("createDomainApiKey: confirm:true POSTs the fields", async () => {
  const client = fakeClient(() => ({ id: 5, apiKey: "sk_live_full_value" }));

  const result = await createDomainApiKey(client, 9, { name: "prod" }, true);

  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0], {
    method: "POST",
    path: "/api/v1/domains/9/keys",
    body: { name: "prod" },
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /sk_live_full_value/);
});

test("createDomainApiKey: client failure surfaces as isError", async () => {
  const client = fakeClient(() => {
    throw new Error("404: domain not found");
  });

  const result = await createDomainApiKey(client, 9, {}, true);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /domain not found/);
});

// ---- updateDomainApiKey --------------------------------------------------------

test("updateDomainApiKey: no fields set returns a no-op message and makes no request", async () => {
  const client = fakeClient(() => {
    throw new Error("should not be called");
  });

  const result = await updateDomainApiKey(client, 9, 5, {}, true);

  assert.equal(client.calls.length, 0);
  assert.match(result.content[0].text, /nothing to update/i);
});

test("updateDomainApiKey: without confirm returns a preview listing the changes", async () => {
  const client = fakeClient(() => {
    throw new Error("should not be called");
  });

  const result = await updateDomainApiKey(client, 9, 5, { isActive: false });

  assert.equal(client.calls.length, 0);
  assert.match(result.content[0].text, /preview/i);
  assert.match(result.content[0].text, /isActive=false/);
});

test("updateDomainApiKey: confirm:true PATCHes only the provided fields", async () => {
  const client = fakeClient(() => ({ id: 5, isActive: false }));

  const result = await updateDomainApiKey(client, 9, 5, { isActive: false }, true);

  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0], {
    method: "PATCH",
    path: "/api/v1/domains/9/keys/5",
    body: { isActive: false },
  });
  assert.equal(result.isError, undefined);
});

// ---- deleteDomainApiKey --------------------------------------------------------

test("deleteDomainApiKey: without confirm returns a preview and makes no request", async () => {
  const client = fakeClient(() => {
    throw new Error("should not be called");
  });

  const result = await deleteDomainApiKey(client, 9, 5);

  assert.equal(client.calls.length, 0);
  assert.match(result.content[0].text, /preview/i);
  assert.match(result.content[0].text, /5/);
});

test("deleteDomainApiKey: confirm:true DELETEs the key route", async () => {
  const client = fakeClient(() => undefined);

  const result = await deleteDomainApiKey(client, 9, 5, true);

  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0], { method: "DELETE", path: "/api/v1/domains/9/keys/5", body: undefined });
  assert.match(result.content[0].text, /Deleted API key 5/);
});

test("deleteDomainApiKey: client failure surfaces as isError", async () => {
  const client = fakeClient(() => {
    throw new Error("404: not found");
  });

  const result = await deleteDomainApiKey(client, 9, 5, true);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found/);
});

// ---- rotateDomainApiKey --------------------------------------------------------

test("rotateDomainApiKey: without confirm returns a preview and makes no request", async () => {
  const client = fakeClient(() => {
    throw new Error("should not be called");
  });

  const result = await rotateDomainApiKey(client, 9, 5, {});

  assert.equal(client.calls.length, 0);
  assert.match(result.content[0].text, /preview/i);
  assert.match(result.content[0].text, /never again/i);
});

test("rotateDomainApiKey: confirm:true POSTs to the rotate route with fields", async () => {
  const client = fakeClient(() => ({ newKey: { apiKey: "sk_new_value" }, oldKey: { isActive: false } }));

  const result = await rotateDomainApiKey(client, 9, 5, { keepOldKeyActive: true, gracePeriodMinutes: 60 }, true);

  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0], {
    method: "POST",
    path: "/api/v1/domains/9/keys/5/rotate",
    body: { keepOldKeyActive: true, gracePeriodMinutes: 60 },
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /sk_new_value/);
});

test("rotateDomainApiKey: client failure surfaces as isError", async () => {
  const client = fakeClient(() => {
    throw new Error("404: key not found");
  });

  const result = await rotateDomainApiKey(client, 9, 5, {}, true);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /key not found/);
});
