import { test } from "node:test";
import assert from "node:assert/strict";
import { check, checkBlock, checkFile, preflight, stripImports } from "./validate.js";

/**
 * The local pre-flight parse. Its job is to catch a typo before the write leaves the client; its
 * obligation is to agree with the server, because a client that rejects code the platform accepts
 * is worse than no client check at all.
 */

// ---- imports ----------------------------------------------------------------
// `import "…";` is a preprocessor directive, not ESM. If this regex drifts from
// Core/Grids/ImportLines.cs, the client starts rejecting code the server runs happily.

test("a code file import is not an error", () => {
  assert.equal(checkBlock({ id: 1, code: 'import "lib/http.js";\nreturn { ok: true };' }), null);
});

test("an npm bundle import is not an error", () => {
  assert.equal(checkBlock({ id: 1, code: 'import "zod@4.4.3";\nreturn { ok: true };' }), null);
});

test("every accepted import spelling parses", () => {
  const code = `  import 'a.js'\nimport "b/c.js";\n    import "date-fns@4.1.0"; // pinned\nreturn 1;`;
  assert.equal(checkBlock({ id: 1, code }), null);
});

test("stripImports keeps line count so positions stay true", () => {
  const stripped = stripImports('import "a.js";\nimport "b.js";\nreturn 1;');
  assert.equal(stripped.split("\n").length, 3);
  assert.match(stripped, /^\/\/ import "a\.js"/);
});

test("an error after an import keeps its real line number", () => {
  const diagnostic = checkBlock({ id: 1, code: 'import "a.js";\nimport "b.js";\nconst = 3;\nreturn 1;' });
  assert.equal(diagnostic?.line, 3);
});

test("real ESM syntax is still rejected", () => {
  // Why the parse is sourceType "script" and not "module": the runtime has no module system.
  assert.notEqual(checkBlock({ id: 1, code: 'import { z } from "zod@4.4.3";\nreturn 1;' }), null);
  assert.notEqual(checkFile({ name: "lib/a.js", content: "export const a = 1;" }), null);
});

// ---- blocks vs files --------------------------------------------------------

test("a top-level return is legal in a block", () => {
  assert.equal(checkBlock({ id: 1, code: "return input;" }), null);
});

test("a top-level return in a FILE is reported", () => {
  // "Files define, blocks return."
  const diagnostic = checkFile({ name: "utils.js", content: "return 1;" });
  assert.equal(diagnostic?.fileName, "utils.js");
});

test("top-level await is tolerated", () => {
  assert.equal(checkBlock({ id: 1, code: "const r = await fetch('https://x.test');\nreturn r;" }), null);
});

test("non-javascript files are skipped", () => {
  assert.equal(checkFile({ name: "pages/app.html", content: "<!doctype html><p>hi</p>" }), null);
  assert.equal(checkFile({ name: "pages/app.css", content: "body { color: red; }" }), null);
});

test("non-Process blocks are skipped, blank type is not", () => {
  assert.equal(checkBlock({ id: 1, type: "Raw data", code: "{not js}" }), null);
  // Type defaults to "Process" on write, so a block without one still holds JavaScript.
  assert.notEqual(checkBlock({ id: 1, code: "const = 1;" }), null);
});

test("empty code is not an error", () => {
  assert.equal(checkBlock({ id: 1, code: "" }), null);
  assert.equal(checkBlock({ id: 1 }), null);
});

// ---- diagnostics ------------------------------------------------------------

test("a diagnostic carries the location and names the block", () => {
  const diagnostic = checkBlock({ id: 7, label: "Page", code: "const a = 1;\nconst = 2;\nreturn a;" });

  assert.equal(diagnostic?.blockId, 7);
  assert.equal(diagnostic?.line, 2);
  assert.equal(diagnostic?.source, 'Block 7 "Page"');
  // Acorn appends "(2:6)", which duplicates the structured fields.
  assert.doesNotMatch(diagnostic!.message, /\(\d+:\d+\)$/);
});

test("check reports blocks and files together", () => {
  const diagnostics = check(
    [{ id: 1, code: "const = 1;" }, { id: 2, code: "return 1;" }],
    [{ name: "broken.js", content: "function a( {" }, { name: "fine.js", content: "const x = 1;" }],
  );

  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.some((d) => d.blockId === 1));
  assert.ok(diagnostics.some((d) => d.fileName === "broken.js"));
});

// ---- pre-flight -------------------------------------------------------------

test("preflight throws with the location and says nothing was written", () => {
  assert.throws(
    () => preflight([{ id: 4, code: "return (;" }]),
    (err: Error) => /line 1/.test(err.message) && /nothing was written/i.test(err.message),
  );
});

test("preflight is silent on valid content", () => {
  assert.doesNotThrow(() => preflight([{ id: 1, code: 'import "a.js";\nreturn 1;' }], [{ name: "a.js", content: "const x = 1;" }]));
});
