import { test } from "node:test";
import assert from "node:assert/strict";
import { fail, ok, withNote } from "./helpers.js";

/**
 * `withNote` carries an advisory back with a result that already succeeded — today the SEO reading
 * of a page that was just written. Two rules make it safe to attach to any write.
 */

test("the note is a SECOND content block, so the payload stays parseable", () => {
  // The caller came for the JSON the API returned; appending prose to it would make that JSON
  // unparseable for anything reading the first block.
  const result = withNote(ok({ name: "pages/index.html" }), "SEO — no canonical.");

  assert.equal(result.content.length, 2);
  assert.deepEqual(JSON.parse(result.content[0].text), { name: "pages/index.html" });
  assert.match(result.content[1].text, /canonical/);
});

test("a failed call is left alone", () => {
  // Advice about a page that was not written is noise stacked on top of an error.
  const result = withNote(fail(new Error("409 conflict")), "SEO — no canonical.");

  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
});

test("nothing to say adds nothing", () => {
  const result = ok({ ok: true });

  assert.equal(withNote(result, undefined), result);
  assert.equal(withNote(result, ""), result);
});

test("an empty response body becomes an explicit success", () => {
  // Every 204 — the revokes, the deletes, pausing a schedule — reaches ok() as undefined, and
  // JSON.stringify(undefined) is the VALUE undefined rather than a string. The result went out
  // with text: undefined and the transport rejected it as invalid, on a call that had in fact
  // succeeded: the caller was told its revoke failed while the device was revoked.
  const result = ok(undefined);

  assert.equal(typeof result.content[0].text, "string");
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: true });
});

test("a literal null body is treated the same way", () => {
  assert.deepEqual(JSON.parse(ok(null).content[0].text), { ok: true });
});

test("a real payload is left alone", () => {
  assert.deepEqual(JSON.parse(ok({ id: 7 }).content[0].text), { id: 7 });
});

test("a string passes straight through", () => {
  assert.equal(ok("published").content[0].text, "published");
});
