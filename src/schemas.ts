/**
 * Input schemas for the content-writing tools.
 *
 * All of these are `.strict()` on purpose. Zod's default is to STRIP unknown keys, which means a
 * field the server doesn't know about is accepted, silently discarded, and the call still returns
 * 200 — the caller sees success and an empty result. That cost a user hours when an older client
 * had no `files` param: `add_to_workspace({ …, files: [...] })` reported success and created
 * nothing. A loud rejection is always better than a silent no-op.
 *
 * They live outside index.ts so they can be unit-tested: importing index.ts starts the server.
 */

import { z } from "zod";

export const blockShape = {
  id: z.number().int().optional().describe("Stable id within the workspace. Omit on create; the server assigns one."),
  type: z.string().describe('"Process" (JS in code), "Raw data" (JSON in rawData), "API Endpoint" (endpointPath), or "SignalR" (on-prem; handlerCode).'),
  label: z.string().optional(),
  code: z.string().optional().describe("JavaScript for a Process block; `input` is the upstream output, return the result."),
  rawData: z.string().optional().describe("Static JSON/text for a Raw data / API Endpoint block."),
  color: z.string().optional(),
  endpointPath: z.string().optional().describe("Path for an API Endpoint block, e.g. \"orders\"."),
  staticFile: z.string().optional().describe('For an API Endpoint block: a workspace code file to serve VERBATIM (e.g. "pages/app.css"). Content-Type is inferred from the extension and NO JavaScript runs. Use this for static CSS/JS/HTML.'),
  schedule: z.string().optional().describe('For a "Schedule" block: a five-field cron, e.g. "0 9 * * *". Writing it here only DECLARES the cadence — call create_schedule to actually start it.'),
  scheduleTimeZone: z.string().optional().describe('For a "Schedule" block: IANA timezone the cron is read in, e.g. "Europe/Paris". Defaults to UTC.'),
  handlerCode: z.string().optional().describe('For a "SignalR" (on-prem) block: ONLY the C# body of Execute (statements ending in a return), not the signature/class. See get_block_model.'),
  signalRGuid: z.string().optional().describe('For a "SignalR" block: its runner guid. Omit on create — the server provisions one.'),
  i: z.number().int().optional().describe("Grid column; leave 0 for auto-layout."),
  j: z.number().int().optional().describe("Grid row; leave 0 for auto-layout."),
};

export const blockSchema = z.object(blockShape).strict();

export const linkSchema = z.object({
  from: z.number().int(),
  to: z.number().int(),
}).strict();

export const fileSchema = z.object({
  name: z.string().describe('File name, folders with "/". .js/.css/.html/.htm/.json/.svg/.txt/.md/.xml/.csv, and binary .woff2/.woff/.png/.jpg/.jpeg/.webp/.gif/.ico/.pdf whose content is base64 — e.g. "utils.js", "pages/app.css". Only .js is import-able.'),
  content: z.string().describe("The file's contents. A .js file DEFINES functions/consts (no top-level return); other types are plain text served or read as-is."),
}).strict();

/**
 * How much of the SEO reading to run over the HTML pages in a write. It is a REPORTING dial, not a
 * gate: every setting writes the file. "full" is the default because a published page that cannot be
 * found is the failure mode nobody notices until much later; "none" exists for a page that is not a
 * page (a fragment is skipped anyway) or a caller that has its own process.
 */
export const seoMode = z
  .enum(["full", "minimal", "none"])
  .optional()
  .describe(
    'How much to report about the HTML pages being written: "full" (default) everything, "minimal" ' +
      'only what an indexed page cannot do without, "none" to say nothing. Never blocks the write; a ' +
      'page with <meta name="robots" content="noindex"> is exempt either way.',
  );

/** `set_workspace_content` — omit `files` to keep existing, send an array (even []) to replace. */
/**
 * A named area drawn BEHIND the blocks: "API Entry Points", "Auth & Security", "Data".
 *
 * A zone owns no blocks. It is a rectangle on the same grid, and a block belongs to it by SITTING in
 * it — so a zone is placed around the blocks it should contain, and the canvas needs no second
 * source of truth about where anything is.
 */
const zoneSchema = z.object({
  id: z.string().optional().describe("Stable id, so re-sending a zone updates it instead of adding a second one."),
  label: z.string().describe('The heading, e.g. "Auth & Security".'),
  subtitle: z.string().optional().describe('One line under it, e.g. "Sign-in, one-time codes, device transfer".'),
  color: z.string().optional().describe('Hex colour of the border, header and title, e.g. "#a78bfa".'),
  icon: z
    .enum(["globe", "shield", "cube", "database", "folder", "page", "clock", "plug", "bolt", "gear"])
    .optional()
    .describe("Glyph in the header."),
  i: z.number().int().describe("Left column of the rectangle, in the same grid cells as a block's i."),
  j: z.number().int().describe("Top row."),
  w: z.number().int().positive().describe("Width in cells. Leave room: a block's card can be 5 columns wide."),
  h: z.number().int().positive().describe("Height in cells, including 2 rows for the header."),
}).strict();

