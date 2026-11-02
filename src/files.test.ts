import { test } from "node:test";
import assert from "node:assert/strict";
import { codeFilePath } from "./files.js";
import { writeFileSchema, editFileSchema, deleteFileSchema, readFileSchema, listFilesSchema } from "./schemas.js";

// ---- addressing -------------------------------------------------------------

test("a folder separator stays a separator", () => {
  // The failure this prevents is silent and total: encodeURIComponent over the whole name sends
  // "pages%2Fapp.css", which the catch-all route doesn't match, so every write to a file in a
  // folder 404s against a file that exists.
  assert.equal(
    codeFilePath(87, "pages/app.css"),
    "/api/v1/workspaces/87/content/files/pages/app.css",
  );
});

test("a flat name needs no escaping", () => {
  assert.equal(codeFilePath(1, "utils.js"), "/api/v1/workspaces/1/content/files/utils.js");
});

test("case is preserved — names are case-sensitive", () => {
  assert.equal(codeFilePath(1, "lib/HttpClient.js"), "/api/v1/workspaces/1/content/files/lib/HttpClient.js");
});

test("characters that would be URL syntax are escaped, so they reach the server as data", () => {
  // CodeFileRules rejects these names, but that verdict is the server's to give — the encoder's job
  // is to make sure the request lands on the file route carrying the name the caller asked for.
  assert.equal(codeFilePath(1, "a b?c.js"), "/api/v1/workspaces/1/content/files/a%20b%3Fc.js");
});

test("dot segments are refused rather than sent", () => {
  // Escaping can't save these: "." and ".." are path syntax, and the HTTP client normalises them
  // away before the request goes out — "../secrets.js" would address a DIFFERENT endpoint and come
  // back as a 404 that says nothing about the real problem.
  for (const bad of ["../secrets.js", "pages/../../x.js", "./a.js", "pages//a.js"]) {
    assert.throws(() => codeFilePath(1, bad), /Invalid code file name/, bad);
  }
});

// ---- schemas ----------------------------------------------------------------
// Same lesson as the block schemas: Zod strips unknown keys by default, so a typo'd field is
// accepted, dropped, and answered 200 — the caller believes it wrote something it didn't.

test("write_file: an unknown field is rejected, not dropped", () => {
  const result = writeFileSchema.safeParse({
    workspaceId: 1,
    name: "a.js",
    content: "const a = 1;",
    append: true, // there is no partial write; failing loudly beats silently replacing the file
  });

  assert.equal(result.success, false);
});

test("write_file: content is required — omitting it must not mean 'empty'", () => {
  // Truncating a file to nothing has to be deliberate: write "" on purpose.
  assert.equal(writeFileSchema.safeParse({ workspaceId: 1, name: "a.js" }).success, false);
  assert.equal(writeFileSchema.safeParse({ workspaceId: 1, name: "a.js", content: "" }).success, true);
});

test("read_file / list_files take exactly what they need", () => {
  assert.equal(readFileSchema.safeParse({ workspaceId: 1, name: "a.js" }).success, true);
  assert.equal(readFileSchema.safeParse({ workspaceId: 1 }).success, false);
  assert.equal(listFilesSchema.safeParse({ workspaceId: 1 }).success, true);
  assert.equal(listFilesSchema.safeParse({ workspaceId: 1, name: "a.js" }).success, false);
});

test("edit_file: the anchor is required and may not be empty", () => {
  // An empty anchor matches everywhere and nowhere useful; letting it through would turn an edit
  // into a splice at position 0 that the caller never asked for.
  assert.equal(
    editFileSchema.safeParse({ workspaceId: 1, name: "a.js", oldString: "", newString: "x" }).success,
    false,
  );
  assert.equal(
    editFileSchema.safeParse({ workspaceId: 1, name: "a.js", oldString: "a", newString: "b" }).success,
    true,
  );
});

test("edit_file: an empty replacement is legal — that is how you delete a passage", () => {
  assert.equal(
    editFileSchema.safeParse({ workspaceId: 1, name: "a.js", oldString: "drop;", newString: "" }).success,
    true,
  );
});

test("edit_file: newString is required — omitting it must not mean 'delete'", () => {
  assert.equal(editFileSchema.safeParse({ workspaceId: 1, name: "a.js", oldString: "a" }).success, false);
});

test("edit_file: an unknown field is rejected, not dropped", () => {
  // e.g. a caller reaching for "content" out of habit: accepting and ignoring it would report a
  // successful edit that replaced nothing of what they meant.
  assert.equal(
    editFileSchema.safeParse({ workspaceId: 1, name: "a.js", oldString: "a", newString: "b", content: "x" }).success,
    false,
  );
});

test("delete_file: confirm is optional in the schema — the tool gates on it", () => {
  // The preview-then-confirm handshake lives in the handler, like every other destructive tool;
  // requiring it here would make the preview call itself a schema error.
  assert.equal(deleteFileSchema.safeParse({ workspaceId: 1, name: "a.js" }).success, true);
  assert.equal(deleteFileSchema.safeParse({ workspaceId: 1, name: "a.js", confirm: true }).success, true);
});
