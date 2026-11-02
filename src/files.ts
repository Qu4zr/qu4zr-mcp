/**
 * Code-file addressing for the Management API. A file is edited on its own — the name lives in the
 * path — so this is the one place that turns a name into a URL. Kept out of index.ts so it can be
 * unit-tested without starting the server (see files.test.ts).
 */

/**
 * The URL of one workspace code file.
 *
 * Names may contain "/" for folders and the server route is a catch-all, so the slashes MUST reach
 * it as slashes: each segment is encoded on its own, never the whole name. `encodeURIComponent` on
 * the full name would send "%2F", which the route does not match — the write would 404 against a
 * file that exists.
 */
export function codeFilePath(workspaceId: number, name: string): string {
  const segments = name.split("/");

  // "." and ".." are not escaped by segment encoding — they ARE path syntax, and an HTTP client
  // normalises them away before the request leaves, so `../secrets.js` would quietly address a
  // different endpoint and come back as a puzzling 404. The server rejects such names anyway
  // (CodeFileRules); refusing here means the caller is told which name is wrong, instead of being
  // told nothing about a request that never reached the file route.
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(
      `Invalid code file name "${name}": segments must not be empty, "." or "..". ` +
        'Use names like "utils.js" or "pages/app.css".',
    );
  }

  return `/api/v1/workspaces/${workspaceId}/content/files/${segments.map(encodeURIComponent).join("/")}`;
}
