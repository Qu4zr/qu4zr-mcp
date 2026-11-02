/**
 * A domain's API clients (machine callers exchanging a client id + secret for a short-lived token),
 * its signing keys, and the external identity providers it trusts — everything a `jwt` /
 * `apiKeyOrJwt` endpoint accepts. Plain functions over the shared RequestClient so they are unit-
 * testable without the MCP server — see domainClients.test.ts.
 *
 * Every call that mints, revokes or changes who may call the site previews first and acts only with
 * `confirm: true`, like the domain API key tools.
 */

import { ok, run, type ToolResult } from "./helpers.js";
import type { RequestClient } from "./endpoints.js";

export interface DomainClientFields {
  name?: string;
  /** Space-separated scopes the client may be granted. */
  scopes?: string;
  tokenLifetimeMinutes?: number;
  /**
   * The client's own gateway allowance, requests per minute (1–6000). Omit for none (create) or to keep
   * it (update); 0 removes it.
   */
  rateLimitPerMinute?: number;
  /** Update only. */
  active?: boolean;
}

export interface TrustedIssuerFields {
  issuer: string;
  audience: string;
  jwksUri?: string;
  scopeClaim?: string;
  enabled?: boolean;
  /** "jwks" (published keys, the default) or "hs256" (a shared secret). */
  kind?: "jwks" | "hs256";
  /** An hs256 issuer's shared secret. Write-only: never echoed, not even in the preview. Omit to keep the stored one. */
  secret?: string;
}

const clients = (domainId: number) => `/api/v1/domains/${domainId}/clients`;
const client = (domainId: number, clientId: string) => `${clients(domainId)}/${encodeURIComponent(clientId)}`;
const issuers = (domainId: number) => `/api/v1/domains/${domainId}/issuers`;
const issuer = (domainId: number, name: string) => `${issuers(domainId)}/${encodeURIComponent(name)}`;

const described = (fields: object) =>
  Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");

const again = (tool: string) => `Re-run ${tool} with confirm:true to proceed.`;

export async function listDomainClients(rc: RequestClient, domainId: number): Promise<ToolResult> {
  return run(() => rc.request("GET", clients(domainId)));
}

export async function createDomainClient(
  rc: RequestClient,
  domainId: number,
  fields: DomainClientFields,
  confirm?: boolean,
): Promise<ToolResult> {
  if (confirm !== true) {
    return ok(
      `Preview — will create an API client on domain ${domainId}${fields.name ? ` named "${fields.name}"` : ""}` +
        `${fields.scopes ? ` that may be granted "${fields.scopes}"` : " with no scopes"}.\n` +
        `Its clientSecret is shown ONLY in the reply, never again — surface it to the user immediately.\n` +
        again("create_domain_client"),
    );
  }
  // `active` is an update: a client is created on.
  const body = {
    name: fields.name,
    scopes: fields.scopes,
    tokenLifetimeMinutes: fields.tokenLifetimeMinutes,
    rateLimitPerMinute: fields.rateLimitPerMinute,
  };
  return run(() => rc.request("POST", clients(domainId), body));
}

export async function updateDomainClient(
  rc: RequestClient,
  domainId: number,
  clientId: string,
  fields: DomainClientFields,
  confirm?: boolean,
): Promise<ToolResult> {
  const summary = described(fields);
  if (!summary) {
    return ok(`Nothing to update — pass at least one of name/scopes/tokenLifetimeMinutes/rateLimitPerMinute/active.`);
  }
  if (confirm !== true) {
    return ok(
      `Preview — will update API client ${clientId} on domain ${domainId}: ${summary}.` +
        `${fields.active === false ? "\nIts tokens are refused from the next request." : ""}` +
        `${fields.rateLimitPerMinute === 0 ? "\nIts own rate limit is removed; the site's limits still apply." : ""}\n` +
        again("update_domain_client"),
    );
  }
  return run(() => rc.request("PATCH", client(domainId, clientId), fields));
}

export async function rotateDomainClientSecret(
  rc: RequestClient,
  domainId: number,
  clientId: string,
  confirm?: boolean,
): Promise<ToolResult> {
  if (confirm !== true) {
    return ok(
      `Preview — will give API client ${clientId} on domain ${domainId} a new secret. The old secret stops working ` +
        `immediately, and so do the tokens it already bought.\nThe new clientSecret is shown ONLY in the reply.\n` +
        again("rotate_domain_client_secret"),
    );
  }
  return run(() => rc.request("POST", `${client(domainId, clientId)}/rotate-secret`));
}

