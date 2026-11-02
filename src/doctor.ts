/**
 * `qu4zr-mcp doctor` — the command to run when an assistant says it cannot reach qu4zr.
 *
 * An MCP server is a bad place to debug from: it speaks JSON-RPC over stdio, its stderr is
 * swallowed or buried by most clients, and a configuration mistake shows up as a tool call
 * failing several turns into a conversation. This runs the same three steps the server runs —
 * read the config, get a token, make one real call — in a terminal, and says which one broke.
 */

import { Qu4zrClient, Qu4zrError } from "./client.js";
import { DEFAULT_BASE_URL, DEFAULT_SCOPES } from "./targets.js";

const ok = (line: string) => console.log(`  ok    ${line}`);
const bad = (line: string) => console.log(`  FAIL  ${line}`);
const warn = (line: string) => console.log(`  warn  ${line}`);

/** Enough to recognise the value you pasted, not enough to leak it out of a screenshot. */
const mask = (secret: string) =>
  secret.length <= 10 ? "*".repeat(secret.length) : `${secret.slice(0, 6)}…${secret.slice(-4)}`;

export async function doctor(version: string): Promise<number> {
  const baseUrl = (process.env.QU4ZR_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const clientId = process.env.QU4ZR_CLIENT_ID;
  const clientSecret = process.env.QU4ZR_CLIENT_SECRET;
  const scopes = (process.env.QU4ZR_SCOPES ?? DEFAULT_SCOPES).split(/\s+/).filter(Boolean);

  console.log(`qu4zr-mcp ${version}  ·  node ${process.version}\n`);
  console.log("Configuration");

  let failed = false;

  if (!clientId || !clientSecret) {
    bad("QU4ZR_CLIENT_ID / QU4ZR_CLIENT_SECRET are not both set in this environment.");
    console.log(
      "\n        The MCP config's `env` block is what the server sees — a shell variable set in\n" +
        "        your terminal does not reach a process the client spawns. Create a client under\n" +
        "        Account → API Access, then: qu4zr-mcp install <your client> --print\n",
    );
    return 1;
  }

  ok(`client id      ${clientId}`);
  ok(`client secret  ${mask(clientSecret)}`);
  ok(`base url       ${baseUrl}`);
  ok(`scopes         ${scopes.join(" ")}`);

  // Worth a line of its own: it is the "fix" the internet offers for the TLS error below, it
  // silently disables verification for every request this process makes, including the one that
  // carries the secret, and nothing else in the output would ever mention it.
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    warn(
      "NODE_TLS_REJECT_UNAUTHORIZED=0 — TLS certificates are NOT being verified.\n" +
        "        Your client secret is being sent over a connection nobody is checking. Remove it and\n" +
        "        use the Windows system CA installer support or set NODE_EXTRA_CA_CERTS to the root instead.",
    );
  }
  if (process.env.NODE_EXTRA_CA_CERTS) {
    ok(`extra CA       ${process.env.NODE_EXTRA_CA_CERTS}`);
  }
  if (process.env.NODE_USE_SYSTEM_CA === "1") {
    ok("system CA      operating-system trusted certificates enabled");
  }

  const client = new Qu4zrClient({ baseUrl, clientId, clientSecret, scopes });

  console.log("\nAuthentication");
  try {
    const identity = await client.verify();
    ok(`token issued, valid for ${Math.round((identity.expiresAtMs - Date.now()) / 60000)} min`);

    const granted = identity.scopes;
    if (granted.length) {
      ok(`granted        ${granted.join(" ")}`);
      const missing = scopes.filter((s) => !granted.includes(s));
      if (missing.length) {
        warn(
          `asked for ${missing.join(" ")} but the client does not have it — tools needing it will fail.`,
        );
      }
    }
  } catch (err) {
    bad(describe(err));
    return 1;
  }

  console.log("\nAPI");
  try {
    const workspaces = (await client.request("GET", "/api/v1/workspaces")) as unknown[];
    ok(`GET /api/v1/workspaces → ${Array.isArray(workspaces) ? workspaces.length : "?"} workspace(s)`);
  } catch (err) {
    bad(describe(err));
    failed = true;
  }

  console.log(failed ? "\nSomething is wrong — see above." : "\nAll good. Ask your assistant to list your qu4zr workspaces.");
  return failed ? 1 : 0;
}

/** Keeps the hint on the indented block the rest of the output uses. */
function describe(err: unknown): string {
  const message = err instanceof Qu4zrError ? err.message : (err as Error).message;
  return message.split("\n").join("\n        ");
}
