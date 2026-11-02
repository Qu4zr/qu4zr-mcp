import { strict as assert } from "node:assert";
import test from "node:test";
import { describeNotes, isEndpoint, notesForBlock, notesForContent, runsCode } from "./writeNotes.js";

test("only a Process block — or an untyped one — runs its code", () => {
  // Untyped is Process: that is the write default, and flagging it would fire on the commonest
  // payload there is, which is how a warning becomes noise.
  assert.equal(runsCode("Process"), true);
  assert.equal(runsCode("process"), true);
  assert.equal(runsCode(undefined), true);
  assert.equal(runsCode("API Endpoint"), false);
  assert.equal(runsCode("Raw data"), false);
  assert.equal(runsCode("Schedule"), false);
  assert.equal(runsCode("SignalR"), false);
});

test("code on an API Endpoint block is reported as never running, and where to put it", () => {
  const notes = notesForBlock({ id: 3, type: "API Endpoint", label: "Queue", code: "return 1;" });

  assert.match(notes.join("\n"), /NEVER run/);
  assert.match(notes.join("\n"), /Process block/);
});

test("a SignalR block gets the remedy that belongs to it", () => {
  // Sending its author to a Process block would be advice that undoes what they were building.
  const notes = notesForBlock({ id: 4, type: "SignalR", code: "return 1;" });

  assert.match(notes.join("\n"), /handlerCode/);
});

test("code on a Process block says nothing", () => {
  assert.deepEqual(notesForBlock({ id: 1, type: "Process", code: "return 1;" }), []);
});

test("an endpointPath is reported as not being a url", () => {
  const notes = notesForBlock({ id: 25, type: "API Endpoint", endpointPath: "api/check" });

  assert.equal(notes.length, 1);
  assert.match(notes[0], /deploy_endpoint/);
  assert.match(notes[0], /404/);
});

test("an endpoint with nothing downstream is reported when the links are known", () => {
  const notes = notesForContent(
    [
      { id: 1, type: "API Endpoint", label: "Door" },
      { id: 2, type: "Process", code: "return 1;" },
    ],
    [{ from: 3, to: 2 }],
  );

  assert.match(notes.join("\n"), /answers null to every caller/);
});

test("an endpoint that is linked, serves a file, or carries rawData is left alone", () => {
  assert.deepEqual(
    notesForContent([{ id: 1, type: "API Endpoint" }], [{ from: 1, to: 2 }]),
    [],
  );
  assert.deepEqual(notesForContent([{ id: 1, type: "API Endpoint", staticFile: "pages/index.html" }], []), []);
  assert.deepEqual(notesForContent([{ id: 1, type: "API Endpoint", rawData: "{}" }], []), []);
});

test("with no links supplied the dead-end rule stays silent", () => {
  // A per-block patch carries no links, and reading "none given" as "none exist" would fire the
  // warning on every single-block edit in a perfectly wired workspace.
  assert.deepEqual(notesForBlock({ id: 1, type: "API Endpoint" }), []);
});

test("a block is named by its label and its id", () => {
  const notes = notesForBlock({ id: 42, type: "API Endpoint", label: "Accept", endpointPath: "api/accept" });

  assert.match(notes[0], /"Accept" \(block 42\)/);
});

test("an unlabelled block is still named", () => {
  const notes = notesForBlock({ id: 7, type: "API Endpoint", endpointPath: "x" });

  assert.match(notes[0], /block 7/);
});

test("nothing to say renders as nothing", () => {
  assert.equal(describeNotes([]), undefined);
  assert.match(describeNotes(["a"]) ?? "", /^Heads up:\n- a$/);
});

test("isEndpoint is case insensitive", () => {
  assert.equal(isEndpoint("api endpoint"), true);
  assert.equal(isEndpoint("Process"), false);
});
