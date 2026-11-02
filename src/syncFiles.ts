/**
 * `sync_files` — many code files in ONE request (POST /api/v1/workspaces/{id}/content/files).
 *
 * Publishing a 400-file site used to be 400 write_file calls: 400 saves of the whole workspace, and a
 * failure halfway left a site half old and half new. The server applies a batch all-or-nothing and
 * checks each file's sha256 before storing anything; this module builds the batch — from a list, or
 * from a LOCAL folder, which is the case that matters (the files are on disk; re-emitting them through
 * the model costs tokens and is how one character goes wrong).
 *
 * Kept out of index.ts so it can be unit-tested without starting the server (syncFiles.test.ts).
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Mirror of Core/Grids/CodeFileRules — the server is the authority, this only picks what to send. */
export const TEXT_EXTENSIONS = [".js", ".css", ".html", ".htm", ".json", ".svg", ".txt", ".md", ".xml", ".csv"];
export const BINARY_EXTENSIONS = [".woff2", ".woff", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".pdf"];

/** Local files the batch would not send, and why — reported so nothing is skipped silently. */
export interface Skipped {
  path: string;
  reason: string;
}

export interface SyncItem {
  name: string;
  content: string;
  sha256: string;
}

export function isBinaryName(name: string): boolean {
  return BINARY_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function isAllowedName(name: string): boolean {
  return TEXT_EXTENSIONS.concat(BINARY_EXTENSIONS).some((ext) => name.endsWith(ext));
}

/** sha256 of the content as stored (UTF-8) — what CodeFileRules.Digest computes server-side. */
export function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Joins a folder prefix and a relative path into a code-file name ("public/" + "a/b.css"). */
export function remoteName(prefix: string | undefined, relativePath: string): string {
  const rel = relativePath.split(sep).join("/");
  if (!prefix) return rel;
  return prefix.endsWith("/") ? prefix + rel : `${prefix}/${rel}`;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-test", "bin", "obj"]);

/**
 * Reads every file under `dir` the server could store: allowed extensions only, hidden files and
 * build folders skipped. A binary type (font, image, PDF) is read as base64 — how the workspace holds
 * it — and everything else as UTF-8 text.
 */
export async function collectLocalFiles(dir: string, prefix?: string): Promise<{ items: SyncItem[]; skipped: Skipped[] }> {
  const items: SyncItem[] = [];
  const skipped: Skipped[] = [];

  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.name.startsWith(".")) {
        skipped.push({ path: full, reason: "hidden" });
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          skipped.push({ path: full, reason: "build or dependency folder" });
          continue;
        }
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const name = remoteName(prefix, relative(dir, full));
      if (!isAllowedName(name)) {
        skipped.push({ path: full, reason: "not a code-file type qu4zr stores" });
        continue;
      }

      const bytes = await readFile(full);
      const content = isBinaryName(name) ? bytes.toString("base64") : bytes.toString("utf8");
      items.push({ name, content, sha256: digest(content) });
    }
  }

  const info = await stat(dir);
  if (!info.isDirectory()) throw new Error(`localDir "${dir}" is not a folder.`);
  await walk(dir);
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { items, skipped };
}

/** Why these arguments cannot be sent, or null. Exactly one source; deleting needs confirm. */
export function syncArgsProblem(args: { files?: unknown[]; localDir?: string; deleteMissing?: boolean; confirm?: boolean }): string | null {
  if ((args.files === undefined) === (args.localDir === undefined)) {
    return "Pass exactly one of `files` (a list) or `localDir` (a folder on this machine).";
  }
  return null;
}

/** The request body the server expects. */
export function syncBody(items: SyncItem[], deleteMissing: boolean, deletePrefix?: string) {
  return {
    files: items.map((i) => ({ name: i.name, content: i.content, sha256: i.sha256 })),
    deleteMissing,
    deletePrefix: deletePrefix ?? null,
  };
}
