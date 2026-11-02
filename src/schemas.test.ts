import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  addToWorkspaceSchema,
  setWorkspaceContentSchema,
  blockSchema,
  deleteBlockSchema,
  fileSchema,
  linkSchema,
  updateBlockSchema,
  writeFileSchema,
} from "./schemas.js";

const minimalBlock = { type: "Process", code: "return input;" };

// ---- strictness -------------------------------------------------------------
// The regression these guard: Zod's default strips unknown keys, so a payload carrying a field the
// server doesn't understand was accepted, silently dropped, and answered 200 with an empty result.

test("add_to_workspace: an unknown top-level field is rejected, not dropped", () => {
  const result = addToWorkspaceSchema.safeParse({
    workspaceId: 1,
    blocks: [minimalBlock],
    fils: [{ name: "utils.js", content: "" }], // typo for `files`
  });

  assert.equal(result.success, false);
  assert.match(JSON.stringify(result.error?.issues), /unrecognized_keys|fils/);
});

test("set_workspace_content: an unknown top-level field is rejected", () => {
  const result = setWorkspaceContentSchema.safeParse({
    workspaceId: 1,
    blocks: [],
    camera: { x: 0, y: 0 },
  });

  assert.equal(result.success, false);
});

test("an unknown field inside a block is rejected", () => {
  const result = addToWorkspaceSchema.safeParse({
    workspaceId: 1,
    blocks: [{ type: "Process", javascript: "return 1;" }], // should be `code`
  });

  assert.equal(result.success, false);
});

test("an unknown field inside a file is rejected", () => {
  assert.equal(fileSchema.safeParse({ name: "a.js", body: "x" }).success, false);
});

test("an unknown field inside a link is rejected", () => {
  assert.equal(linkSchema.safeParse({ from: 1, to: 2, label: "x" }).success, false);
});

// ---- still accepts what it should ------------------------------------------

test("a valid payload with files round-trips", () => {
  const result = addToWorkspaceSchema.safeParse({
    workspaceId: 7,
    blocks: [{ id: 1, type: "API Endpoint", endpointPath: "orders", label: "In" }, minimalBlock],
    links: [{ from: 1, to: 2 }],
    files: [{ name: "lib/http.js", content: "function get() {}" }],
  });

  assert.equal(result.success, true);
  assert.equal(result.data?.files?.[0].name, "lib/http.js");
});

test("optional fields may be omitted", () => {
  assert.equal(addToWorkspaceSchema.safeParse({ workspaceId: 1, blocks: [] }).success, true);
  assert.equal(blockSchema.safeParse(minimalBlock).success, true);
});

// ---- update_block / delete_block --------------------------------------------

test("update_block: a single-field patch is valid", () => {
  const result = updateBlockSchema.safeParse({ workspaceId: 1, blockId: 4, code: "return 99;" });

  assert.equal(result.success, true);
  assert.equal(result.data?.code, "return 99;");
  assert.equal(result.data?.label, undefined, "omitted fields must stay omitted, not be defaulted");
});

test("update_block: an empty string is allowed (it clears the field)", () => {
  assert.equal(updateBlockSchema.safeParse({ workspaceId: 1, blockId: 4, code: "" }).success, true);
});

test("update_block: workspaceId and blockId are required", () => {
  assert.equal(updateBlockSchema.safeParse({ workspaceId: 1, code: "x" }).success, false);
  assert.equal(updateBlockSchema.safeParse({ blockId: 1, code: "x" }).success, false);
});

test("update_block: an unknown field is rejected", () => {
  assert.equal(
    updateBlockSchema.safeParse({ workspaceId: 1, blockId: 4, cod: "return 1;" }).success,
    false,
  );
});

test("update_block: signalRGuid is not patchable", () => {
  assert.equal(
    updateBlockSchema.safeParse({ workspaceId: 1, blockId: 4, signalRGuid: "abc" }).success,
    false,
  );
});

test("delete_block: confirm is optional and an unknown field is rejected", () => {
  assert.equal(deleteBlockSchema.safeParse({ workspaceId: 1, blockId: 2 }).success, true);
  assert.equal(deleteBlockSchema.safeParse({ workspaceId: 1, blockId: 2, confirm: true }).success, true);
  assert.equal(deleteBlockSchema.safeParse({ workspaceId: 1, blockId: 2, force: true }).success, false);
});

// ---- the SEO reporting dial -------------------------------------------------
// It is optional everywhere and reports rather than gates, so the only way it can hurt is by
// rejecting a legitimate write. These pin that it can't.

