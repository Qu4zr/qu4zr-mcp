import { strict as assert } from "node:assert";
import test from "node:test";
import { buildUrl, callEndpoint, noteForStatus, type FetchLike } from "./callEndpoint.js";

const domains = [
  { id: 46, slug: "pong-game", baseUrl: "https://pong-game.qu4zr.com/" },
  { id: 45, slug: "jalon", baseUrl: "https://api.qu4zr.io/jalon/" },
];

const client = { request: async () => domains as unknown as never };

/** A fetch that records what it was asked to do and answers with whatever the test needs. */
function recordingFetch(status = 200, body = "{}", contentType = "application/json") {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { "content-type": contentType } });
  };
  return { calls, impl };
}

const text = (result: { content: { text: string }[] }) => result.content.map((c) => c.text).join("\n");

test("the url comes from the domain's own baseUrl, never from the caller", async () => {
  // The security property AND the correctness one: what this calls is byte for byte what the deploy
  // reported and what the page's canonical names, so it cannot pass against a URL nobody was given.
  const { calls, impl } = recordingFetch();

  await callEndpoint(client, { domainId: 46, path: "api/matchmaking/check" }, impl);

  assert.equal(calls[0].url, "https://pong-game.qu4zr.com/api/matchmaking/check");
});

test("an unknown domain id is refused before any request goes out", async () => {
  const { calls, impl } = recordingFetch();

  const result = await callEndpoint(client, { domainId: 999, path: "x" }, impl);

  assert.equal(result.isError, true);
  assert.match(text(result), /list_domains/);
  assert.equal(calls.length, 0);
});

test("an empty path is the domain root", async () => {
  const { calls, impl } = recordingFetch();

  await callEndpoint(client, { domainId: 46, path: "" }, impl);

  assert.equal(calls[0].url, "https://pong-game.qu4zr.com/");
});

test("dot segments are refused rather than normalised away", () => {
  // An HTTP client resolves these out before the request leaves, so the call would land on an
  // address nobody deployed — and report success about it.
  assert.throws(() => buildUrl("https://x.qu4zr.com/", "api/../admin"), /"\.\."/);
});

test("a GET is the default and carries no body", async () => {
  const { calls, impl } = recordingFetch();

  await callEndpoint(client, { domainId: 46, path: "orders", body: "ignored" }, impl);

  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined);
});

test("a POST body is sent as json unless a content type was given", async () => {
  const { calls, impl } = recordingFetch();

  await callEndpoint(client, { domainId: 46, path: "orders", method: "post", body: '{"a":1}' }, impl);

  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(calls[0].init.method, "POST");
  assert.equal(headers["Content-Type"], "application/json");
});

test("an api key travels as a bearer token and cannot also arrive as a header", async () => {
  // Two routes for one credential is two places for it to disagree, and the header is the one a
  // caller can set by accident.
  const { calls, impl } = recordingFetch();

  await callEndpoint(
    client,
    { domainId: 46, path: "orders", apiKey: "k-123", headers: { Authorization: "Bearer wrong", Host: "evil" } },
    impl,
  );

  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer k-123");
  assert.equal(headers["Host"], undefined);
});

test("query parameters are appended and escaped", async () => {
  const { calls, impl } = recordingFetch();

  await callEndpoint(client, { domainId: 46, path: "search", query: { q: "a b" } }, impl);

  assert.equal(calls[0].url, "https://pong-game.qu4zr.com/search?q=a+b");
});

test("an unknown method is refused", async () => {
  const { calls, impl } = recordingFetch();

  const result = await callEndpoint(client, { domainId: 46, path: "x", method: "FETCH" }, impl);

  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

test("a 404 comes back as an answer, with the reason it is usually a 404 here", async () => {
  const { impl } = recordingFetch(404, "Not Found", "text/plain");

  const result = await callEndpoint(client, { domainId: 46, path: "api/matchmaking/check" }, impl);

  assert.notEqual(result.isError, true);
  assert.match(text(result), /deploy_endpoint/);
});

test("the status notes only speak where the cause is qu4zr-specific", () => {
  assert.match(noteForStatus(401) ?? "", /isAnonymous/);
  assert.match(noteForStatus(500) ?? "", /get_logs/);
  assert.equal(noteForStatus(200), undefined);
  assert.equal(noteForStatus(418), undefined);
});

test("a long body is truncated and says so", async () => {
  const { impl } = recordingFetch(200, "x".repeat(9000), "text/html");

  const result = await callEndpoint(client, { domainId: 46, path: "" }, impl);

  assert.match(text(result), /"bodyTruncated": true/);
});

test("a hanging endpoint is reported as a finding, not as a tool failure", async () => {
  const impl: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });

  const result = await callEndpoint(client, { domainId: 46, path: "slow", timeoutMs: 10 }, impl);

  assert.notEqual(result.isError, true);
  assert.match(text(result), /hanging/);
});
