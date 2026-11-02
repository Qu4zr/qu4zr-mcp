/**
 * What changes when qu4zr-mcp runs as the hosted server (`qu4zr-mcp serve-http`) instead of on the
 * user's own machine.
 *
 * Two things. Each request acts as whoever signed in — the bearer token their AI client sends,
 * carried to the API call through AsyncLocalStorage rather than a process-wide credential. And no
 * tool may touch the machine it runs on: on a laptop "this machine" is the user's own, on the
 * hosted server it is qu4zr's, shared by everyone.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface RequestContext {
  bearer: string;
}

const context = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with this request's bearer token as the identity every API call uses. */
export function withBearer<T>(bearer: string, fn: () => T): T {
  return context.run({ bearer }, fn);
}

/** The bearer token of the request being served, if any. */
export function currentBearer(): string | undefined {
  return context.getStore()?.bearer;
}

/**
 * Tools that act on the machine the server runs on. `setup_runner` writes, builds and launches a
 * project there. Hosted, they are not registered at all: an absent tool cannot be talked into
 * running.
 */
export const LOCAL_ONLY_TOOLS: ReadonlySet<string> = new Set(["setup_runner"]);

/** The answer `sync_files` gives when asked, hosted, to read a folder "on this machine". */
export const LOCAL_DIR_REFUSAL =
  "localDir reads a folder on the machine running the MCP server. This is the hosted server, so that " +
  "machine is qu4zr's, not yours. Send the files in `files` instead, or use the npm package " +
  "(npx qu4zr-mcp) on your own machine to sync a local folder.";

/** Makes `server` skip the registration of every tool in {@link LOCAL_ONLY_TOOLS}. */
export function withoutLocalTools(server: McpServer): McpServer {
  type Register = (name: string, ...rest: unknown[]) => unknown;
  const target = server as unknown as { registerTool: Register };
  const register: Register = target.registerTool.bind(server);
  target.registerTool = (name, ...rest) =>
    LOCAL_ONLY_TOOLS.has(name)
      ? { enabled: false, enable() {}, disable() {}, update() {}, remove() {} }
      : register(name, ...rest);
  return server;
}
