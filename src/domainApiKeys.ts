/**
 * Domain-scoped API key management (the credential a non-anonymous deployed endpoint
 * requires). Kept as plain functions over the shared RequestClient so they're
 * unit-testable without the MCP server/transport or a real network call — see
 * domainApiKeys.test.ts.
 */

import { ok, run, type ToolResult } from "./helpers.js";
import type { RequestClient } from "./endpoints.js";

export interface CreateDomainApiKeyFields {
  name?: string;
  expiresAt?: string;
}

export interface UpdateDomainApiKeyFields {
  name?: string;
  isActive?: boolean;
  expiresAt?: string;
}

export interface RotateDomainApiKeyFields {
  keepOldKeyActive?: boolean;
  gracePeriodMinutes?: number;
}

export async function listDomainApiKeys(client: RequestClient, domainId: number): Promise<ToolResult> {
  return run(() => client.request("GET", `/api/v1/domains/${domainId}/keys`));
}

export async function createDomainApiKey(
  client: RequestClient,
  domainId: number,
  fields: CreateDomainApiKeyFields,
  confirm?: boolean,
): Promise<ToolResult> {
  if (confirm !== true) {
    return ok(
      `Preview — will mint a new API key on domain ${domainId}` +
        `${fields.name ? ` named "${fields.name}"` : ""}${fields.expiresAt ? ` expiring ${fields.expiresAt}` : ""}.\n` +
        `The plaintext key is shown ONLY in this response, never again — copy it immediately.\n` +
        `Re-run create_domain_api_key with confirm:true to proceed.`,
    );
  }
  return run(() => client.request("POST", `/api/v1/domains/${domainId}/keys`, fields));
}

export async function updateDomainApiKey(
  client: RequestClient,
  domainId: number,
  keyId: number,
  fields: UpdateDomainApiKeyFields,
  confirm?: boolean,
): Promise<ToolResult> {
  const changes = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (changes.length === 0) {
    return ok(`Nothing to update — pass at least one of name/isActive/expiresAt.`);
  }

  const summary = changes.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
  if (confirm !== true) {
    return ok(
      `Preview — will update API key ${keyId} on domain ${domainId}: ${summary}.\n` +
        `Re-run update_domain_api_key with confirm:true to proceed.`,
    );
  }
  return run(() => client.request("PATCH", `/api/v1/domains/${domainId}/keys/${keyId}`, fields));
}

export async function deleteDomainApiKey(
  client: RequestClient,
  domainId: number,
  keyId: number,
  confirm?: boolean,
): Promise<ToolResult> {
  if (confirm !== true) {
    return ok(
      `Preview — will permanently delete API key ${keyId} on domain ${domainId}. Any caller using it ` +
        `will start getting 401s immediately.\nRe-run delete_domain_api_key with confirm:true to proceed.`,
    );
  }
  return run(async () => {
    await client.request("DELETE", `/api/v1/domains/${domainId}/keys/${keyId}`);
    return `Deleted API key ${keyId} on domain ${domainId}.`;
  });
}

export async function rotateDomainApiKey(
  client: RequestClient,
  domainId: number,
  keyId: number,
  fields: RotateDomainApiKeyFields,
  confirm?: boolean,
): Promise<ToolResult> {
  if (confirm !== true) {
    return ok(
      `Preview — will rotate API key ${keyId} on domain ${domainId}, issuing a new plaintext key.\n` +
        `${fields.keepOldKeyActive ? "The old key stays active for a grace period." : "The old key is deactivated immediately."}\n` +
        `The new plaintext key is shown ONLY in this response, never again — copy it immediately.\n` +
        `Re-run rotate_domain_api_key with confirm:true to proceed.`,
    );
  }
  return run(() => client.request("POST", `/api/v1/domains/${domainId}/keys/${keyId}/rotate`, fields));
}