export const setWorkspaceContentSchema = z.object({
  workspaceId: z.number().int(),
  blocks: z.array(blockSchema),
  links: z.array(linkSchema).optional(),
  files: z.array(fileSchema).optional().describe('Reusable code files (import "x.js"). Omit=keep, []=clear.'),
  zones: z.array(zoneSchema).optional().describe("Canvas areas. Omit=keep the workspace's zones, []=clear them."),
  seo: seoMode,
}).strict();

/** `add_to_workspace` — append-only; existing file names and zone ids are kept, not overwritten. */
export const addToWorkspaceSchema = z.object({
  workspaceId: z.number().int(),
  blocks: z.array(blockSchema),
  links: z.array(linkSchema).optional(),
  files: z.array(fileSchema).optional().describe("New code files to add (existing names are kept, not overwritten)."),
  zones: z.array(zoneSchema).optional().describe("New canvas areas (an id that already exists is kept, not redefined)."),
  seo: seoMode,
}).strict();

/**
 * `update_block` — a partial patch to ONE block. Every field is optional: omit to leave it alone,
 * send "" to clear it. `id` addresses the block and `signalRGuid` is server-provisioned, so neither
 * is patchable.
 */
export const updateBlockSchema = z.object({
  workspaceId: z.number().int(),
  blockId: z.number().int().describe("The block's id, as returned by get_workspace_content."),
  type: z.string().optional().describe('Block type. Changing to/from "SignalR" is rejected — replace the content instead.'),
  label: z.string().optional(),
  code: z.string().optional().describe("JavaScript for a Process block."),
  rawData: z.string().optional().describe("Static JSON/text for a Raw data / API Endpoint block."),
  color: z.string().optional(),
  endpointPath: z.string().optional(),
  staticFile: z.string().optional().describe('For an API Endpoint block: a workspace code file served verbatim, no JS executed.'),
  handlerCode: z.string().optional().describe('For a "SignalR" block: the C# handler body.'),
  i: z.number().int().optional().describe("Grid column. Omit to leave the block where it is."),
  j: z.number().int().optional().describe("Grid row."),
}).strict();

/**
 * `validate_blocks` — a stateless syntax check. No `workspaceId`: it writes nothing and reads
 * nothing, which is the whole point (ask freely, as often as you like, before committing to a write).
 */
export const validateBlocksSchema = z.object({
  blocks: z.array(blockSchema.partial({ type: true })).optional().describe("Blocks to parse. A block with no `type` is treated as Process."),
  files: z.array(fileSchema).optional().describe("Code files to parse. Only .js files are parsed."),
}).strict();

/**
 * `audit_seo` — the server's page audit, stateless like `validate_blocks`. No `workspaceId`: it reads
 * the markup you hand it and writes nothing, so it can be asked as often as it is useful — while
 * drafting, and again after fixing.
 */
export const auditSeoSchema = z.object({
  files: z
    .array(fileSchema)
    .describe(
      "The files to read. Only whole HTML pages are audited — fragments, stylesheets and scripts are " +
        "skipped and reported in checkedPages. Send every page of the site together to get the " +
        "cross-page checks.",
    ),
  baseUrl: z
    .string()
    .optional()
    .describe(
      'Where the site is published, e.g. "https://api.qu4zr.io/marceau/". Optional, and it unlocks ' +
        "the checks a page cannot make about itself: a canonical pointing outside the site, a sitemap " +
        "listing URLs it does not own.",
    ),
  mode: seoMode,
}).strict();

/** `delete_block` — destructive, so gated behind confirm:true like the other delete tools. */
export const deleteBlockSchema = z.object({
  workspaceId: z.number().int(),
  blockId: z.number().int(),
  confirm: z.boolean().optional().describe("Must be true to delete. Omit/false returns a preview only."),
}).strict();

/**
 * Schedules. Separate from the block that carries the cron on purpose: writing `schedule` on a
 * block declares a cadence in the workspace's content, while creating a trigger is what makes code
 * start running unattended against a pinned version. One is an edit; the other spends money.
 */
export const listSchedulesSchema = z.object({
  workspaceId: z.number().int(),
}).strict();

export const createScheduleSchema = z.object({
  workspaceId: z.number().int(),
  blockId: z.number().int().describe("The Schedule block to fire, from get_workspace_content."),
  cron: z.string().min(1).describe('Five-field cron, e.g. "0 9 * * *" (09:00 daily) or "*/15 * * * *".'),
  timeZone: z.string().optional().describe('IANA timezone the cron is read in, e.g. "Europe/Paris". Defaults to UTC.'),
  versionId: z.number().int().optional().describe(
    "Workspace version to pin. Omit for the latest COMMITTED version — never the auto-save, which is " +
    "where half-finished work lives. A workspace with no commit is rejected, with an explanation."),
  confirm: z.boolean().optional().describe("Must be true to create. Omit/false returns a preview only."),
}).strict();