test("seo is optional on every write tool and takes the three modes", () => {
  const page = { name: "pages/index.html", content: "<!doctype html><html></html>" };

  for (const mode of [undefined, "full", "minimal", "none"]) {
    assert.equal(
      writeFileSchema.safeParse({ workspaceId: 1, ...page, ...(mode ? { seo: mode } : {}) }).success,
      true,
      `write_file seo:${mode}`,
    );
    assert.equal(
      setWorkspaceContentSchema.safeParse({ workspaceId: 1, blocks: [], files: [page], ...(mode ? { seo: mode } : {}) }).success,
      true,
      `set_workspace_content seo:${mode}`,
    );
    assert.equal(
      addToWorkspaceSchema.safeParse({ workspaceId: 1, blocks: [], files: [page], ...(mode ? { seo: mode } : {}) }).success,
      true,
      `add_to_workspace seo:${mode}`,
    );
  }
});

test("an unknown seo mode is rejected rather than silently treated as full", () => {
  const result = writeFileSchema.safeParse({
    workspaceId: 1,
    name: "pages/index.html",
    content: "<!doctype html>",
    seo: "off", // the word is "none"
  });

  assert.equal(result.success, false);
});

// ---- the schema still reaches the client ------------------------------------
// Passing a ZodObject (rather than a raw shape) as `inputSchema` is what makes .strict() possible;
// this proves the SDK still advertises the parameters to callers.

test("tools/list advertises every parameter of the strict schema", async () => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  server.registerTool(
    "add_to_workspace",
    { title: "Append", description: "test", inputSchema: addToWorkspaceSchema },
    async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  );

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "add_to_workspace");

  assert.ok(tool, "tool should be listed");
  assert.equal(tool.inputSchema.type, "object");
  assert.deepEqual(
    Object.keys(tool.inputSchema.properties ?? {}).sort(),
    ["blocks", "files", "links", "seo", "workspaceId", "zones"],
  );
  assert.deepEqual(tool.inputSchema.required, ["workspaceId", "blocks"]);

  await client.close();
  await server.close();
});

test("an unknown field is rejected end-to-end through a tool call", async () => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  let handlerRan = false;
  server.registerTool(
    "add_to_workspace",
    { title: "Append", description: "test", inputSchema: addToWorkspaceSchema },
    async () => {
      handlerRan = true;
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  );

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const result = await client.callTool({
    name: "add_to_workspace",
    arguments: { workspaceId: 1, blocks: [], fils: [] },
  });

  assert.equal(handlerRan, false, "the handler must not run on invalid input");
  assert.equal(result.isError, true);

  await client.close();
  await server.close();
});

// ---- zones ------------------------------------------------------------------
// The canvas areas travel with the content, so the schema has to accept a well-formed one and
// reject the shapes that would silently produce a rectangle nobody can see.

test("zones: a well-formed area is accepted on both content writes", () => {
  const zone = {
    label: "Auth & Security",
    subtitle: "Sign-in and sessions",
    color: "#a78bfa",
    icon: "shield" as const,
    i: 1, j: 1, w: 44, h: 8,
  };

  assert.equal(setWorkspaceContentSchema.safeParse({ workspaceId: 1, blocks: [], zones: [zone] }).success, true);
  assert.equal(addToWorkspaceSchema.safeParse({ workspaceId: 1, blocks: [], zones: [zone] }).success, true);
});

test("zones: omitting them is legal — that is how a caller says 'leave mine alone'", () => {
  assert.equal(setWorkspaceContentSchema.safeParse({ workspaceId: 1, blocks: [] }).success, true);
  assert.equal(setWorkspaceContentSchema.safeParse({ workspaceId: 1, blocks: [], zones: [] }).success, true);
});

test("zones: a zone with no size is refused rather than drawn as nothing", () => {
  const base = { label: "Data", i: 1, j: 1, w: 10, h: 4 };
  assert.equal(setWorkspaceContentSchema.safeParse({ workspaceId: 1, blocks: [], zones: [base] }).success, true);
  assert.equal(
    setWorkspaceContentSchema.safeParse({ workspaceId: 1, blocks: [], zones: [{ ...base, w: 0 }] }).success,
    false,
  );
  assert.equal(
    setWorkspaceContentSchema.safeParse({ workspaceId: 1, blocks: [], zones: [{ ...base, h: -2 }] }).success,
    false,
  );
});

test("zones: an unknown icon is refused, not silently dropped to the fallback", () => {
  // Accepting it would draw a gear and leave the author believing they picked something else.
  assert.equal(
    setWorkspaceContentSchema.safeParse({
      workspaceId: 1, blocks: [],
      zones: [{ label: "X", icon: "rocket", i: 1, j: 1, w: 4, h: 4 }],
    }).success,
    false,
  );
});

test("zones: a label is required — an unnamed area explains nothing", () => {
  assert.equal(
    setWorkspaceContentSchema.safeParse({ workspaceId: 1, blocks: [], zones: [{ i: 1, j: 1, w: 4, h: 4 }] }).success,
    false,
  );
});
