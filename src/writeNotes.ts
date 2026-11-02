/**
 * What a write was accepted DESPITE — the block-level twin of seo.ts.
 *
 * Every one of these is a legal workspace the server stores happily, which is the problem: the write
 * succeeds, the canvas looks right, and the thing does not work. They are reported here, locally, on
 * the reply to the write that caused them, because that is the only moment the author is still
 * holding the mistake; a rule discovered three tools later is discovered by debugging.
 *
 * Both rules come from one real session. An assistant wrote an entire matchmaking service into the
 * `code` of an API Endpoint block — where no code is ever executed — and left one endpoint declared
 * but never deployed. Twelve tool calls of "fixing" followed, against a build that had never run a
 * line and a URL that never existed. Nothing in any reply said either word.
 *
 * Advisory, never blocking, exactly like seo.ts: a syntax error is a broken file, but a block whose
 * code will not run is a legitimate thing to save on the way to something else. The server's
 * in-app assistant emits the same two notes from `AssistantWriteNotes`, and
 * `AssistantWriteNoteParityTests` reads this file to keep the pair in step.
 */

export interface NotableBlock {
  id?: number;
  type?: string;
  label?: string;
  code?: string;
  endpointPath?: string;
  staticFile?: string;
  rawData?: string;
}

export interface NotableLink {
  from?: number;
  to?: number;
}

/**
 * The one block type whose `code` the sandbox executes.
 *
 * A missing type is a Process block — that is the write default — so an untyped block carrying code
 * is correct and must not be flagged. Raw data, API Endpoint and Schedule blocks answer with their
 * `rawData` and nothing else, at the gateway as much as anywhere: the gateway starts the workflow AT
 * the endpoint block, so its code is not "run on the request", it is not run. A SignalR block runs
 * `handlerCode` on the user's own machine instead.
 */
export function runsCode(type?: string): boolean {
  return !type || type.trim().toLowerCase() === "process";
}

export function isEndpoint(type?: string): boolean {
  return (type ?? "").trim().toLowerCase() === "api endpoint";
}

const nameOf = (block: NotableBlock): string =>
  block.label ? `"${block.label}" (block ${block.id ?? "?"})` : `block ${block.id ?? "?"}`;

/**
 * Notes for one block, plus — when the payload's links are known — whether an endpoint leads
 * anywhere at all. Links are optional because a per-block patch has none, and a rule that silently
 * assumed "no links given" meant "no links exist" would fire on every single-block edit.
 */
export function notesForBlock(block: NotableBlock, links?: NotableLink[]): string[] {
  const notes: string[] = [];

  if (block.code && !runsCode(block.type)) {
    const remedy =
      (block.type ?? "").trim().toLowerCase() === "signalr"
        ? "A SignalR block runs `handlerCode` on the user's own machine instead; put it there."
        : "A block of this type answers with its `rawData` only. If that code is meant to handle the " +
          "request, move it to a Process block and link this block to it: the request flows " +
          "endpoint -> Process, and the Process block reads `request`.";

    notes.push(
      `${nameOf(block)} is a ${block.type} block, and its \`code\` will NEVER run — not on a request, ` +
        `not at the gateway, not anywhere. ${remedy}`,
    );
  }

  if (block.endpointPath) {
    notes.push(
      `${nameOf(block)} carries endpointPath "${block.endpointPath}", which publishes NOTHING on its ` +
        `own — the path is a note on the block until deploy_endpoint runs. Until then that URL answers ` +
        `404, and a page calling it fails with exactly the 404 it would give if the code were broken.`,
    );
  }

  if (links && isEndpoint(block.type) && !block.staticFile && !block.rawData) {
    const hasDownstream = links.some((l) => l.from === block.id);
    if (!hasDownstream) {
      notes.push(
        `${nameOf(block)} is an API Endpoint with nothing downstream, no staticFile and no rawData, so ` +
          `it answers null to every caller and always will. Link it to a Process block and put the ` +
          `logic there.`,
      );
    }
  }

  return notes;
}

export function notesForContent(blocks?: NotableBlock[], links?: NotableLink[]): string[] {
  const seen = new Set<string>();
  for (const block of blocks ?? []) {
    for (const note of notesForBlock(block, links)) seen.add(note);
  }
  return [...seen];
}

/** Renders the notes as the advisory text block a write reply carries, or nothing to say. */
export function describeNotes(notes: string[]): string | undefined {
  return notes.length === 0 ? undefined : ["Heads up:", ...notes.map((n) => `- ${n}`)].join("\n");
}
