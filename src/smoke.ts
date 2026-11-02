#!/usr/bin/env node
/**
 * One-command end-to-end check: token → create workspace → set content → read back.
 * Run with your API-client credentials in the environment:
 *
 *   QU4ZR_CLIENT_ID=… QU4ZR_CLIENT_SECRET=… npm run smoke
 *
 * On success it leaves an "MCP smoke …" workspace in your account so you can open it
 * on the canvas as visual proof, then delete it from the UI.
 *
 * Optionally also exercises the endpoint lifecycle (deploy → toggle off → toggle on →
 * update → delete) plus domain API key management (create → update → rotate → delete)
 * against a real domain — set QU4ZR_DOMAIN_ID (an id from GET /api/v1/domains) to opt
 * in. Skipped by default since it requires a domain to already exist.
 */

import { Qu4zrClient } from "./client.js";

const baseUrl = (process.env.QU4ZR_BASE_URL ?? "https://api.management.qu4zr.io").replace(/\/+$/, "");
const clientId = process.env.QU4ZR_CLIENT_ID;
const clientSecret = process.env.QU4ZR_CLIENT_SECRET;
const domainId = process.env.QU4ZR_DOMAIN_ID;

if (!clientId || !clientSecret) {
  console.error("Set QU4ZR_CLIENT_ID and QU4ZR_CLIENT_SECRET (Account → API Access).");
  process.exit(1);
}

const client = new Qu4zrClient({
  baseUrl,
  clientId,
  clientSecret,
  scopes: ["flows:read", "flows:write", "flows:deploy"],
});

async function main() {
  console.log(`→ ${baseUrl}`);

  console.log("1/3  authenticate + create workspace…");
  const ws = await client.request<{ id: number; name: string }>("POST", "/api/v1/workspaces", {
    name: `MCP smoke ${new Date().toISOString().slice(0, 19)}`,
  });
  console.log(`     created workspace #${ws.id} "${ws.name}"`);

  console.log("2/3  set content (2 blocks + 1 link)…");
  await client.request("PUT", `/api/v1/workspaces/${ws.id}/content`, {
    blocks: [
      { id: 1, type: "API Endpoint", label: "Webhook", endpointPath: "hello" },
      { id: 2, type: "Process", label: "Echo", code: "return input.body;" },
    ],
    links: [{ from: 1, to: 2 }],
  });

  console.log("3/3  read it back…");
  const content = await client.request("GET", `/api/v1/workspaces/${ws.id}/content`);
  console.log(JSON.stringify(content, null, 2));

  if (domainId) {
    console.log(`\n→ QU4ZR_DOMAIN_ID set — exercising endpoint lifecycle in domain ${domainId}…`);

    console.log("4/6  deploy block 1 as an endpoint…");
    const path = `mcp-smoke-${Date.now()}`;
    const deployed = await client.request<{ id: number; url: string }>(
      "POST",
      `/api/v1/workspaces/${ws.id}/blocks/1/endpoint`,
      { domainId: Number(domainId), path },
    );
    console.log(`     deployed endpoint #${deployed.id} → ${deployed.url}`);

    console.log("5/11 toggle off, then back on…");
    const off = await client.request<{ isEnabled: boolean }>("POST", `/api/v1/endpoints/${deployed.id}/toggle`);
    if (off.isEnabled !== false) throw new Error(`expected isEnabled=false after first toggle, got ${off.isEnabled}`);
    const on = await client.request<{ isEnabled: boolean }>("POST", `/api/v1/endpoints/${deployed.id}/toggle`);
    if (on.isEnabled !== true) throw new Error(`expected isEnabled=true after second toggle, got ${on.isEnabled}`);
    console.log("     toggled off → on, isEnabled matched at each step");

    console.log("6/11 update notes + allowedVerbs…");
    const updated = await client.request<{ allowedVerbs: string[]; notes?: string }>(
      "PATCH",
      `/api/v1/endpoints/${deployed.id}`,
      { allowedVerbs: ["GET"], notes: "mcp smoke test" },
    );
    if (JSON.stringify(updated.allowedVerbs) !== JSON.stringify(["GET"])) {
      throw new Error(`expected allowedVerbs=["GET"], got ${JSON.stringify(updated.allowedVerbs)}`);
    }
    console.log("     update_endpoint applied and reflected in the response");

    console.log("7/11 delete the endpoint…");
    await client.request("DELETE", `/api/v1/endpoints/${deployed.id}`);
    const endpoints = await client.request<Array<{ id: number }>>("GET", `/api/v1/workspaces/${ws.id}/endpoints`);
    if (endpoints.some((e) => e.id === deployed.id)) throw new Error("endpoint still listed after delete");
    console.log("     confirmed gone from list_endpoints");

    console.log("8/11 create a domain API key…");
    const key = await client.request<{ id: number; apiKey: string }>(
      "POST",
      `/api/v1/domains/${domainId}/keys`,
      { name: "mcp smoke key" },
    );
    if (!key.apiKey) throw new Error("expected a plaintext apiKey in the create response");
    console.log(`     created key #${key.id} (plaintext present)`);

    console.log("9/11 update its name…");
    const renamed = await client.request<{ name?: string }>(
      "PATCH",
      `/api/v1/domains/${domainId}/keys/${key.id}`,
      { name: "mcp smoke key (renamed)" },
    );
    if (renamed.name !== "mcp smoke key (renamed)") throw new Error(`expected renamed name, got ${renamed.name}`);
    console.log("     renamed and reflected in the response");

    console.log("10/11 rotate it…");
    const rotated = await client.request<{ newKey: { id: number; apiKey: string }; oldKey: { isActive: boolean } }>(
      "POST",
      `/api/v1/domains/${domainId}/keys/${key.id}/rotate`,
      {},
    );
    if (!rotated.newKey.apiKey) throw new Error("expected a plaintext apiKey in the rotate response");
    if (rotated.oldKey.isActive !== false) throw new Error("expected old key deactivated (keepOldKeyActive was not set)");
    console.log(`     rotated → new key #${rotated.newKey.id}, old key deactivated`);

    console.log("11/11 delete the (rotated) key…");
    await client.request("DELETE", `/api/v1/domains/${domainId}/keys/${rotated.newKey.id}`);
    const keys = await client.request<Array<{ id: number }>>("GET", `/api/v1/domains/${domainId}/keys`);
    if (keys.some((k) => k.id === rotated.newKey.id)) throw new Error("key still listed after delete");
    console.log("     confirmed gone from list_domain_api_keys");
  } else {
    console.log(
      "\n(Set QU4ZR_DOMAIN_ID to also exercise deploy/toggle/update/delete and domain API key " +
        "create/update/rotate/delete against a real domain.)",
    );
  }

  console.log(`\n✓ Success. Open qu4zr and look for workspace "${ws.name}" (#${ws.id}) on the canvas.`);
}

main().catch((err) => {
  console.error(`\n✗ Smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
