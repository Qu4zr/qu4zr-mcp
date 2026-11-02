/**
 * Endpoint lifecycle operations (toggle enable/disable, update config, delete/un-deploy). Kept
 * as plain functions taking a minimal RequestClient so they're unit-testable without the MCP
 * server/transport or a real network call — see endpoints.test.ts.
 */

import { ok, run, type ToolResult } from "./helpers.js";

export interface RequestClient {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

export interface UpdateEndpointFields {
  isMain?: boolean;
  isEnabled?: boolean;
  allowedVerbs?: string[];
  detailedOutput?: boolean;
  isAnonymous?: boolean;
  notes?: string;
  /** anonymous | apiKey | user | jwt | apiKeyOrJwt — wins over isAnonymous when both are sent. */
  authMode?: string;
  /** Space-separated; a jwt / apiKeyOrJwt caller must hold every one. "" clears. */
  requiredScopes?: string;
}

export async function toggleEndpoint(
  client: RequestClient,
  endpointId: number,
  confirm?: boolean,
): Promise<ToolResult> {
  if (confirm !== true) {
    return ok(
      `Preview — will flip endpoint ${endpointId}'s enabled/disabled state.\n` +
        `Re-run toggle_endpoint with confirm:true to proceed.`,
    );
  }
  return run(() => client.request("POST", `/api/v1/endpoints/${endpointId}/toggle`));
}

export async function updateEndpoint(
  client: RequestClient,
  endpointId: number,
  fields: UpdateEndpointFields,
  confirm?: boolean,
): Promise<ToolResult> {
  const changes = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (changes.length === 0) {
    return ok(`Nothing to update — pass at least one of isMain/isEnabled/allowedVerbs/detailedOutput/isAnonymous/notes/authMode/requiredScopes.`);
  }

  const summary = changes.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
  if (confirm !== true) {
    return ok(`Preview — will update endpoint ${endpointId}: ${summary}.\nRe-run update_endpoint with confirm:true to proceed.`);
  }
  return run(() => client.request("PATCH", `/api/v1/endpoints/${endpointId}`, fields));
}

export async function deleteEndpoint(
  client: RequestClient,
  endpointId: number,
  confirm?: boolean,
  withArchived?: boolean,
): Promise<ToolResult> {
  if (confirm !== true) {
    return ok(
      `Preview — will permanently delete (un-deploy) endpoint ${endpointId}` +
        (withArchived ? " AND every other version of its path on that domain (the archived copies)" : "") +
        `.\nRe-run delete_endpoint with confirm:true to proceed.`,
    );
  }
  return run(async () => {
    await client.request("DELETE", `/api/v1/endpoints/${endpointId}${withArchived ? "?withArchived=true" : ""}`);
    return withArchived
      ? `Deleted endpoint ${endpointId} and the other versions of its path.`
      : `Deleted endpoint ${endpointId}.`;
  });
}
