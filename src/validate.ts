/**
 * Local JavaScript syntax checking, run BEFORE a write leaves the client.
 *
 * The server checks too — that is the authority — but discovering a typo required a network
 * round-trip against a real workspace, and an agent iterating on a 200-line block paid that price
 * on every attempt. Acorn is the same parser family the server uses (Acornima is its .NET port,
 * and Jint parses with it), configured with the same options, so the two agree.
 *
 * Where they could disagree, the SERVER WINS: this is a fast-fail, never an authority. It only ever
 * blocks a call it is confident is broken, and it is never the reason something is accepted.
 */

import { Parser } from "acorn";

/** One syntax problem, shaped like the server's diagnostics so callers parse one thing. */
export interface Diagnostic {
  blockId?: number;
  fileName?: string;
  source: string;
  line: number;
  column: number;
  message: string;
}

export interface CheckableBlock {
  id?: number;
  type?: string;
  label?: string;
  code?: string;
}

export interface CheckableFile {
  name?: string;
  content?: string;
}

/**
 * A whole line of the form `import "name.js";` / `import 'name.js'` — leading whitespace ok,
 * optional semicolon, optional trailing comment.
 *
 * This MUST stay identical to `Core/Grids/ImportLines.cs` on the server. Those two drifting apart
 * is exactly the bug this file exists to catch early: the checker parsed unstripped source and
 * rejected every block that used a code file or an npm package.
 */
const IMPORT_LINE = /^[ \t]*import[ \t]+["']([^"']+)["'][ \t]*;?[ \t]*(?:\/\/.*)?$/gm;

/**
 * Replaces each `import "…";` line with a same-line comment. `import` here is a preprocessor
 * directive, not ESM — the runtime strips these before evaluating, so this is what actually runs.
 * Replaced rather than deleted so every following line keeps its real number.
 */
export function stripImports(code: string): string {
  return code.replace(IMPORT_LINE, (_m, name: string) => `// import "${name}" (loaded by the runtime)`);
}

/** A block's type defaults to "Process" — a blank one still holds JavaScript. */
const isProcess = (type?: string): boolean =>
  !type || type.trim() === "" || type.toLowerCase() === "process";

/** Only `.js` files are parsed as JavaScript; markup and stylesheets are not. */
const isScript = (name?: string): boolean => !!name && name.endsWith(".js");

function parse(code: string, allowReturn: boolean): Omit<Diagnostic, "source"> | null {
  try {
    Parser.parse(stripImports(code), {
      ecmaVersion: "latest",
      // Blocks and code files are plain scripts. NOT "module": module mode would make the
      // top-level `return` every block ends with illegal, force strict mode, and accept
      // `import { x } from "y"` / `export`, which the runtime does not support.
      sourceType: "script",
      allowReturnOutsideFunction: allowReturn,
      allowAwaitOutsideFunction: true,
      locations: true,
    });
    return null;
  } catch (err) {
    const e = err as { loc?: { line: number; column: number }; message?: string };
    return {
      line: e.loc?.line ?? 1,
      column: e.loc?.column ?? 0,
      // Acorn appends "(line:col)", which duplicates the structured fields.
      message: (e.message ?? "Syntax error").replace(/\s*\(\d+:\d+\)\s*$/, ""),
    };
  }
}

/** Checks one Process block's code. Returns null when it parses. */
export function checkBlock(block: CheckableBlock): Diagnostic | null {
  if (!isProcess(block.type) || !block.code || !block.code.trim()) return null;

  const source = block.id
    ? block.label
      ? `Block ${block.id} "${block.label}"`
      : `Block ${block.id}`
    : block.label
      ? `Block "${block.label}"`
      : "Block";

  const problem = parse(block.code, /* allowReturn */ true);
  return problem ? { ...problem, source, blockId: block.id } : null;
}

/** Checks one code file. "Files define, blocks return" — a top-level return is an error here. */
export function checkFile(file: CheckableFile): Diagnostic | null {
  if (!isScript(file.name) || !file.content || !file.content.trim()) return null;

  const source = file.name!;
  const problem = parse(file.content, /* allowReturn */ false);
  return problem ? { ...problem, source, fileName: source } : null;
}

/** Checks a whole content payload. Empty result = nothing to report. */
export function check(blocks?: CheckableBlock[], files?: CheckableFile[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const block of blocks ?? []) {
    const d = checkBlock(block);
    if (d) diagnostics.push(d);
  }
  for (const file of files ?? []) {
    const d = checkFile(file);
    if (d) diagnostics.push(d);
  }
  return diagnostics;
}

/** Renders diagnostics the way the server's 400 does, so both surfaces read alike. */
export function describe(diagnostics: Diagnostic[]): string {
  return (
    `JavaScript syntax error in ${diagnostics.length} place(s):\n` +
    diagnostics.map((d) => `  ${d.source} (line ${d.line}, col ${d.column}): ${d.message}`).join("\n")
  );
}

/**
 * Pre-flight for a write tool: throws before the request is sent if the payload cannot parse.
 *
 * Deliberately fails rather than warning. A write that would be rejected by the server anyway is
 * better stopped here — same outcome, no round-trip, and the agent gets the location immediately.
 */
export function preflight(blocks?: CheckableBlock[], files?: CheckableFile[]): void {
  const diagnostics = check(blocks, files);
  if (diagnostics.length > 0) {
    throw new Error(
      `${describe(diagnostics)}\n\n` +
        "Checked locally before sending — nothing was written. Fix the code and retry.",
    );
  }
}
