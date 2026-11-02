import { test } from "node:test";
import assert from "node:assert/strict";
import { toggleEndpoint, updateEndpoint, deleteEndpoint, type RequestClient } from "./endpoints.js";

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

// ---- toggleEndpoint ---------------------------------------------------------

test("toggleEndpoint: without confirm returns a preview and makes no request", async () => {
  const client = fakeClient(() => {
    throw new Error("should not be called");
  });

  const result = await toggleEndpoint(client, 42);

  assert.equal(client.calls.length, 0);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /preview/i);
  assert.match(result.content[0].text, /42/);
});

test("toggleEndpoint: confirm:false also returns a preview and makes no request", async () => {
  const client = fakeClient(() => {
    throw new Error("should not be called");
  });

  const result = await toggleEndpoint(client, 42, false);

  assert.equal(client.calls.length, 0);
  assert.match(result.content[0].text, /preview/i);
});

test("toggleEndpoint: confirm:true POSTs to the toggle route", async () => {
  const client = fakeClient(() => ({ id: 42, isEnabled: false }));

  const result = await toggleEndpoint(client, 42, true);

  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0], { method: "POST", path: "/api/v1/endpoints/42/toggle", body: undefined });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /"isEnabled": false/);
});

test("toggleEndpoint: client failure surfaces as isError", async () => {
  const client = fakeClient(() => {
    throw new Error("403: edit_forbidden");
  });

  const result = await toggleEndpoint(client, 42, true);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /edit_forbidden/);
});

// ---- updateEndpoint -----------------------------------------------------------

test("updateEndpoint: no fields set returns a no-op message and makes no request", async () => {
  const client = fakeClient(() => {
    throw new Error("should not be called");
  });

  const result = await updateEndpoint(client, 42, {}, true);

  assert.equal(client.calls.length, 0);
  assert.match(result.content[0].text, /nothing to update/i);
});

test("updateEndpoint: without confirm returns a preview listing the changes, makes no request", async () => {
  const client = fakeClient(() => {
    throw new Error("should not be called");
  });

  const result = await updateEndpoint(client, 42, { isAnonymous: false, notes: "prod key required" });

  assert.equal(client.calls.length, 0);
  assert.match(result.content[0].text, /preview/i);
  assert.match(result.content[0].text, /isAnonymous=false/);
  assert.match(result.content[0].text, /notes=/);
});

test("updateEndpoint: confirm:true PATCHes only the provided fields", async () => {
  const client = fakeClient(() => ({ id: 42, isAnonymous: false }));

  const result = await updateEndpoint(client, 42, { isAnonymous: false, allowedVerbs: ["GET"] }, true);

  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0], {
    method: "PATCH",
    path: "/api/v1/endpoints/42",
    body: { isAnonymous: false, allowedVerbs: ["GET"] },
  });
  assert.equal(result.isError, undefined);
});

test("updateEndpoint: client failure surfaces as isError", async () => {
  const client = fakeClient(() => {
    throw new Error("400: invalid_verbs");
  });

  const result = await updateEndpoint(client, 42, { allowedVerbs: [] }, true);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /invalid_verbs/);
});

// ---- deleteEndpoint ----------------------------------------------------------

test("deleteEndpoint: without confirm returns a preview and makes no request", async () => {
  const client = fakeClient(() => {
    throw new Error("should not be called");
  });

  const result = await deleteEndpoint(client, 7);

  assert.equal(client.calls.length, 0);
  assert.match(result.content[0].text, /preview/i);
  assert.match(result.content[0].text, /7/);
});

test("deleteEndpoint: confirm:true DELETEs the endpoint route", async () => {
  const client = fakeClient(() => undefined);

  const result = await deleteEndpoint(client, 7, true);

  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0], { method: "DELETE", path: "/api/v1/endpoints/7", body: undefined });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Deleted endpoint 7/);
});

test("deleteEndpoint: client failure surfaces as isError", async () => {
  const client = fakeClient(() => {
    throw new Error("404: not found");
  });

  const result = await deleteEndpoint(client, 7, true);

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found/);
});

test("updateEndpoint: authMode and requiredScopes are sent as given, and count as a change", async () => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client: RequestClient = {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      return { authMode: "jwt" } as T;
    },
  };

  const preview = await updateEndpoint(client, 4, { authMode: "jwt", requiredScopes: "orders:read" });
  assert.match(preview.content[0].text, /authMode="jwt"/);
  assert.equal(calls.length, 0);

  await updateEndpoint(client, 4, { authMode: "jwt", requiredScopes: "" }, true);
  assert.deepEqual(calls[0], { method: "PATCH", path: "/api/v1/endpoints/4", body: { authMode: "jwt", requiredScopes: "" } });
});

test("deleteEndpoint: withArchived asks the server to remove the whole path", async () => {
  const client = fakeClient(() => undefined);

  const result = await deleteEndpoint(client, 7, true, true);

  assert.deepEqual(client.calls[0], { method: "DELETE", path: "/api/v1/endpoints/7?withArchived=true", body: undefined });
  assert.match(result.content[0].text, /other versions of its path/);
});
