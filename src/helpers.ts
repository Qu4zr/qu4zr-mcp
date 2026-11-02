/**
 * Small shared helpers used by every MCP tool handler. Extracted so tool logic
 * (e.g. endpoints.ts) can be unit-tested without booting the McpServer/transport.
 */

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: render(data) }],
});

/**
 * A tool result's text, which must be a STRING — and that is the whole point of this function.
 *
 * `JSON.stringify(undefined)` returns the VALUE undefined, not the string "undefined". Every
 * endpoint that answers 204 (the revokes, the deletes, pausing a schedule) leaves the client with
 * no body and therefore `undefined` here, so the result went out with `text: undefined` and the
 * transport rejected it — "Invalid tools/call result" — on a call that had in fact succeeded. The
 * caller was told its revoke had failed while the device was, in fact, revoked.
 *
 * An empty body becomes an explicit success rather than an empty string: a tool that returns
 * nothing at all reads to an agent like a tool that did nothing.
 */
const render = (data: unknown): string => {
  if (typeof data === "string") {
    return data;
  }

  return JSON.stringify(data === undefined || data === null ? { ok: true } : data, null, 2) ?? String(data);
};

export const fail = (err: unknown): ToolResult => ({
  content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

/**
 * Attaches an advisory to a result that already succeeded — a second text block, so the JSON payload
 * the caller came for stays parseable on its own. A failed call is left alone: advice about a page
 * that was not written is noise on top of an error.
 */
export const withNote = (result: ToolResult, note?: string): ToolResult =>
  !note || result.isError
    ? result
    : { ...result, content: [...result.content, { type: "text", text: note }] };

export async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

export const qs = (params: Record<string, string | number | undefined>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
};
