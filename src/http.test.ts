// The hosted server, end to end: the real dist/index.js in `serve-http` mode, in front of a fake
// Management API that records who called it. What has to hold is the security shape — no token,
// no service; each call carries the caller's own token; nothing touches this machine — so that is
// what is asserted, through the same HTTP an AI client would use.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AddressInfo } from "node:net";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const GOOD = "good-token-for-alice";

let api: Server;
let child: ChildProcess;
let mcpUrl = "";
const seen: { path: string; auth?: string }[] = [];

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, r));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

before(async () => {
  if (!existsSync(entry)) return;

  api = createServer((req, res) => {
    seen.push({ path: req.url ?? "", auth: req.headers.authorization });
    const ok = req.headers.authorization === `Bearer ${GOOD}`;
    if (!ok) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url?.startsWith("/api/v1/oauth/whoami")) {
      res.end(JSON.stringify({ client_id: "mcpc_test", scope: "flows:read", exp: Math.floor(Date.now() / 1000) + 600 }));
    } else {
      res.end(JSON.stringify([{ id: 7, name: "Orders" }]));
    }
  });
  await new Promise<void>((r) => api.listen(0, r));
  const apiPort = (api.address() as AddressInfo).port;

  const port = await freePort();
  mcpUrl = `http://127.0.0.1:${port}/mcp`;
  child = spawn(process.execPath, [entry, "serve-http"], {
    env: {
      ...process.env,
      PORT: String(port),
      QU4ZR_BASE_URL: `http://127.0.0.1:${apiPort}`,
      QU4ZR_MCP_RESOURCE: mcpUrl,
      QU4ZR_MCP_AUTH_SERVER: "https://qu4zr.example",
      QU4ZR_CLIENT_ID: "",
      QU4ZR_CLIENT_SECRET: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("serve-http did not start")), 10_000);
    child.stderr!.on("data", (d) => {
      if (String(d).includes("serving HTTP")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => reject(new Error(`serve-http exited with ${code}`)));
  });
});

after(() => {
  child?.kill();
  api?.close();
});

async function rpc(method: string, params: unknown, token: string | null = GOOD) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-06-18",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(mcpUrl, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}

const skip = !existsSync(entry) && "build first (npm run build)";

test("without a token: 401 that points the client at the sign-in metadata", { skip }, async () => {
  const res = await rpc("tools/list", {}, null);

  assert.equal(res.status, 401);
  const challenge = res.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer /);
  assert.match(challenge, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test("an expired or revoked token: 401 invalid_token, so the client refreshes", { skip }, async () => {
  const res = await rpc("tools/list", {}, "stale-token");

  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
});

test("the protected-resource metadata names qu4zr as the authorization server", { skip }, async () => {
  const res = await fetch(mcpUrl.replace("/mcp", "/.well-known/oauth-protected-resource/mcp"));
  const body = (await res.json()) as { resource: string; authorization_servers: string[] };

  assert.equal(body.resource, mcpUrl);
  assert.deepEqual(body.authorization_servers, ["https://qu4zr.example"]);
});

test("hosted, the tools that act on this machine are not offered", { skip }, async () => {
  const res = await rpc("tools/list", {});
  const body = (await res.json()) as { result: { tools: { name: string }[] } };
  const names = body.result.tools.map((t) => t.name);

  assert.ok(names.includes("list_workspaces"));
  assert.ok(names.includes("sync_files"));
  assert.ok(!names.includes("setup_runner"));
});

test("a tool call reaches the API with the caller's own token", { skip }, async () => {
  seen.length = 0;
  const res = await rpc("tools/call", { name: "list_workspaces", arguments: {} });
  const body = (await res.json()) as { result: { content: { text: string }[] } };

  assert.match(body.result.content[0].text, /Orders/);
  const call = seen.find((s) => s.path.startsWith("/api/v1/workspaces"));
  assert.equal(call?.auth, `Bearer ${GOOD}`);
});

test("sync_files will not read a folder on the server", { skip }, async () => {
  seen.length = 0;
  const res = await rpc("tools/call", { name: "sync_files", arguments: { workspaceId: 7, localDir: "/etc" } });
  const body = (await res.json()) as { result: { content: { text: string }[] } };

  assert.match(body.result.content[0].text, /hosted server/);
  assert.equal(seen.filter((s) => s.path.includes("/files")).length, 0);
});

test("GET on /mcp is refused: the server is stateless and opens no stream", { skip }, async () => {
  const res = await fetch(mcpUrl, { headers: { Authorization: `Bearer ${GOOD}` } });

  assert.equal(res.status, 405);
});
