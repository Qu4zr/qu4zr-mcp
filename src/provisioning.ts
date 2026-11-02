/**
 * Provisioning operations: creating an API domain, and creating a workspace vault + its secrets.
 *
 * These close the one gap that made the platform not-quite-programmable: an agent could create a
 * workspace, its blocks, its endpoints and its API keys, but had to stop mid-build and tell the user
 * to go click in the dashboard to get a domain or a secret. Written as plain functions over a
 * minimal RequestClient so the confirmation gating is unit-testable without the MCP server — see
 * provisioning.test.ts. Same shape as endpoints.ts.
 */

import { ok, run, type ToolResult } from "./helpers.js";
import type { RequestClient } from "./endpoints.js";

export type SecretKind = "string" | "connection";

export async function createDomain(
  client: RequestClient,
  fields: { name: string; slug?: string; description?: string; tags?: string[] },
  confirm?: boolean,
): Promise<ToolResult> {
  const slug = fields.slug ?? fields.name;

  if (confirm !== true) {
    // The preview names no host on purpose. A domain may answer both at
    // https://api.qu4zr.io/{slug}/… and at a host of its own (https://{slug}.{zone}/), and only the
    // server knows which one is canonical — it comes back as `baseUrl`. An earlier preview asserted
    // the path form, which is the one an author must NOT put in a canonical tag: the only screen
    // read before confirming was teaching the wrong URL.
    return ok(
      `Preview — will create domain "${fields.name}" with slug "${slug}". It becomes the public ` +
        `namespace of every endpoint deployed into it, and where site hosts are enabled it is also a ` +
        `HOSTNAME ({slug}.…), so it is a permanent, public, brandable name. The slug is globally ` +
        `unique across all users and cannot be freed once callers depend on it.\n` +
        `The reply carries the domain's baseUrl — use THAT as the canonical base for its pages, ` +
        `never a URL you assembled yourself.\n` +
        `Re-run create_domain with confirm:true to proceed.`,
    );
  }

  return run(() => client.request("POST", "/api/v1/domains", fields));
}

/**
 * Creates the workspace vault, or renames an existing one.
 *
 * Creating is additive and needs no ceremony. **Renaming is not**: the vault name is the identifier
 * block code references (<c>MyVault.prodDb</c>), so a rename silently invalidates every reference
 * already written into blocks — code that still parses and still deploys, and fails at run time.
 * Only that case asks for confirmation, which is why this reads the current name first.
 */
export async function createVault(
  client: RequestClient,
  workspaceId: number,
  name: string,
  confirm?: boolean,
): Promise<ToolResult> {
  return run(async () => {
    const existing = await client.request<{ vaultName?: string | null }>(
      "GET",
      `/api/v1/workspaces/${workspaceId}/vault`,
    );

    if (existing?.vaultName && existing.vaultName !== name && confirm !== true) {
      throw new Error(
        `Workspace ${workspaceId} already has a vault named "${existing.vaultName}". Renaming it to ` +
          `"${name}" will break any block code referencing ${existing.vaultName}.<secret>. ` +
          `Re-run create_vault with confirm:true to rename.`,
      );
    }

    return client.request("PUT", `/api/v1/workspaces/${workspaceId}/vault`, { name });
  });
}

/**
 * Stores a write-only secret.
 *
 * The preview deliberately describes the secret without reproducing it. A confirmation step that
 * prints the value back into the transcript would undo the point of storing it write-only — the
 * whole design is that the plaintext exists in exactly one place, encrypted, server-side.
 */
export async function setVaultSecret(
  client: RequestClient,
  workspaceId: number,
  secret: { name: string; kind: SecretKind; value: string; provider?: string },
  confirm?: boolean,
): Promise<ToolResult> {
  if (!secret.value) {
    return ok(
      `No value supplied for secret "${secret.name}". Ask the user for it — never invent a secret ` +
        `value or reuse one from elsewhere in the conversation.`,
    );
  }

  if (secret.kind === "connection" && !secret.provider) {
    return ok(
      `A connection secret needs a provider (postgres|sqlserver|oracle|mysql|sqlite). ` +
        `Ask the user which database "${secret.name}" points at.`,
    );
  }

  if (confirm !== true) {
    return ok(
      `Preview — will store secret "${secret.name}" (${secret.kind}` +
        `${secret.provider ? `, ${secret.provider}` : ""}) in workspace ${workspaceId}'s vault. ` +
        `The value is write-only: once stored it cannot be read back by anyone, only referenced ` +
        `from block code as <vaultName>.${secret.name}.\n` +
        `Re-run set_vault_secret with confirm:true to proceed.`,
    );
  }

  return run(() => client.request("POST", `/api/v1/workspaces/${workspaceId}/vault/secrets`, secret));
}
