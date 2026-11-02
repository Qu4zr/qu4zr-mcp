import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectLocalFiles, digest, remoteName, syncArgsProblem, syncBody } from "./syncFiles.js";
import { syncFilesSchema } from "./schemas.js";

test("digest matches CodeFileRules.Digest (sha256 of the UTF-8 content, lowercase hex)", () => {
  // Same vector as CodeFileRules: sha256("") — if this drifted, every file would be refused.
  assert.equal(digest(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(digest("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("a prefix becomes a folder, whatever the platform's separator", () => {
  assert.equal(remoteName(undefined, "a.css"), "a.css");
  assert.equal(remoteName("public", "css/a.css"), "public/css/a.css");
  assert.equal(remoteName("public/", "a.css"), "public/a.css");
});

test("a local folder is read as text and base64, hidden and build folders skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qu4zr-sync-"));
  try {
    await mkdir(join(dir, "css"));
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "index.html"), "<!doctype html>");
    await writeFile(join(dir, "css", "app.css"), "body{}");
    await writeFile(join(dir, "og.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(dir, ".env"), "SECRET=1");
    await writeFile(join(dir, "notes.docx"), "x");
    await writeFile(join(dir, "node_modules", "x.js"), "x");

    const { items, skipped } = await collectLocalFiles(dir, "site");

    assert.deepEqual(items.map((i) => i.name), ["site/css/app.css", "site/index.html", "site/og.png"]);
    assert.equal(items.find((i) => i.name === "site/og.png")!.content, "iVBORw==");
    for (const item of items) assert.equal(item.sha256, digest(item.content));
    assert.deepEqual(skipped.map((s) => s.reason).sort(), ["build or dependency folder", "hidden", "not a code-file type qu4zr stores"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the body carries every sha256 so the server can refuse a corrupted transfer", () => {
  const body = syncBody([{ name: "a.js", content: "x", sha256: digest("x") }], true, "public/");
  assert.deepEqual(body, { files: [{ name: "a.js", content: "x", sha256: digest("x") }], deleteMissing: true, deletePrefix: "public/" });
});

test("sync_files: exactly one source, and an unknown field is rejected", () => {
  assert.equal(syncFilesSchema.safeParse({ workspaceId: 1, localDir: "C:/site" }).success, true);
  assert.equal(syncFilesSchema.safeParse({ workspaceId: 1, files: [{ name: "a.js", content: "x" }] }).success, true);
  assert.equal(syncFilesSchema.safeParse({ workspaceId: 1, localDir: "C:/site", nope: 1 }).success, false);
  assert.equal(syncArgsProblem({ localDir: "C:/site" }), null);
  assert.match(syncArgsProblem({})!, /exactly one/);
  assert.match(syncArgsProblem({ localDir: "C:/site", files: [] })!, /exactly one/);
});
