/**
 * The hosted MCP server: Streamable HTTP on /mcp, behind nginx at api.management.qu4zr.io.
 *
 * Stateless — every POST builds a server, serves the one JSON-RPC message and is done — so any
 * replica can answer any request and nothing about a person lives here between calls. Who they are
 * is the bearer token their AI client sends; it is checked with the API before anything is served
 * (so an expired token gets the 401 that makes the client refresh, not a tool error three turns
 * later) and then carried, request by request, to every API call the tools make.
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { withBearer } from "./remote.js";

export interface HttpOptions {
  buildServer: () => McpServer;
  /** The Management API the tools call, and the place a bearer token is checked. */
  baseUrl: string;
  version: string;
  port?: number;
  /** Public URL of /mcp, as clients see it — the RFC 9728 resource identifier. */
  resource?: string;
  /** The authorization server that issues tokens for this resource. */
  authorizationServer?: string;
  /** Largest request body accepted. sync_files sends whole sites, so this is generous. */
  maxBodyBytes?: number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

const SCOPES = ["flows:read", "flows:write", "flows:deploy", "flows:execute"];

/** How long a token the API accepted is trusted without asking again (capped by its own expiry). */
const VERIFIED_TTL_MS = 60_000;

export function createHttpHandler(options: HttpOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((line: string) => console.error(line));
  const resource = (options.resource ?? process.env.QU4ZR_MCP_RESOURCE ?? "https://api.management.qu4zr.io/mcp").replace(/\/+$/, "");
  const authorizationServer = (options.authorizationServer ?? process.env.QU4ZR_MCP_AUTH_SERVER ?? "https://qu4zr.com").replace(/\/+$/, "");
  const maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;
  const resourceUrl = new URL(resource);
  const metadataPath = `/.well-known/oauth-protected-resource${resourceUrl.pathname === "/" ? "" : resourceUrl.pathname}`;
  const metadataUrl = `${resourceUrl.origin}${metadataPath}`;
  const verified = new Map<string, number>();

  const metadata = JSON.stringify({
    resource,
    authorization_servers: [authorizationServer],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "qu4zr",
    resource_documentation: `${authorizationServer}/Identity/Account/Manage/ApiAccess`,
  });

  function cors(res: ServerResponse) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID");
    res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
  }

  function send(res: ServerResponse, status: number, body: string, contentType = "application/json") {
    res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
    res.end(body);
  }

  function unauthorized(res: ServerResponse, error?: "invalid_token", description?: string) {
    const parts = [`resource_metadata="${metadataUrl}"`, `scope="${SCOPES.join(" ")}"`];
    if (error) parts.unshift(`error="${error}"`, `error_description="${description ?? "The access token is not valid."}"`);
    res.setHeader("WWW-Authenticate", `Bearer ${parts.join(", ")}`);
    send(res, 401, JSON.stringify({ error: error ?? "unauthorized", error_description: description ?? "Sign in to qu4zr to use this server." }));
  }

  /** "ok", "invalid", or "unavailable" when the API could not be asked. */
  async function verify(token: string): Promise<"ok" | "invalid" | "unavailable"> {
    const key = createHash("sha256").update(token).digest("hex");
    const until = verified.get(key);
    if (until && until > Date.now()) return "ok";
    verified.delete(key);

    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl}/api/v1/oauth/whoami`, { headers: { Authorization: `Bearer ${token}` } });
    } catch {
      return "unavailable";
    }
    if (response.status === 401 || response.status === 403) return "invalid";
    if (!response.ok) return "unavailable";

    const body = (await response.json().catch(() => ({}))) as { exp?: number };
    const expiresMs = typeof body.exp === "number" ? body.exp * 1000 : Date.now() + VERIFIED_TTL_MS;
    verified.set(key, Math.min(expiresMs, Date.now() + VERIFIED_TTL_MS));
    if (verified.size > 10_000) {
      for (const [k, v] of verified) if (v <= Date.now()) verified.delete(k);
    }
    return "ok";
  }

  async function readBody(req: IncomingMessage): Promise<Buffer | "too-large"> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBodyBytes) return "too-large";
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    cors(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (path === "/health") {
      send(res, 200, JSON.stringify({ ok: true, version: options.version }));
      return;
    }
    if (req.method === "GET" && (path === metadataPath || path === "/.well-known/oauth-protected-resource")) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" });
      res.end(metadata);
      return;
    }
    if (path !== resourceUrl.pathname) {
      send(res, 404, JSON.stringify({ error: "not_found" }));
      return;
    }
    if (req.method !== "POST") {
      // Stateless: no session to resume or delete, and no server-initiated stream to open.
      res.setHeader("Allow", "POST, OPTIONS");
      send(res, 405, JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
      return;
    }

    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) {
      unauthorized(res);
      return;
    }
    const token = match[1];
    const check = await verify(token);
    if (check === "invalid") {
      unauthorized(res, "invalid_token", "The access token expired or was revoked. Sign in again.");
      return;
    }
    if (check === "unavailable") {
      send(res, 503, JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "qu4zr is not reachable right now. Try again shortly." }, id: null }));
      return;
    }

    const raw = await readBody(req);
    if (raw === "too-large") {
      send(res, 413, JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: `Request larger than ${maxBodyBytes} bytes.` }, id: null }));
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      send(res, 400, JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error." }, id: null }));
      return;
    }

    const server = options.buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await withBearer(token, () => transport.handleRequest(req, res, body));
    } catch (err) {
      log(`qu4zr-mcp http: ${(err as Error).message}`);
      if (!res.headersSent) {
        send(res, 500, JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error." }, id: null }));
      }
    }
  };
}

export async function serveHttp(options: HttpOptions): Promise<void> {
  const port = options.port ?? Number(process.env.PORT ?? process.env.QU4ZR_MCP_PORT ?? 8080);
  const handler = createHttpHandler(options);
  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error("qu4zr-mcp http:", err);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  // Behind nginx: keep-alive longer than its upstream timeout, so a reused socket is never closed
  // under it mid-request.
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;

  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.error(`qu4zr-mcp ${options.version} serving HTTP on :${port} → ${options.baseUrl}`);

  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