/**
 * A schedule's own run history — the only thing that answers "did last night's job actually run".
 *
 * Its own tool because the alternative is guessing. `list_schedules` carries ONE outcome, the last,
 * and block logs exist only where logging is switched on: with neither, a cron firing perfectly
 * every night is indistinguishable from one that has never fired at all. That ambiguity cost a full
 * debugging session before this existed — the schedule was healthy the whole time.
 */
export const listScheduleRunsSchema = z.object({
  triggerId: z.number().int(),
  limit: z.number().int().min(1).max(200).optional().describe("How many firings to return, newest first. Default 50."),
}).strict();

export const pauseScheduleSchema = z.object({
  triggerId: z.number().int(),
}).strict();

export const resumeScheduleSchema = z.object({
  triggerId: z.number().int(),
  confirm: z.boolean().optional().describe("Must be true to resume. Omit/false returns a preview only."),
}).strict();

/** `update_schedule` — repin a schedule onto another commit (the latest when versionId is omitted). */
export const updateScheduleSchema = z.object({
  triggerId: z.number().int(),
  versionId: z.number().int().optional().describe("The commit to run. Omit for the workspace's latest commit."),
  confirm: z.boolean().optional().describe("Must be true to repin. Omit/false returns a preview only."),
}).strict();

export const deleteScheduleSchema = z.object({
  triggerId: z.number().int(),
  confirm: z.boolean().optional().describe("Must be true to delete. Omit/false returns a preview only."),
}).strict();

/**
 * One code file, addressed by name. The file tools are the counterpart of `update_block`: a file is
 * edited on its own, so changing one line of a page costs one file instead of the whole workspace —
 * which is both cheaper and safer, since re-emitting every other file byte-exactly is exactly how one
 * of them gets quietly mangled.
 */
const codeFileName = z
  .string()
  .min(1)
  .describe('Case-sensitive file name, folders with "/" — e.g. "pages/app.css", "lib/http.js".');

export const listFilesSchema = z.object({
  workspaceId: z.number().int(),
}).strict();

export const readFileSchema = z.object({
  workspaceId: z.number().int(),
  name: codeFileName,
}).strict();

export const writeFileSchema = z.object({
  workspaceId: z.number().int(),
  name: codeFileName,
  content: z.string().describe("The file's FULL new content — this replaces it. To change PART of an existing file, use edit_file."),
  seo: seoMode,
}).strict();

/**
 * `edit_file` — replace a passage inside a file that already exists.
 *
 * `oldString` is matched exactly and must be unique: an anchor that hits several places is a guess,
 * and a guess edits the wrong line. `newString` may be empty (that deletes the passage), but it may
 * not equal `oldString` — an edit that changes nothing is a mistake worth naming rather than a
 * silent no-op the caller believes landed.
 */
export const editFileSchema = z.object({
  workspaceId: z.number().int(),
  name: codeFileName,
  oldString: z
    .string()
    .min(1)
    .describe("The exact text to replace, whitespace included. Must appear exactly once unless replaceAll is true."),
  newString: z.string().describe("What to put in its place. Empty string deletes the passage."),
  replaceAll: z.boolean().optional().describe("Replace every occurrence instead of requiring a unique match."),
  seo: seoMode,
}).strict();

/** `delete_file` — destructive, so confirm-gated like the other deletes. */
/**
 * `sync_files` — many files in one request, from a list OR a local folder (exactly one of the two).
 * `deleteMissing` removes the workspace files the batch does not list (under `prefix` when given),
 * which is destructive, hence `confirm`.
 */
export const syncFilesSchema = z.object({
  workspaceId: z.number().int(),
  files: z.array(z.object({
    name: codeFileName,
    content: z.string().describe("The file's FULL content. Binary types (.png, .woff2…) as base64."),
  }).strict()).max(400).optional().describe("Files to write. Omit when using localDir."),
  localDir: z.string().optional().describe(
    "A folder on THIS machine to upload as-is (fonts and images are read as base64). Omit when sending files."),
  prefix: z.string().optional().describe(
    'Workspace folder the local files go under, e.g. "public" — also the only place deleteMissing may delete.'),
  deleteMissing: z.boolean().optional().describe(
    "Delete workspace files the batch does not contain (under prefix, if given). Needs confirm:true."),
  confirm: z.boolean().optional().describe("Must be true when deleteMissing is true. Omit/false previews."),
}).strict();

export const deleteFileSchema = z.object({
  workspaceId: z.number().int(),
  name: codeFileName,
  confirm: z.boolean().optional().describe("Must be true to delete. Omit/false returns a preview only."),
}).strict();