export async function revokeDomainClientTokens(
  rc: RequestClient,
  domainId: number,
  clientId: string,
  confirm?: boolean,
): Promise<ToolResult> {
  if (confirm !== true) {
    return ok(
      `Preview — will refuse every token issued so far to API client ${clientId} on domain ${domainId}, from the ` +
        `next request. The secret keeps working, so the client can fetch a new token.\n` +
        again("revoke_domain_client_tokens"),
    );
  }
  return run(async () => {
    await rc.request("POST", `${client(domainId, clientId)}/revoke-tokens`);
    return `Revoked the tokens of API client ${clientId} on domain ${domainId}.`;
  });
}

export async function deleteDomainClient(
  rc: RequestClient,
  domainId: number,
  clientId: string,
  confirm?: boolean,
): Promise<ToolResult> {
  if (confirm !== true) {
    return ok(
      `Preview — will permanently delete API client ${clientId} on domain ${domainId}. Its tokens are refused from ` +
        `the next request. (update_domain_client with active:false is the reversible way.)\n` +
        again("delete_domain_client"),
    );
  }
  return run(async () => {
    await rc.request("DELETE", client(domainId, clientId));
    return `Deleted API client ${clientId} on domain ${domainId}.`;
  });
}

export async function rotateDomainSigningKey(rc: RequestClient, domainId: number, confirm?: boolean): Promise<ToolResult> {
  if (confirm !== true) {
    return ok(
      `Preview — will create a new signing key for domain ${domainId}. New tokens are signed with it; the previous key ` +
        `keeps verifying until the tokens it signed have expired, so nothing valid is cut off.\n` +
        again("rotate_domain_signing_key"),
    );
  }
  return run(() => rc.request("POST", `/api/v1/domains/${domainId}/signing-keys/rotate`));
}

export async function listTrustedIssuers(rc: RequestClient, domainId: number): Promise<ToolResult> {
  return run(() => rc.request("GET", issuers(domainId)));
}

export async function setTrustedIssuer(
  rc: RequestClient,
  domainId: number,
  name: string,
  fields: TrustedIssuerFields,
  confirm?: boolean,
): Promise<ToolResult> {
  if (confirm !== true) {
    // The secret is a signing key: a preview is text an assistant repeats, so it only says one is being set.
    const { secret, ...shown } = fields;
    const secretNote =
      secret !== undefined
        ? ` A shared secret of ${new TextEncoder().encode(secret).length} bytes will be stored encrypted (never shown again).`
        : fields.kind === "hs256"
          ? " No secret given: the stored one is kept (the call fails if there is none)."
          : "";
    return ok(
      `Preview — domain ${domainId} will accept tokens from ${JSON.stringify(fields.issuer)} (as "${name}") whose aud ` +
        `contains ${JSON.stringify(fields.audience)}, on its jwt / apiKeyOrJwt endpoints. ${described(shown)}.${secretNote}\n` +
        `The issuer is compared to a token's iss byte for byte, trailing slash included.\n` +
        again("set_trusted_issuer"),
    );
  }
  return run(() => rc.request("PUT", issuer(domainId, name), fields));
}

export async function deleteTrustedIssuer(
  rc: RequestClient,
  domainId: number,
  name: string,
  confirm?: boolean,
): Promise<ToolResult> {
  if (confirm !== true) {
    return ok(
      `Preview — domain ${domainId} will stop trusting issuer "${name}". Its tokens are refused from the next request.\n` +
        again("delete_trusted_issuer"),
    );
  }
  return run(async () => {
    await rc.request("DELETE", issuer(domainId, name));
    return `Domain ${domainId} no longer trusts issuer "${name}".`;
  });
}

/**
 * Without a token: fetch the issuer's keys now (is the configuration reachable?). With one: run it
 * through the gateway's own check and say which check it fails — or what a block would see.
 */
export async function checkTrustedIssuer(
  rc: RequestClient,
  domainId: number,
  name: string,
  token?: string,
): Promise<ToolResult> {
  return token
    ? run(() => rc.request("POST", `${issuer(domainId, name)}/check`, { token }))
    : run(() => rc.request("POST", `${issuer(domainId, name)}/probe`));
}
