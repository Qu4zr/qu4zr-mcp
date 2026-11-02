#!/usr/bin/env node
/**
 * qu4zr MCP server — build and manage workspaces from an AI assistant.
 *
 * A workspace is a canvas of blocks connected by links (one canvas per workspace).
 * Auth: OAuth2 client_credentials (set QU4ZR_CLIENT_ID / QU4ZR_CLIENT_SECRET).
 * Build tools (flows:read/write) act freely; delete / deploy / execute are gated
 * behind an explicit `confirm: true` so the user stays in the loop.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Qu4zrClient, Qu4zrError } from "./client.js";
import { ok, run, qs, withNote } from "./helpers.js";
import { auditFiles, auditPage, describeSeo } from "./seo.js";
import { describeNotes, notesForBlock, notesForContent } from "./writeNotes.js";
import { callEndpoint } from "./callEndpoint.js";
import {
  setWorkspaceContentSchema,
  addToWorkspaceSchema,
  updateBlockSchema,
  deleteBlockSchema,
  validateBlocksSchema,
  auditSeoSchema,
  listFilesSchema,
  readFileSchema,
  writeFileSchema,
  editFileSchema,
  deleteFileSchema,
  syncFilesSchema,
  listSchedulesSchema,
  listScheduleRunsSchema,
  createScheduleSchema,
  pauseScheduleSchema,
  resumeScheduleSchema,
  updateScheduleSchema,
  deleteScheduleSchema,
} from "./schemas.js";
import { toggleEndpoint, updateEndpoint, deleteEndpoint } from "./endpoints.js";
import { preflight } from "./validate.js";
import { codeFilePath } from "./files.js";
import { collectLocalFiles, digest, syncArgsProblem, syncBody } from "./syncFiles.js";
import { createDomain, createVault, setVaultSecret } from "./provisioning.js";
import {
  listDomainApiKeys,
  createDomainApiKey,
  updateDomainApiKey,
  deleteDomainApiKey,
  rotateDomainApiKey,
} from "./domainApiKeys.js";
import {
  listDomainClients,
  createDomainClient,
  updateDomainClient,
  rotateDomainClientSecret,
  revokeDomainClientTokens,
  deleteDomainClient,
  rotateDomainSigningKey,
  listTrustedIssuers,
  setTrustedIssuer,
  deleteTrustedIssuer,
  checkTrustedIssuer,
} from "./domainClients.js";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { launchDetached } from "./runnerProcess.js";
import { homedir } from "node:os";
import { currentBearer, LOCAL_DIR_REFUSAL, withoutLocalTools } from "./remote.js";
import { serveHttp } from "./http.js";
import { createRequire } from "node:module";
import { install, usage as installUsage } from "./install.js";
import { doctor } from "./doctor.js";
import {
  classifyRunnerBuildFailure,
  mergeRunnerAppSettings,
  validateRunnerPackage,
  RunnerPackageIntegrityError,
  SUPPORTED_MANIFEST_SCHEMA_VERSIONS,
  type DownloadedRunnerPackage,
} from "./runnerLifecycle.js";

const execFileAsync = promisify(execFile);

// Read from package.json rather than a literal: a hardcoded version drifts silently, and a client
// that reports the wrong version makes "is my tool stale?" undiagnosable. (It was pinned at
// "0.19.0" through the 0.20–0.24 releases.)
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

// ---- CLI --------------------------------------------------------------------

// An MCP client launches this with no arguments and talks JSON-RPC over stdio. A person launches it
// with a subcommand and gets a terminal tool instead: one that sets the server up, and one that says
// why it will not start. Dispatched before the credential check below on purpose — `install` and
// `help` are exactly what you need when you have no credentials configured yet.
const argv = process.argv.slice(2);
const subcommand = argv[0] ?? "";

if (["help", "--help", "-h"].includes(subcommand)) {
  console.log(
    [
      `qu4zr-mcp ${version} — build and manage qu4zr workspaces from an AI assistant.`,
      "",
      "  qu4zr-mcp                    run the MCP server (this is what your client does)",
      "  qu4zr-mcp install <client>   register the server with a client, in that client's shape",
      "  qu4zr-mcp doctor             check the credentials and the connection, and say what broke",
      "  qu4zr-mcp serve-http         run the hosted HTTP server (what qu4zr runs at /mcp; sign-in by OAuth)",
      "",
      installUsage(),
    ].join("\n"),
  );
  process.exit(0);
}

if (["--version", "-v"].includes(subcommand)) {
  console.log(version);
  process.exit(0);
}

if (subcommand === "install") {
  process.exit(await install(argv.slice(1)));
}

if (subcommand === "doctor") {
  process.exit(await doctor(version));
}

// `serve-http` is the hosted server (api.management.qu4zr.io/mcp): many people, each signed in
// through OAuth, none of them on this machine. See remote.ts for what that changes.
const remote = subcommand === "serve-http";

// ---- Config -----------------------------------------------------------------

const baseUrl = (process.env.QU4ZR_BASE_URL ?? "https://api.management.qu4zr.io").replace(/\/+$/, "");
const publicUrl = (process.env.QU4ZR_PUBLIC_URL ?? "https://qu4zr.com").replace(/\/+$/, "");
const clientId = process.env.QU4ZR_CLIENT_ID;
const clientSecret = process.env.QU4ZR_CLIENT_SECRET;
const scopes = (process.env.QU4ZR_SCOPES ?? "flows:read flows:write flows:deploy flows:execute")
  .split(/\s+/)
  .filter(Boolean);

if (!remote && (!clientId || !clientSecret)) {
  console.error(
    "qu4zr-mcp: QU4ZR_CLIENT_ID and QU4ZR_CLIENT_SECRET are required.\n" +
      "\n" +
      "  1. Create an API client under Account → API Access at https://qu4zr.com\n" +
      "  2. qu4zr-mcp install <claude-code|copilot|cursor|vscode|codex|kiro|…>\n" +
      "\n" +
      "They have to be in the MCP config's own env block: a variable exported in your shell does not\n" +
      "reach a process your client spawns. Run 'qu4zr-mcp doctor' to see what this process can see.",
  );
  process.exit(1);
}

// Never silently. It disables certificate verification for every request this process makes,
// including the one carrying the secret, and it is the first thing a search suggests for the TLS
// error a corporate proxy produces — client.ts offers NODE_EXTRA_CA_CERTS in its place.
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
  console.error(
    "qu4zr-mcp: WARNING — NODE_TLS_REJECT_UNAUTHORIZED=0 is set, so TLS certificates are not being\n" +
      "verified and your client secret is sent over an unchecked connection. If a proxy re-signs your\n" +
      "traffic, point Node at its root with NODE_EXTRA_CA_CERTS=/path/to/root.pem and remove this.",
  );
}

const client = remote
  ? new Qu4zrClient({ baseUrl, scopes, bearer: currentBearer })
  : new Qu4zrClient({ baseUrl, clientId, clientSecret, scopes });

// Encode a data-store key for the entries/{**key} catch-all route: percent-encode
// everything, then keep real '/' as path separators (the catch-all captures them;
// a literal %2F would be preserved un-decoded and miss the route).
const encKey = (k: string) => encodeURIComponent(k).replace(/%2F/gi, "/");

// ---- Grounding: the block model ---------------------------------------------

// The NPM PACKAGES list below is duplicated from the executor's curated registry
// (InfiniteGridDashboard.Server.Executor/Modules/Bundles/manifest.json) rather than fetched,
// so it can go stale by MISSING a newly stocked package. It cannot go WRONG: the registry is
// append-only, so a version advertised here stays resolvable forever. Refresh it when
// Modules/build/build.mjs adds a package, and ship a new version of this server.
const BLOCK_MODEL = `
A qu4zr WORKSPACE is a canvas of blocks connected by directed links (one canvas per
workspace). To "build a workflow in a workspace" means setting that workspace's blocks + links.

Block: { id?, type, label?, code?, rawData?, color?, endpointPath?, i?, j? }
  - type (required): one of
      "Process"      — runs JavaScript; put the code in "code". The upstream block's
                       output is available as the variable \`input\`; return the output.
      "Raw data"     — static payload; put JSON/text in "rawData".
      "API Endpoint" — exposes this block over HTTP; set "endpointPath" (e.g. "orders").
                       Set "staticFile" (e.g. "pages/app.css") to serve a workspace code file
                       VERBATIM with no JavaScript executed — the way to publish static CSS/JS/HTML.
                       IT DOES NOT RUN CODE. An API Endpoint block is a DOOR, not a handler: "code"
                       on it is never executed — not on the request, not at the gateway, not
                       anywhere — because the gateway starts the flow AT this block and a block of
                       this type only emits its own "rawData" (null when empty). The request is
                       handled by the Process block you LINK IT TO, which reads the caller's request
                       as \`request\`. An endpoint with nothing downstream, no staticFile and no
                       rawData answers null to every caller, forever, with a 200 — so it looks like
                       working code returning nothing. Endpoint -> Process, always.
      "Schedule"     — starts the flow on a clock instead of on a request. Put a five-field cron in
                       "schedule" and an IANA zone in "scheduleTimeZone". Like a Raw data block it
                       emits its own "rawData" as the run's input, so downstream blocks get whatever
                       parameters you put there.
  - id: omit on create — the server assigns ids. Reference your blocks by the ids you
        DO set (or set them yourself, starting at 1) so links line up.
  - i, j: grid position (column,row). Leave at 0 and the server auto-lays them out.

Link: { from, to } — block ids; data flows from → to.

Zone: { id?, label, subtitle?, color?, icon?, i, j, w, h } — a named area drawn BEHIND the blocks.

ZONES — GROUP WHAT YOU BUILD. A canvas of twenty blocks that all look alike reads as twenty things
to work out one by one; the same twenty inside four titled areas reads as an application with four
parts, which is what the person asked you for. Send zones with the flow, in the same call:
    zones: [
      { label: "API Entry Points", subtitle: "Public HTTP endpoints", icon: "globe",  color: "#38bdf8", i: 1, j: 1,  w: 44, h: 5 },
      { label: "Auth & Security",  subtitle: "Sign-in and sessions",  icon: "shield", color: "#a78bfa", i: 1, j: 8,  w: 44, h: 8 },
      { label: "Static Assets",    subtitle: "Stylesheet and scripts", icon: "folder", color: "#60a5fa", i: 1, j: 18, w: 44, h: 5 }
    ]
  - A zone OWNS NO BLOCKS. It is a rectangle on the same grid and a block belongs to it by SITTING in
    it, so put the zone around the blocks it should contain and set those blocks' i/j yourself
    (leaving them at 0 hands them to auto-layout, which lays a flow out correctly but knows nothing
    about your zones).
  - LAY A FLOW OUT THE WAY IT RUNS, left to right: entry points (endpoints, schedules, raw data) in
    the first column, each following step 6 columns further right. Blocks at the same step of
    parallel branches share a column, 3 rows apart. A step several blocks converge on sits on the
    middle row of the blocks feeding it, and a branch keeps the row order of its parents so wires do
    not cross. Never scatter blocks, and never lay a flow out in array order — that is what reads as
    arbitrary. Auto-layout (i/j left at 0) applies exactly these rules.
  - Room to breathe: a block is drawn as a CARD that grows to fit its label, up to 5 columns. Leave 2
    rows at the top of a zone for its header and 1 cell of margin around its blocks: a zone should
    hug its flow, not float around it. A zone 44 columns wide holds a flow of seven steps.
  - color: the zone's accent. The canvas derives the tint, header and border from it, so any hue
    works; use it for ORGANISATION only. It never means success, error or deployed.
  - icon: globe (public surface) | shield (auth) | cube (services) | database (storage) |
    folder (assets) | page (pages) | clock (scheduled) | plug (integrations) | bolt (real-time) | gear.
  - color: hex. One hue per AREA, not per block type — the icon already says what type a block is.
    The card takes its zone's accent, so an area reads as one thing.
  - Same write rule as files: OMIT zones to keep the workspace's own, send [] to clear them. An id
    that already exists is never redefined by add_to_workspace.
  - For a workspace that ALREADY EXISTS and has no zones, don't invent the grouping by hand:
    infer_zones(workspaceId, confirm:true) reads its paths and files, groups its flows and lays them
    out. Building something new? Send the zones yourself — you know what the areas are.

ADDING TO AN EXISTING WORKSPACE: prefer add_to_workspace(workspaceId, blocks, links) — it APPENDS your
new flow (server assigns fresh ids, lays it out below the existing blocks) and CANNOT wipe existing flows.
Its links may only connect your NEW blocks to each other. Only when your new flow must wire INTO an
existing block do you need read-modify-write: get_workspace_content, then set_workspace_content with the
existing blocks+links plus yours (existing ids + each SignalR block's signalRGuid + handlerCode round-trip
losslessly). set_workspace_content REPLACES everything — never use it to "add" without sending the existing
content back. Default to the user's current workspace; only create a new workspace if they ask for one.

EDITING AN EXISTING BLOCK: use update_block(workspaceId, blockId, <only the fields you're changing>).
Do NOT re-send the whole workspace to fix one block, and do NOT append a corrected "v2" block beside a
broken one — that leaves orphans behind. Omitted fields keep their value; "" clears one. Everything else
(other blocks, links, code files, camera, layout) is untouched, so there is no read-modify-write race.
Removing a block: delete_block(workspaceId, blockId, confirm:true) — it also drops every link touching it.

MAKING A FLOW RUN ON A SCHEDULE — two steps, and they are not the same thing. Writing "schedule" on a
Schedule block only records the cadence in the workspace's content; create_schedule(workspaceId, blockId,
cron, …, confirm:true) is what starts it firing. It pins the latest COMMITTED version, so commit first —
a schedule runs unattended, and the auto-save is where half-typed code lives. The plan sets the fastest
allowed cadence (a free workspace: one schedule, hourly) and, on a free plan, offsets the firing time by
a fixed number of seconds so every workspace doesn't fire at once; the reply reports that offset, so
quote the real time to the user rather than the cron they typed. list_schedules shows what is running,
what ran last and why anything is paused; list_schedule_runs shows the actual firings; pause_schedule
stops one, resume_schedule restarts it, delete_schedule removes it for good. A schedule that failed five
times in a row pauses itself — fix the cause before resuming, or it will just burn the quota again.

THE PIN IS FROZEN AND THE ENDPOINT IS NOT — the single most misread thing about this platform. A
deployed endpoint serves the AUTO-SAVE, so every canvas edit is live at its URL instantly, with no
redeploy. A schedule runs the COMMITTED version pinned when it was created, for as long as it exists.
The same block can therefore answer new code over HTTP while its cron still runs the old one, which
reaches you as "the scheduler is broken" about a scheduler that is firing perfectly. So: editing a
scheduled block changes nothing about tonight's run — that needs commit_workspace_version and a
schedule pinned to the new version. list_schedules reports canvasAheadOfPin with the exact
differences; read it before you touch anything else. (Logging is the one exception: the per-block
logging flag follows the canvas, so you can switch it on and see the NEXT unattended run without
committing.)

"DID THE CRON RUN?" is answered by list_schedule_runs, never by block logs. Block execution logs
exist only for blocks with logging switched on, so a healthy schedule with logging off leaves no
trace there and looks exactly like one that never fired. Check the runs first; the usual finding is
that every firing succeeded and the real problem is drift, an empty result, or a source that is
switched off.

EDITING AN EXISTING CODE FILE: edit_file(workspaceId, name, oldString, newString) — the same rule, one
level down, and the DEFAULT for anything that already exists. It replaces one passage and leaves every
other byte alone, so changing a heading on an 80 KB page costs the heading, not 80 KB. oldString must
match exactly (whitespace included) and appear once — include a line above and below to single it out,
or pass replaceAll:true; newString "" deletes the passage. The read-modify-write happens server-side in
one request (no interleaving), nothing is saved if the result would not parse, and the reply carries the
file's sha256 so you can prove what the server now holds.
  write_file(workspaceId, name, content) is for CREATING a file or replacing one outright: it takes the
FULL new content, so reaching for it to change one line means reproducing everything else byte for byte —
and one character wrong in that reproduction is a corruption that surfaces when a visitor loads the page,
not when the tool returns. read_file first if you are unsure what a file contains.
  Either way, do NOT re-send the whole workspace to change one file: every other file, every block, the
links, the camera and the layout are untouched here. list_files shows what exists (with each file's
sha256); delete_file(…, confirm:true) removes one and tells you what still imports it.

PROCESS BLOCK JAVASCRIPT — runs in a sandboxed Jint engine. Key rules:
  - EVERYTHING IS SYNCHRONOUS. There is NO async/await and NO Promises. fetch() and
    sql.query() return their result directly.
  - NO Node.js: no require(), no Buffer, no process, no filesystem. No btoa/atob.
    Arbitrary npm packages cannot be installed — but a small CURATED set is importable;
    see NPM PACKAGES below. For anything not on that list, implement it in plain JS.
  - Available globals: console.log, JSON, the \`input\` variable (upstream output), fetch,
    XMLHttpRequest, \`sql\` (when the workspace has a vault), \`store\` (built-in key-value storage),
    and \`channel\` (real-time publish; see REAL-TIME below).
  - Limits per block: 16MB ALLOCATED (64MB Pro; garbage counts: JSON.parse ~4 bytes/char, each
    stringify or concat again), ~5s wall clock (10s Pro), 50k statements. Return the block's output.
  - runtime.statementsRemaining()/statementsLimit(), runtime.memoryUsed()/memoryLimit() — stop early
    (partial results + a cursor) instead of being killed at a cap.
  - Host errors (fetch timeout, store, db, files.read) are ordinary Errors: try/catch works. The caps don't.
  - MEASURE, DON'T GUESS: test_block and execute_workspace return \`usage\` — { statements,
    limitStatements, memoryBytes, limitMemoryBytes, durationMs, fetches, storeOps, channelPublishes }.
    Size batches (pages per call, rows per chunk) from it. Limits are PER BLOCK.
  - SYNTAX IS CHECKED ON WRITE (locally first, then by the server): a 400 error:"syntax_error" names
    the block/file, line and column — fix and resend, it is NOT transient. Nothing was written.
  - get_logs also carries \`usage\` per execution, so you can see what a PAST run cost (a gateway hit,
    not just your own test). Older rows have no usage — the field is absent, not zero.
  - validate_blocks(blocks?, files?) — run that check on its own, with NO workspaceId and nothing
    written. Use it while drafting or repairing code instead of learning about a typo from a
    rejected write. \`import "…";\` lines are valid and never a syntax error.

CODE FILES — reuse code across blocks and keep blocks SMALL. Put shared helpers, libraries, and any LARGE
content in a workspace code file instead of pasting big strings/logic into a Process block. Write them ONE
AT A TIME with write_file(workspaceId, name, content) — that is the tool for a page, a stylesheet or a
helper, whether it exists yet or not. (set_workspace_content/add_to_workspace also carry a \`files\` field,
for building a workspace from scratch in one call; do not reach for them to edit an existing file.)
A Process block pulls files in with import lines at the top:
    import "utils.js";
    import "lib/http.js";          // folders with "/"
    return format(sanitize(input));  // functions/consts defined in the files
  - A file is plain JS that DEFINES functions/consts; it must NOT have a top-level return and gets no
    \`input\`. It's evaluated into the sandbox BEFORE the block (like a <script> tag). Files may import
    other files (deps-first; cycles rejected). Names end in .js, "/" for folders. Versioned with the
    workspace and available to deployed endpoints. list_files/read_file show what's there
    (get_workspace_content returns \`files\` too, but pulls the entire workspace to do it).
  - Files may be **.js, .css, .html, .htm, .json, .svg, .txt, .md, .xml, .csv**, and binary
    **.woff2 .woff .png .jpg .jpeg .webp .gif .ico .pdf** (content = base64; staticFile serves the bytes).
    Only **.js** can be \`import\`ed (it is EVALUATED); read any other type with files.read(name).
  - **NEVER inline a big HTML/CSS/JS string in a Process block.** Inside a backtick template literal the
    parser eats \\d in regexes and interprets \${…}, so a pasted page silently breaks. Store the page as
    what it IS and pick one of:
      (1) STATIC ENDPOINT — best for CSS/JS/static HTML. An API Endpoint block with
          "staticFile": "pages/app.css" serves that file verbatim, Content-Type from the extension,
          running NO JavaScript. No Process block needed at all.
      (2) files.read — for a page you need to template at request time:
              const html = files.read("pages/index.html").replace("{{name}}", input.name);
              return Response(html, 200, { "Content-Type": "text/html; charset=utf-8" });
    Rule of thumb: if a block's code is mostly a long literal, it belongs in a file.
  files.read(name) -> string   |  files.has(name) -> bool  |  files.list() -> [names]
  // Raw TEXT (base64 for a binary type). A missing file throws a catchable Error — or check has() first.

NPM PACKAGES — the same import line pulls in a curated package, PINNED to an exact version:
    import "zod@4.4.3";
    const Order = zod.z.object({ id: zod.z.string(), qty: zod.z.number() });
    return Order.parse(input);        // throws on invalid input
  Stocked (import specifier -> the global it defines):
    "zod@4.4.3"              -> zod             schema validation of request bodies
    "date-fns@4.4.0"         -> dateFns         date parsing, formatting, arithmetic
    "papaparse@5.5.4"        -> papaparse       CSV in/out
    "fast-xml-parser@5.10.1" -> fastXmlParser   XML in/out
    "nanoid@6.0.0"           -> nanoid          short URL-safe ids: nanoid.nanoid() -> 21 chars
                                                (for a standard UUID use the built-in crypto.randomUUID())
  - THE VERSION IS REQUIRED. \`import "zod"\` is REJECTED, and so is a version not listed above —
    it fails loudly rather than quietly resolving to a different build. The pin lives in the
    block's source, so a deployed endpoint keeps running the exact package it was tested against.
  - Each package arrives as ONE global holding the whole module namespace — there is no
    destructuring import, and a name that isn't a valid identifier is camel-cased
    (\`date-fns\` -> \`dateFns\`). Write \`zod.z.string()\`, not \`z.string()\`.
  - Packages run under the SAME limits as your code (memory, time, 50k statements) and are served
    from the sandbox — no install step, no network fetch at runtime.

PUBLISHING A SITE (pages, not just APIs) — a qu4zr site is ordinary HTML in workspace code files,
each published by an API Endpoint block with "staticFile" set. NO JavaScript runs for those requests,
so what a visitor and a crawler receive is exactly the file you wrote. One page, start to finish:
    write_file(ws, "pages/index.html", "<!doctype html>…")
    add_to_workspace(ws, [{ type:"API Endpoint", label:"Home", endpointPath:"/",
                            staticFile:"pages/index.html" }])
    deploy_endpoint(ws, blockId, domainId, path:"/", isAnonymous:true, confirm:true)
  - isAnonymous MUST be true for anything public. A non-anonymous endpoint demands an API key, and a
    page nobody can open without one is not a site.
  - THE SITE'S ADDRESS IS THE DOMAIN'S baseUrl, from list_domains — read it, never build it. Where
    site hosts are enabled that is https://{slug}.{zone}/ (a real hostname, the thing to print on a
    business card); the older https://api.qu4zr.io/{slug}/{path} form keeps answering for API callers
    who already depend on it. Both serve; the canonical tag decides which one is indexed, and it must
    be the baseUrl. A path hangs off it — {baseUrl}about.html.
  - Paths worth knowing:
      "/"            the site ROOT — the home page. Deploy the home page HERE, always: it is the URL
                     people link to and the one your canonical tag points at. (A listing reports it
                     back to you as "/" too, so it round-trips; an empty path is an error.)
      "index.html"   a path may be a FILE NAME (dots are allowed) — also how you publish
      "sitemap.xml"  a sitemap, or a search-console verification file like "google<token>.html".
      "blog/post-1"  folders are fine, but NEVER a first folder that looks like a version label
                     ("v1", "v2", "latest", "beta", "dev", "prod", "stable", "head") — the gateway
                     reads that segment as a VERSION, so {slug}/v2/index.html resolves version "v2"
                     and not your page.
      "c/{publicId}" a PATH PARAMETER. Deploy it with the braces in the path and the value arrives as
                     request.params.publicId. Nothing else routes below a path: /c/anything answers
                     404 unless an endpoint was deployed with that {param} shape, so ONE endpoint
                     per URL shape — this is how a share link, a profile page or /users/{id} is
                     built, and there is no wildcard that catches a whole subtree.

WRITE EVERY PAGE SEARCH-READY. This is not an extra the user opts into — it is what a published page
is, and it is nearly free at authoring time and expensive to retrofit. Do NOT ask "do you want SEO?";
ask for the three things you cannot invent — the site/brand NAME, a one-sentence DESCRIPTION, and the
LANGUAGE — then write, and say what you wrote. Every page's <head>:
    <!doctype html>
    <html lang="fr">                      the REAL language, not always en
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>…</title>                      unique per page, <=60 chars, distinctive words first
    <meta name="description" content="…"> 50-160 chars, written for a human, unique per page
    <link rel="canonical" href="{baseUrl}…">   ABSOLUTE, from the domain's baseUrl as
                                          list_domains reports it — NEVER assembled by hand. The
                                          root answers at both /{slug} and /{slug}/: name the one with
                                          the slash, which is what the generated sitemap lists.
    <meta property="og:title|og:description|og:image|og:url">     what a shared link looks like
    <script type="application/ld+json">   Organization / LocalBusiness / Article / Product, as fits
  In the body: exactly ONE <h1>, headings in order, alt on every <img>, and real <a href> links
  between pages — a crawler follows links, not buttons. Put the CONTENT IN THE HTML: a page whose
  text is rendered by client-side JS is a blank page to most crawlers, and for a staticFile endpoint
  there is no server-side rendering to fall back on.
  A page that is deliberately NOT for search (an admin screen, a thank-you page) says so with
  <meta name="robots" content="noindex">, and is then left alone by the checks below.
  THE WRITE CHECKS THIS: write_file / set_workspace_content / add_to_workspace read the HTML pages
  in the payload and report what a findable page is still missing. It never blocks the write — fix
  the findings with another write_file. seo:"minimal" reports only the essentials, seo:"none" is off.
  WHEN THE SITE IS BUILT, run audit_seo(files, baseUrl:<the domain's baseUrl from list_domains>) over ALL the
  pages at once. That is the server's audit — the authority, and the only one that can see across
  pages: two pages sharing a title or a description, a canonical pointing at a site you don't own, a
  hand-written sitemap listing URLs that aren't yours. Re-run it after fixing, and tell the user what
  "ready" came back as. It writes nothing, so ask as often as it helps.
  THE SITEMAP IS AUTOMATIC: {baseUrl}sitemap.xml is generated from the pages you
  have actually deployed (every enabled, public endpoint serving an .html file), so do NOT write one
  by hand — a hand-written sitemap is correct exactly once and then quietly lists URLs that 404.
  Two cases where you still write your own, which then wins: pages TEMPLATED by a Process block
  (their content type is only known once they run, so the generator cannot see them), and a site that
  needs priority/changefreq. Deploy it at path "sitemap.xml" as usual.
  THE ROBOTS.TXT IS AUTOMATIC TOO: {baseUrl}robots.txt is generated, allows crawling, and carries a
  Sitemap: line pointing at the sitemap above — which is how a crawler finds that sitemap without
  anyone submitting it anywhere. Deploy your own at path "robots.txt" only to override it.
  To keep ONE page out of search use <meta name="robots" content="noindex"> in the page, never a
  Disallow: a disallowed page is not fetched at all, so its meta is never read, and it can still be
  listed as a bare link. And you never have to think about the API endpoints beside your pages: the
  gateway marks every non-HTML reply (JSON, CSS, JS) with the header X-Robots-Tag: noindex by itself.
  Two costs worth stating to the user: every crawler hit is an API call against their plan quota,
  and pages count against the workspace's 2 MB code-file budget.

HTTP from a Process block:
  const res = fetch("https://api.example.com/items", {
    method: "POST",
    headers: { "Authorization": "Bearer " + input.token },
    body: { name: "x" }            // object → sent as JSON
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = res.json();          // or res.text(); NO await
  return data;
  // Limits: HTTP/HTTPS only; localhost & private IPs are blocked (SSRF guard);
  // max 10 requests/exec (20 on Pro); 10s timeout; 5MB a reply, all replies of a run <= its memory.
  // fetch(url, { timeout, discardBody, followRedirects }): timeout only SHORTENS the 10s cap,
  // discardBody stops at the headers, followRedirects:false answers the 3xx (headers.location) so you
  // can walk a chain; replies add elapsedMs, url, redirected, headers. A block has ~5s WALL-CLOCK and
  // fetch is synchronous, so probe several endpoints with ONE fetchAll([{url,timeout,discardBody},...]):
  // concurrent, same checks and budget, in order, a failure being status 0 + error. A rate-limited API:
  // fetchAll(list, { concurrency: 2, intervalMs: 400 }).
  // NOT-JSON bodies: a STRING body is sent verbatim and your Content-Type is honoured (case-
  // insensitive, parameters kept). This is how OAuth2 token exchange / XML / CSV work — do NOT
  // smuggle parameters into the query string to work around it (that leaks secrets into logs):
  //   fetch("https://oauth2.googleapis.com/token", {
  //     method: "POST",
  //     headers: { "Content-Type": "application/x-www-form-urlencoded" },
  //     body: "grant_type=authorization_code&code=" + encodeURIComponent(code)
  //   });
  // Omit Content-Type and an object/string body goes out as application/json.

Databases via the workspace VAULT (Postgres, MySQL, SQL Server, Oracle, SQLite):
  // Provision it yourself: create_vault(workspaceId, name) once, then
  // set_vault_secret(workspaceId, name, kind:"connection", value, provider, confirm:true).
  // Values are WRITE-ONLY — encrypted server-side and never readable again, by anyone.
  // ASK THE USER for the connection string; never invent one and never guess a host.
  // Reference a connection secret as <VaultName>.<secretName> — an OPAQUE handle; you
  // can't read its value. Pass it as the first arg to sql.query. NEVER hardcode
  // credentials, and ALWAYS use parameters (never string-concatenate user input).
  const rows = sql.query(
    MyVault.prodDb,                                   // <VaultName>.<secretName>
    "SELECT id, email FROM users WHERE id = @id",     // placeholders: @name (or :name)
    { id: input.userId }
  );
  return rows;          // an array of row objects, e.g. [{ id: 1, email: "a@b.c" }]
  // Limits: max 20 queries/exec (50 Pro); max 10k rows.
  // Use list_vault_secrets(workspaceId) to discover the vault name + available secret
  // names. If the user mentions a DB but has no vault secret yet, ask them for the
  // connection string and store it with create_vault + set_vault_secret — do NOT put a raw
  // connection string in code, and do NOT send them to the UI.
  // NOTE the vault holds credentials for a database the USER already owns; qu4zr does not
  // provision one. With no database available, use the \`store\` global below instead.

VAULT SECRETS IN AN API CALL — the same handles work at the HTTP sink, so an API key NEVER belongs in
block code or the store:
  fetch("https://api.stripe.com/v1/charges", { headers: { "Authorization": MyVault.stripeKey } });
  // A handle as a HEADER VALUE is dereferenced server-side and logged as "***".
  // Key in the URL? Use a {{Vault.secret}} placeholder — concatenation cannot work, a handle has no
  // readable value:
  fetch("https://api.example.com/v1/items?key={{MyVault.apiKey}}");
  // Placeholders resolve in the path/query ONLY, never the host. An unknown vault/secret name errors
  // rather than sending the literal text. Handles are also accepted as the crypto HMAC/pbkdf2 key.

Built-in KEY-VALUE STORAGE — the 'store' global (per-WORKSPACE; survives between runs, no vault/DB to set up):
  // Any JSON value. Great for counters, caches, form submissions, dedup keys.
  store.set(key, value, { ttl })         // create/replace; ttl = seconds until expiry (optional)
  store.get(key)                         // the value, or null if missing/expired
  store.has(key) | store.delete(key)     // -> bool
  store.increment(key, delta?, { ttl })  // ATOMIC counter (delta defaults to 1) -> new number
  store.cas(key, expected, next, { ttl }) // ATOMIC compare-and-swap -> bool; sets next only if current == expected
                                          //   (a missing key counts as null, so expected:null initializes)
  store.list(prefix, { limit, after })   // -> [{ key, value, updatedAt }], key-ordered (after = paging cursor)
  store.count(prefix)                    // number of keys with that prefix
  store.getMany(keys)                    // -> { key: value } for up to 100 keys — ONE operation, not one each
  store.setMany({ k: v, ... }, { ttl })  // write up to 100 entries — ONE operation and one statement
  store.deleteMany(keys)                 // delete exactly these keys — ONE operation -> count that existed
  store.deletePrefix(prefix)             // delete EVERY key under a prefix — ONE operation -> count deleted
  // BATCH, don't loop: 20 store.get calls burn 20 of the 50 ops per execution; store.getMany(keys) costs 1.
  // Cleaning up: deleteMany(keys) when you know which entries are yours, deletePrefix("chunk:") when the
  // whole family is. Prefer deleteMany when the store also holds entries you did not create — a prefix
  // that looks like yours can match someone else's key, and a delete is not undoable.
  // deletePrefix refuses an empty prefix (it would clear the whole store), and setMany rejects a
  // repeated key rather than silently picking a winner.
  // Persistent counter:
  //   const n = store.increment("views"); return { views: n };
  // FIXED-WINDOW RATE LIMIT — increment's ttl arms when the counter STARTS and is not pushed out by
  // later hits, so the window really does lapse. One call, no set()-after-the-first-hit dance:
  //   const hits = store.increment("rl:" + ip, 1, { ttl: 3600 });
  //   if (hits > 100) return Response({ error: "rate_limited" }, 429);
  // No-backend form API (a single API Endpoint block, both verbs):
  //   if (request.method === "POST") { store.set("sub:" + crypto.randomUUID(), JSON.parse(request.body)); return Response({ ok: true }, 201); }
  //   return store.list("sub:").map(e => e.value);
  // Cache an upstream call with TTL: store.set("weather", data, { ttl: 300 });
  // NOT versioned with the flow — it's live data (like a DB); restoring an old grid version does NOT roll it
  // back. Scope = the workspace (shared by collaborators). Limits: key <=256 chars, 50 ops/exec (100 Pro), 100 keys per
  // batch, plus a per-plan entry/size quota. The per-VALUE cap scales with the plan (it is no longer a flat
  // 64KB) — if a value is refused, the error states the actual limit.

Built-in SQL DATABASE — the 'db' global (per-WORKSPACE SQLite; no connection string, no vault):
  // Use this when you want ROWS: things to filter, sort, join, aggregate or count.
  // Use 'store' above for single values looked up by key. They are different tools, both built in.
  db.query(sql, params?)                 // -> array of row objects, exactly like sql.query
  // Parameters are @name (or :name) and are ALWAYS how a value gets into a statement:
  db.query("INSERT INTO tasks (title) VALUES (@title)", { title: body.title });
  const rows = db.query("SELECT * FROM tasks WHERE done = 0 ORDER BY created DESC LIMIT 20");
  // DDL is allowed, and idempotent DDL at the top of the block is the pattern to write. The block
  // runs before anybody has set anything up, and a FORK of this workspace starts with an EMPTY
  // database — the code is copied, the rows never are:
  //   db.query("CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, " +
  //            "created TEXT NOT NULL DEFAULT (datetime('now')))");
  // NOT every plan has one. 'db' is UNDEFINED when the workspace has no database, so a block meant
  // to work on any plan can branch: if (typeof db === "undefined") { ...use store... }
  // It is SQLite: no other server involved, and the SQLite dialect (AUTOINCREMENT is rarely needed —
  // INTEGER PRIMARY KEY already is one; there is no native date type, so store ISO text).
  // NOT versioned with the flow, like the store: restoring an old grid version does not roll the
  // rows back. Scope = the workspace (shared by collaborators, never visible to another workspace).
  // Limits: 20 queries/exec (50 Pro), 10k rows/query, 10s/statement, plus a per-plan size ceiling — a write
  // that would cross it fails with "database or disk is full" rather than being truncated.

EMAIL ('mail') — sent by the platform, no provider account. ONE RULE: an app may only write to
an address that typed back a code the platform mailed it — so this IS passwordless sign-in (never
fake a demo code). mail.sendCode(email,{app}) -> {sent|reason}; mail.verifyCode(email,code) ->
{verified|reason}; mail.send({to,subject,text,app}) -> {queued|reason:"not_verified"|"unsubscribed"};
mail.status(email). TEXT only; the platform adds the sender line and unsubscribe link, and refusals are
values to render. Limits: code 10 min/5 guesses/5 per address per hour, 20 per recipient per day, 20 per
execution, per-plan daily cap. dryRun sends nothing and accepts "000000".

ANALYTICS ('analytics') — first-party events; instrument the funnel BEFORE launch (arrival, first
value, sign-up, activation, came back). analytics.track("signup", actorId, {source:"qu4zr-apps"});
analytics.report({days:30, events:[...], daily:[...], atLeast:[{event,count}], breakdowns:[{event,prop}],
retention:{cohort:"signup", activity:["app_open"], days:[1,7,30]}}). The actor is hashed and never
returned: "how many", never "who". Names lower-case [a-z0-9_.:-]; 20 tracks + 3 reports per execution.
Retention day N = an activity event N x 24h after that actor's FIRST cohort event. set_app_listing puts
the site on qu4zr.com/apps (an operator approves; its link carries ?ref=qu4zr-apps).

Crypto & encoding (globals available in a Process block):
  crypto.sha256(data, enc?)  |  crypto.md5(data, enc?)          // enc: 'hex'(default)|'base64'|'base64url'
  crypto.hmacSha256(key, data, enc?)                            // HMAC-SHA256; key may be a vault handle
  crypto.hmacSha256Verify(key, data, expected, enc?) -> bool    // CONSTANT-TIME; key may be a vault handle
  crypto.randomUUID()  |  crypto.randomBytes(n, enc?)
  crypto.pbkdf2(password, salt, iterations?, keyBytes?, enc?)   // PBKDF2-HMAC-SHA256 password hashing
  crypto.pbkdf2Verify(password, salt, iterations, expected, keyBytes?, enc?) -> bool  // CONSTANT-TIME
  crypto.verifyJwt(token, jwksUrlOrPem, options?) -> claims     // RS256/ES256; THROWS if invalid
  crypto.verify(alg, data, signature, publicKeyPem) -> bool     // RS256/384/512, ES256/384/512
  // PASSWORDS: always crypto.pbkdf2 — NEVER sha256/md5, and never hand-roll an HMAC stretching loop.
  // Its iterations run in host code, so they don't touch the statement budget:
  //   const salt = crypto.randomBytes(16);
  //   const hash = crypto.pbkdf2(password, salt, 210000, 32);
  //   store.set("user:" + email, { salt, hash, iterations: 210000 });
  //   // login: if (!crypto.pbkdf2Verify(password, u.salt, u.iterations, u.hash)) return Response(…, 401);
  // Store the iteration count WITH the hash so it can be raised later. Limits: 600k iterations,
  // 5 pbkdf2 calls per execution.
  // VISITOR SIGN-IN is built in: NEVER hand-roll a login, a session or an id_token check. The owner
  // enables Google/GitHub/Facebook/Apple/OIDC/email code in Account → Domains → Visitor sign-in. Pages
  // link /.qu4zr/auth/login/<name>?returnTo=/x or load /.qu4zr/auth.js (qu4zr.auth.me/login/logout/
  // fetch). Blocks read request.user ({ id, email, emailVerified, name, provider } | null; key rows on
  // id); authMode "user" 401s the signed-out. Site host only.
  // crypto.verifyJwt is for tokens from ELSEWHERE: ALWAYS pass issuer + audience; invalid THROWS.
  base64.encode(s) | base64.decode(s) | btoa(s) | atob(s)       // UTF-8
  tls.inspect(host, port?) -> { ok, notAfter, daysRemaining, expired, hostMatches, valid, problems[],
                                altNames[], issuer, protocol }   // 5 per execution
  // A certificate a browser would refuse is an ANSWER (valid:false + problems), never an error — which
  // is what lets an app warn BEFORE expiry. SSRF rules as fetch; unreachable -> { ok:false, error }.

  // For an API Endpoint flow, the incoming HTTP request is the 'request' global:
  //   request.method, request.headers, request.query, request.body, request.params
  // Verify a webhook signature (Stripe / GitHub / Twilio / Shopify):
  //   const sig = (request.headers["x-hub-signature-256"] || "").replace(/^sha256=/, "");
  //   if (!crypto.hmacSha256Verify(MyVault.webhookSecret, request.body, sig)) {
  //     return Response({ error: "invalid signature" }, 401);
  //   }
  //   return { ok: true };
  // The HMAC key may be a VAULT HANDLE (<vault>.<secret>) — resolved server-side, so the
  // signing secret never appears in block code. Store it with
  // set_vault_secret(kind:"string"), discover it with list_vault_secrets, reference by name.

REAL-TIME push (channel + SSE) — for live apps (timers, scoreboards, dashboards, chat) push updates to
browsers instead of making them poll:
  - A block PUBLISHES: channel.publish(name, data)  // fan JSON out to subscribers of that per-workspace channel
  - An API Endpoint block SUBSCRIBES browsers by returning an SSE stream of a channel:
      return Response.stream("timer", store.get("state"));   // 2nd arg = optional initial event (current state)
  - The page: const es = new EventSource(url); es.onmessage = e => render(JSON.parse(e.data)); // auto-reconnects
  Pattern: a "command" endpoint updates the store then channel.publish(...) the new state; a "display" endpoint
  is just \`return Response.stream("<name>", store.get("state"))\`. Prefer this over a polling loop — a stream is
  ONE api request (charged on connect), far cheaper than polling, and near-instant. One-way (server→browser),
  JSON messages; publish FULL state (not deltas) so a reconnecting client is correct. Limits: name <=128 chars,
  message <=64KB, 50 publishes/exec, per-workspace stream cap.

Shaping the HTTP response (API Endpoint flows): the final block's plain return value is sent
as JSON with status 200. To control status / headers / content-type, return:
  Response(body, status?, headers?)
  //   XML:      return Response("<ok/>", 200, { "Content-Type": "application/xml" });
  //   redirect: return Response("", 302, { "Location": "https://example.com" });
  //   CSV:      return Response("a,b\\n1,2", 200, { "Content-Type": "text/csv" });
  // A string body sent with a Content-Type goes out verbatim (NOT JSON-wrapped). Webhook
  // receivers usually just: return Response({ received: true }, 200);
  //
  // A Response with a 4xx/5xx status ENDS the flow there: blocks downstream of it do not run, and
  // its body, status and headers are what the caller gets. So guard clauses work the way they read —
  // \`if (!allowed) return Response({ error: "unsupported_action" }, 400);\` in a Process block never
  // reaches the SignalR / HTTP block wired after it. 2xx and 3xx keep the flow going.
  //
  // BINARY (images, PDFs, ZIPs) — Response.binary(base64, status?, headers?). The body is base64
  // TEXT and the gateway writes the DECODED bytes:
  //   return Response.binary(base64Png, 200, { "Content-Type": "image/png" });
  // Use it for ANY non-text payload. A plain Response() writes its body as UTF-8, which re-encodes
  // every byte above 0x7F — a PNG handed to Response() is corrupt at its first byte, and the
  // failure looks like "the image is broken" rather than anything you can debug from the code.
  // A FIXED asset (logo, font, og image) needs no block: store "img/og.png" (base64) and serve it with
  // staticFile. Response.binary is for bytes you build (base64.encode) or get from an API. Test/execute
  // hand back the base64 undecoded; only the deployed endpoint writes bytes.
  //
  // COOKIES: request.headers.cookie in, a "Set-Cookie" header out. Name a cookie of your own
  // "__Host-…" (Secure; Path=/) — sites share one parent domain. For sign-in, see VISITOR SIGN-IN.

ON-PREM ("SignalR") blocks — run logic on the USER'S machine/network (local time, an internal
database, local files) that the cloud sandbox can't reach. Add a block of type "SignalR" with a C#
"handlerCode".
  // handlerCode is ONLY THE BODY of this method — the statements that go inside it. Do NOT include the
  // method signature, a class, or 'using' lines; the runner wraps your body in:
  //   object Execute(JsonElement input, IReadOnlyDictionary<string,string?> local) { <handlerCode> }
  // It runs UNSANDBOXED on the user's runner. 'input' is the upstream output (JsonElement). End with a return.
  // Local time — handlerCode is exactly:
  //   return new { now = DateTime.Now.ToString("o"), machine = Environment.MachineName };
  // Local database (the connection string lives in the runner's appsettings "Local", read as
  // local["name"] — never put it in code): provider is postgres|mysql|sqlserver|oracle|sqlite.
  //   var rows = RunnerDb.Query("postgres", local["customersDb"], "SELECT id, name FROM customers LIMIT 50");
  //   return new { count = rows.Count, customers = rows };
  // OUTPUT: the block's return value flows downstream as the next block's 'input' (a plain object) and, if
  // it's the LAST block, is exactly what the endpoint returns. So API Endpoint → SignalR is usually the whole
  // flow — you do NOT need a Process block after it, and there is no input.output wrapper.
  // signalRGuid: get_workspace_content returns each SignalR block's signalRGuid — use THAT for setup_runner /
  // test_runner_handler. Never ask the user for it.
  // RUN IT (automatic) — call setup_runner(signalRBlockId, confirm:true). It downloads, builds, onboards, and
  // LAUNCHES the runner on the user's machine. It runs UNSANDBOXED C#, so confirm with the user first and show
  // them the Handler.cs it returns. On a build error, fix the handler (set_workspace_content) and call it again.
  // The launched runner serves the LIVE endpoint AND accepts test pushes at once — no mode switch / restart.
  // (No .NET SDK or they decline the auto-launch? setup_runner with run:false sets it up without launching, or
  // they download it and run 'dotnet run' by hand.)
  // VERIFY/ITERATE: once the runner is up, test_runner_handler(signalRBlockId, handlerCode?, input?) compiles
  // + runs a handler on their machine and returns the output — the on-prem twin of test_block. Iterate until
  // green. Then deploy the API Endpoint (below) and the live flow returns the on-prem result.
  // ALWAYS-ON: a foreground runner stops on reboot (endpoint then returns empty). Once it's verified +
  // deployed, OFFER to make it survive reboots: setup_runner(signalRBlockId, confirm:true, installService:true)
  // installs it as an OS service — the user approves an admin/UAC prompt. Don't do it unprompted.
  // CONSUMER APP: setup_runner is for the developer's machine, NOT the application's customers.
  // A finished consumer app MUST show the direct .exe URL returned by get_consumer_runner_download.
  // That URL exists only once the handler has been RELEASED: release_runner_handler compiles the
  // block's current handler into the executable users download, and the build takes a few minutes.
  // Never finish such an app with only dashboard instructions, a source ZIP, or no download link.
  // A DOWNLOAD LINK FOR AN UNSIGNED ARTIFACT MUST CARRY ITS WARNING. get_consumer_runner_download
  // returns unsignedWarning whenever the executable is not code-signed; put that warning beside the
  // link, because the alternative is a stranger meeting a full-screen "Windows protected your PC"
  // with no idea it was expected. Never call the file verified, signed or safe.
  // list_runner_clients distinguishes the Developer Runner from Consumer App Runners. Never infer one
  // from the other, and every consumer execution must use the authenticated user's mapped deviceId.
  // HOW A PAGE REACHES ONE USER'S MACHINE: a SignalR block with no target routes to the DEVELOPER
  // runner — this dashboard's own machine — and nowhere else. So a consumer flow is two blocks:
  // an endpoint/process block that authenticates the caller, looks their deviceId up (store is the
  // obvious place), and calls runner.target(deviceId); then the SignalR block linked below it.
  // Never pass a deviceId straight from input.body into runner.target: that hands the choice of
  // whose machine to drive to whoever called the endpoint.
  // The handler's local values are what the runner asks its user for on first launch: writing
  // local[vlcPassword] in the handler is what makes that field appear in the runner's setup page.
  // ORDER MATTERS when building one of these: create the domain and DEPLOY the pairing page first,
  // then release with that page's HTTPS URL as consumerPairingUrl — the URL is compiled into the
  // executable, so changing it later means releasing again and already-installed runners keep
  // opening the old one.
  // A customer launches the generic installer, which opens the application's HTTPS handoff page with pairingId.
  // CLAIMING IT NEEDS NO CREDENTIAL. A server-side block calls runner.claimPairing(pairingId, name?),
  // which runs as the workspace owner and returns { deviceId, blockId, name } — or null if the
  // pairing expired or was already claimed, which is an ordinary outcome to render, not an error.
  // Store that deviceId against your own signed-in user (store.set) and pass it to runner.target later.
  // A machine that is ALREADY paired can reopen your pairing page from the runner's tray icon
  // ("Set up another phone…"), which is how a user adds a second phone or recovers one they lost.
  // claimPairing then answers with the SAME deviceId, so upsert your token->device mapping rather
  // than assume every claim is a new machine — and never tell a user to delete files by hand.
  // NEVER build an OAuth/Management-API credential into a consumer app to do this, never put one in
  // the vault for it, and never ask the app's author or its end users for an API key: there is
  // nothing to authenticate — the execution already runs as the owner. Browser JavaScript must only
  // ever send the pairingId to your own endpoint. claim_runner_pairing (MCP) is for an explicit
  // integration test only. Multiple deviceIds may coexist on one block; every command targets the
  // authenticated user's server-side device mapping.

VERIFY before deploying: after set_workspace_content, call
test_block(workspaceId, blockId, input?) to run a Process block in isolation with sample
input and read its output (or the JS error in details). Fix and re-save until it's right.
While iterating, pass dryRun:true — the block still runs on the real engine, but fetch and sql.query
are stubbed and reach nothing, so you don't burn third-party API calls or write to a real database
on every attempt. The reply's dryRun report lists what it WOULD have called. Do one final test
WITHOUT dryRun before deploying, so the real integration is exercised at least once.
  - IF THE BLOCK READS \`request\`, PASS \`request\` to test_block. There is no request global unless
    you supply one, so a block written for an endpoint answers "request is not defined" here whatever
    else is true of it. That error is the harness, not your code, and re-running the same test cannot
    make it go away.
  - THEN VERIFY IT END TO END, because three different things can be broken and each check only sees
    one of them:
      validate_blocks   the code parses
      test_block        one block returns what you expect
      execute_workspace the blocks are WIRED — an endpoint whose Process block is not linked to it
                        returns null here, and that null is the finding
      call_endpoint     the deployed URL actually answers — the deployment, the path, the verbs and
                        the key, none of which any of the above can see
    A build that passes the first three and was never deployed is a build whose every request 404s,
    and from a browser that is indistinguishable from broken code. After deploying anything with a
    URL, call_endpoint(domainId, path) it. When a page's own fetches fail, call_endpoint the path
    they call BEFORE touching the page: a 404 there means nothing is deployed, not that the page is
    wrong.

DEPLOY (don't leave it half-built): when the user asked for an endpoint / a URL, after building +
verifying the flow, actually publish it — call deploy_endpoint(workspaceId, blockId, domainId, path,
confirm:true) (use list_domains to get a domainId; if the user has none, create one with
create_domain — ask them for the slug, since it is globally unique and permanent in practice, then
create it yourself rather than sending them to the UI).
Setting "endpointPath" on the block alone does NOT create a live URL; deploy_endpoint does. Every
path needs its OWN deploy_endpoint — adding a block to a workspace that already has ten deployed
endpoints publishes nothing, and the new path 404s while the other ten keep working. list_endpoints
shows what is really deployed; call_endpoint proves it.
Once deployed, an endpoint tracks the AUTO-SAVE: every edit is live at the URL immediately, and you
never redeploy to publish a change. Committing does not freeze it either — it archives a disabled
copy per version label, and the live URL keeps serving "head". This is why a change can be live over
HTTP and still absent from a schedule on the same block: see THE PIN IS FROZEN above.
To manage an already-deployed endpoint, use toggle_endpoint (enable/disable, reversible),
update_endpoint (change verbs/path visibility/isAnonymous/notes in place, no redeploy), or
delete_endpoint (permanently un-deploy) with the id from list_endpoints — don't send the user to the
UI for these.
Report the resulting URL. Don't make the user fill the path + deploy by hand in the UI.

NON-ANONYMOUS ENDPOINTS NEED A KEY: deploying with isAnonymous:true (or omitted) makes the URL
public. Setting isAnonymous:false means callers must send Authorization: Bearer <key> (or
?code=<key>) — mint that key with create_domain_api_key (its plaintext apiKey is shown ONLY in
that response, never again; surface it to the user right away). Manage existing keys with
list_domain_api_keys / update_domain_api_key / rotate_domain_api_key / delete_domain_api_key —
don't send the user to the UI for these either.

Example content (API Endpoint → Process):
{
  "blocks": [
    { "id": 1, "type": "API Endpoint", "label": "Webhook", "endpointPath": "orders" },
    { "id": 2, "type": "Process", "label": "Transform", "code": "return input.body;" }
  ],
  "links": [ { "from": 1, "to": 2 } ]
}
`.trim();

// ---- Schemas ----------------------------------------------------------------

// Block/link/file schemas live in ./schemas.js — strict (unknown keys rejected, never stripped)
// and importable by tests without starting the server.

// ---- Server -----------------------------------------------------------------

/**
 * Platform capabilities THIS client knows how to drive. Surfaced by get_block_model so an agent can
 * tell "the platform can't do X" apart from "my client is too old to know about X" — the latter is
 * what actually happened when a pinned 0.19.0 reported no real-time push and no reachable files.
 * Add an entry in the same commit that adds the capability.
 */
const PLATFORM_FEATURES = [
  "process-blocks",
  "api-endpoints",
  "raw-data-blocks",
  "signalr-onprem-blocks",
  "store-kv",
  "vault-sql",
  "vault-in-fetch-headers",
  "vault-url-placeholders",
  "crypto-hmac",
  "crypto-pbkdf2",
  "crypto-verify-jwt",
  "realtime-channel-sse",
  "code-files-import",
  "code-files-nonjs",
  "files-read",
  "static-file-endpoints",
  "site-root-endpoints",
  "file-name-endpoint-paths",
  "seo-page-checks",
  "seo-audit-endpoint",
  "site-host-addresses",
  "per-block-update-delete",
  "fetch-custom-content-type",
  "save-time-syntax-check",
  "statement-budget-introspection",
  "standalone-validate",
  "execution-usage-reporting",
  "create-domain-via-api",
  "create-vault-and-secrets-via-api",
  "store-batch-ops",
  "store-delete-prefix",
  "store-delete-many",
  "store-increment-ttl",
  "store-list-keys-only",
  "store-tiered-value-cap",
  "test-block-dry-run",
  "anchored-file-edits",
  "code-file-digests",
  "binary-responses",
  "canvas-zones",
  "canvas-zone-inference",
  "fetch-timeout-and-timing",
  "fetch-all-concurrent",
  "fetch-no-follow-redirects",
  "tls-inspect",
  "app-email",
  "app-analytics",
  "app-directory",
];

// One server per request when hosted (the SDK binds a server to a single transport), one for the
// process otherwise. Building it only registers the tools: schemas are converted when listed.
function buildServer(): McpServer {
const server = remote
  ? withoutLocalTools(new McpServer({ name: "qu4zr", version }))
  : new McpServer({ name: "qu4zr", version });

server.registerTool(
  "get_block_model",
  {
    title: "Block model reference",
    description:
      "Returns the qu4zr workspace/block/link schema, the JS runtime notes, this client's version and " +
      "the platform features it knows about, plus an example. Read this before building.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  // The version + feature list is here for a specific failure: an OLD CLIENT LOOKS LIKE A MISSING
  // PLATFORM FEATURE. A stale qu4zr-mcp once reported "no real-time push" and "workspace files are
  // unreachable" — both true of that client, both false of the platform — and nothing in the tool
  // output made the staleness visible. Now it is.
  async () =>
    ok(
      `qu4zr-mcp ${version} — features: ${PLATFORM_FEATURES.join(", ")}\n` +
        `If a capability you need is missing from that list, your client may be out of date: ` +
        `check \`npm view qu4zr-mcp version\` and upgrade before concluding the platform can't do it.\n` +
        `NOTE: \`npx -y qu4zr-mcp\` runs a LOCAL node_modules copy if one exists in the working ` +
        `directory — that pin does not auto-update.\n\n` +
        BLOCK_MODEL,
    ),
);

server.registerTool(
  "list_workspaces",
  {
    title: "List workspaces",
    description: "Lists the workspaces the authenticated user can access. Optionally filter by name.",
    inputSchema: {
      nameStartsWith: z.string().optional().describe("Only workspaces whose name starts with this (case-insensitive)."),
      nameContains: z.string().optional().describe("Only workspaces whose name contains this (case-insensitive)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ nameStartsWith, nameContains }) =>
    run(() => client.request("GET", `/api/v1/workspaces${qs({ nameStartsWith, nameContains })}`)),
);

server.registerTool(
  "get_workspace_content",
  {
    title: "Get workspace content",
    description: "Returns a workspace's current blocks and links.",
    inputSchema: { workspaceId: z.number().int() },
    annotations: { readOnlyHint: true },
  },
  async ({ workspaceId }) => run(() => client.request("GET", `/api/v1/workspaces/${workspaceId}/content`)),
);

server.registerTool(
  "list_vault_secrets",
  {
    title: "List a workspace's vault secrets (names only)",
    description:
      "Lists the vault name and secret names available to a workspace's Process blocks — " +
      "NAMES and metadata (kind, db provider) only, never values. Reference a connection in " +
      "code as <vaultName>.<secretName>, e.g. sql.query(MyVault.prodDb, ...). If it's empty, create " +
      "the vault with create_vault and add secrets with set_vault_secret — no UI step needed.",
    inputSchema: { workspaceId: z.number().int() },
    annotations: { readOnlyHint: true },
  },
  async ({ workspaceId }) => run(() => client.request("GET", `/api/v1/workspaces/${workspaceId}/vault`)),
);

server.registerTool(
  "create_vault",
  {
    title: "Create (or rename) a workspace's vault",
    description:
      "Creates the workspace's secret vault, or renames an existing one. The name is the IDENTIFIER " +
      "block code uses: with name \"MyVault\", a secret \"prodDb\" is referenced as MyVault.prodDb. " +
      "Do this once, then add secrets with set_vault_secret. Renaming an existing vault BREAKS code " +
      "that references the old name, so it requires confirm=true. Only the workspace OWNER can.",
    inputSchema: {
      workspaceId: z.number().int(),
      name: z.string().min(1).describe('Vault identifier used in block code, e.g. "MyVault". Letters/digits/underscore.'),
      confirm: z.boolean().optional().describe("Required only when renaming an existing vault (creating a new one does not need it)."),
    },
  },
  async ({ workspaceId, name, confirm }) => createVault(client, workspaceId, name, confirm),
);

server.registerTool(
  "set_vault_secret",
  {
    title: "Add a write-only secret to a workspace's vault",
    description:
      "Stores a secret in the workspace's vault. WRITE-ONLY: the value is encrypted server-side and " +
      "can never be read back — not by this tool, not by block code, not by you. Block code gets an " +
      "opaque handle <vaultName>.<secretName> that the server dereferences at the point of use " +
      "(sql.query, a fetch header, a {{Vault.secret}} URL placeholder, crypto.hmacSha256), and logs " +
      'show ***. kind:"string" for a token/password/API key; kind:"connection" for a database ' +
      "connection string, which also needs provider (postgres|sqlserver|oracle|mysql|sqlite). " +
      "Requires confirm=true. NEVER invent a secret value — ask the user for it. Create the vault " +
      "first with create_vault. Only the workspace OWNER can.",
    inputSchema: {
      workspaceId: z.number().int(),
      name: z.string().min(1).describe('Secret name as referenced in code, e.g. "prodDb" → MyVault.prodDb.'),
      kind: z.enum(["string", "connection"]).describe('"string" for a token/password; "connection" for a DB connection string.'),
      value: z.string().min(1).describe("The secret itself. Stored encrypted; never readable again. Get it from the user."),
      provider: z
        .enum(["postgres", "sqlserver", "oracle", "mysql", "sqlite"])
        .optional()
        .describe('Required for kind:"connection" — which database the connection string targets.'),
      confirm: z.boolean().optional().describe("Must be true to store the secret. Omit/false returns a preview only."),
    },
  },
  async ({ workspaceId, name, kind, value, provider, confirm }) =>
    setVaultSecret(client, workspaceId, { name, kind, value, provider }, confirm),
);

server.registerTool(
  "get_workspace_data",
  {
    title: "Read the workspace data store",
    description:
      "Reads the per-workspace key-value store — the same data blocks read/write via the `store` global. " +
      "Give a `key` to fetch one entry, or omit it to LIST entries (optionally filtered by `prefix`, paged " +
      "with `limit` + `after`). Values are JSON. Read-only. Pass keysOnly:true when you are deciding WHICH " +
      "keys to act on — you get key, size and timestamps without the values, which is usually a fraction of " +
      "the reply and tells you everything a cleanup or an audit needs.",
    inputSchema: {
      workspaceId: z.number().int(),
      key: z.string().optional().describe("Fetch this exact key. Omit to list."),
      prefix: z.string().optional().describe("List only keys starting with this prefix."),
      limit: z.number().int().optional(),
      after: z.string().optional().describe("Paging cursor: the nextAfterKey from a previous list call."),
      keysOnly: z
        .boolean()
        .optional()
        .describe("List keys, sizes and timestamps WITHOUT the values. Use it to decide what to read or delete."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ workspaceId, key, prefix, limit, after, keysOnly }) => {
    if (key !== undefined) {
      return run(() => client.request("GET", `/api/v1/workspaces/${workspaceId}/data/entries/${encKey(key)}`));
    }
    const qs = new URLSearchParams();
    if (prefix) qs.set("prefix", prefix);
    if (limit) qs.set("limit", String(limit));
    if (after) qs.set("after", after);
    if (keysOnly) qs.set("values", "false");
    const q = qs.toString();
    return run(() => client.request("GET", `/api/v1/workspaces/${workspaceId}/data${q ? "?" + q : ""}`));
  },
);

server.registerTool(
  "set_workspace_data",
  {
    title: "Write to the workspace data store",
    description:
      "Creates or replaces one entry in the per-workspace key-value store. `value` is any JSON. Optional " +
      "`ttlSeconds` expires it. This is live runtime data — NOT versioned with the workspace's grid commits.",
    inputSchema: {
      workspaceId: z.number().int(),
      key: z.string().min(1),
      value: z.unknown().describe("Any JSON value (object, array, string, number, boolean or null)."),
      ttlSeconds: z.number().int().positive().optional().describe("Seconds until the entry expires."),
    },
  },
  async ({ workspaceId, key, value, ttlSeconds }) =>
    run(() => client.request("PUT", `/api/v1/workspaces/${workspaceId}/data/entries/${encKey(key)}`, { value, ttlSeconds })),
);

server.registerTool(
  "delete_workspace_data",
  {
    title: "Delete data store entries",
    description:
      "Permanently deletes from the per-workspace key-value store. Pass exactly ONE of: `key` (one " +
      "entry), `keys` (a NAMED list — up to 100 in a single call, and the right tool for cleaning up " +
      "your own entries while leaving everything else alone), or `prefix` (EVERY entry under it, e.g. " +
      'prefix:"chunk:" clears chunk:0…chunk:99 — for a dataset you own outright). Prefer `keys` over ' +
      "`prefix` whenever the store also holds entries you did not create: a prefix that looks like " +
      "yours can match somebody else's. An empty prefix is refused. Requires confirm=true — call " +
      "without confirm first to preview.",
    inputSchema: {
      workspaceId: z.number().int(),
      key: z.string().min(1).optional().describe("Delete this one entry."),
      keys: z
        .array(z.string().min(1))
        .min(1)
        .max(100)
        .optional()
        .describe("Delete exactly these entries and nothing else. Up to 100 per call."),
      prefix: z.string().min(1).optional().describe("Delete every entry whose key starts with this."),
      confirm: z.boolean().optional().describe("Must be true to delete. Omit/false returns a preview only."),
    },
    annotations: { destructiveHint: true },
  },
  async ({ workspaceId, key, keys, prefix, confirm }) => {
    const given = [key !== undefined, keys !== undefined, prefix !== undefined].filter(Boolean).length;
    if (given !== 1) {
      return ok(
        "Pass exactly one of key (one entry), keys (a named list) or prefix (everything under it).",
      );
    }

    const what =
      key !== undefined
        ? `store entry "${key}"`
        : keys !== undefined
          ? `${keys.length} named store ${keys.length === 1 ? "entry" : "entries"}: ${keys.join(", ")}`
          : `EVERY store entry whose key starts with "${prefix}"`;

    if (confirm !== true) {
      return ok(
        `Preview — will delete ${what} in workspace ${workspaceId}.\n` +
          `Re-run delete_workspace_data with confirm:true to proceed.`,
      );
    }

    if (key !== undefined) {
      return run(async () => {
        await client.request("DELETE", `/api/v1/workspaces/${workspaceId}/data/entries/${encKey(key)}`);
        return `Deleted store entry "${key}".`;
      });
    }

    if (keys !== undefined) {
      return run(() => client.request("POST", `/api/v1/workspaces/${workspaceId}/data/delete-many`, { keys }));
    }

    return run(() =>
      client.request("DELETE", `/api/v1/workspaces/${workspaceId}/data${qs({ prefix })}`),
    );
  },
);

/*
 * The workspace's own SQL database — three tools, split by what they can destroy.
 *
 * Not one tool with a readOnly flag: the scope is decided by the ROUTE on the server
 * (query needs flows:read, execute needs flows:write), so a build-only client cannot
 * reach a DROP by setting a boolean. The split also puts the risky call in the
 * transcript under its own name, which is what a human skimming a session actually sees.
 */
server.registerTool(
  "describe_database",
  {
    title: "Describe the workspace database",
    description:
      "Whether this workspace has its own SQL database, and how much of its allowance is used. " +
      "Ask before building anything that needs one. `included:false` means the owner's plan has no " +
      "database — that is an answer, not an error and not something to retry: say so and use the " +
      "key-value store (get/set_workspace_data) instead. `exists:false` with `included:true` just " +
      "means nothing has been written yet.",
    inputSchema: { workspaceId: z.number().int() },
    annotations: { readOnlyHint: true },
  },
  async ({ workspaceId }) => run(() => client.request("GET", `/api/v1/workspaces/${workspaceId}/database`)),
);

server.registerTool(
  "query_database",
  {
    title: "Read from the workspace database",
    description:
      "Runs a READ against the workspace's own SQLite database — the same one blocks reach as " +
      "db.query(...). The connection cannot write, so a statement that turns out to change something " +
      "is refused rather than run; use execute_sql for that.\n\n" +
      "To see what exists:\n" +
      "  SELECT name FROM sqlite_master WHERE type = 'table'\n" +
      "  SELECT name, type, pk FROM pragma_table_info('tasks')\n\n" +
      "Note the second one: PRAGMA table_info(...) counts as a write on this connection, while the " +
      "pragma_table_info(...) function is an ordinary read and answers the same question. " +
      "Parameters are @name or :name — never concatenate a value into SQL.",
    inputSchema: {
      workspaceId: z.number().int(),
      sql: z.string().min(1).describe('One statement, e.g. "SELECT * FROM tasks ORDER BY created DESC LIMIT 20".'),
      params: z.record(z.string(), z.unknown()).optional().describe('Values for the @name placeholders, e.g. { "id": 7 }.'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ workspaceId, sql, params }) =>
    run(() =>
      client.request("POST", `/api/v1/workspaces/${workspaceId}/database/query`, { sql, parameters: params ?? null }),
    ),
);

server.registerTool(
  "execute_sql",
  {
    title: "Write to the workspace database",
    description:
      "Changes the workspace's own SQLite database: CREATE TABLE, ALTER, INSERT, UPDATE, DELETE, " +
      "CREATE INDEX. Use query_database for anything that only reads.\n\n" +
      "There is no undo. A restore point reverts blocks, links and files — never rows — so a DROP or " +
      "a DELETE here is permanent. Requires confirm:true; call without it first to preview.\n\n" +
      "Schema meant for a block should be idempotent, because the block runs before anybody has set " +
      "anything up and a FORK of the workspace starts with an EMPTY database (the code is copied, the " +
      'rows never are): CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL).\n\n' +
      "LOADING MANY ROWS: one statement per batch, the rows passed as ONE JSON parameter and unpacked by " +
      "json_each — never one INSERT per row. Measured 2026-10-24: 36 262 rows in batches of 4 000 at ~2 s a " +
      "batch.\n" +
      "  sql: INSERT INTO place (code, name, lat, lon) SELECT j.value->>'$.code', j.value->>'$.name', " +
      "j.value->>'$.lat', j.value->>'$.lon' FROM json_each(@rows) AS j\n" +
      '  params: { rows: "[{\\"code\\":\\"75056\\",\\"name\\":\\"Paris\\",\\"lat\\":48.86,\\"lon\\":2.35}, …]" }  (a JSON STRING)\n' +
      "Make a reload idempotent (INSERT OR REPLACE, or DELETE then INSERT) so " +
      "a batch that failed can simply be sent again.",
    inputSchema: {
      workspaceId: z.number().int(),
      sql: z.string().min(1).describe("One statement to run. Many rows: INSERT … SELECT … FROM json_each(@rows)."),
      params: z.record(z.string(), z.unknown()).optional().describe("Values for the @name placeholders."),
      confirm: z.boolean().optional().describe("Must be true to run it. Omit/false returns a preview only."),
    },
    annotations: { destructiveHint: true },
  },
  async ({ workspaceId, sql, params, confirm }) => {
    if (confirm !== true) {
      return ok(
        `Preview — will run this against workspace ${workspaceId}'s database:\n\n${sql}\n\n` +
          `Re-run execute_sql with confirm:true to proceed. There is no undo for rows.`,
      );
    }

    return run(() =>
      client.request("POST", `/api/v1/workspaces/${workspaceId}/database/execute`, { sql, parameters: params ?? null }),
    );
  },
);

server.registerTool(
  "create_workspace",
  {
    title: "Create workspace",
    description: "Creates a new, empty workspace with the given name. Returns the new workspace (incl. its id).",
    inputSchema: { name: z.string().min(1) },
  },
  async ({ name }) => run(() => client.request("POST", "/api/v1/workspaces", { name })),
);

server.registerTool(
  "set_workspace_content",
  {
    title: "Set workspace content",
    description:
      "REPLACES a workspace's blocks and links (it is not an append). This is how you build it. " +
      "Call get_block_model first. To ADD to a workspace that already has content, you MUST first " +
      "get_workspace_content, then send back the existing blocks+links PLUS your new ones (re-use the " +
      "existing ids and signalRGuid/handlerCode it returns — they round-trip losslessly) so you don't wipe " +
      "the user's existing flows. Omit block ids to have the server assign them; leave positions at 0 for " +
      "auto-layout. Returns the canonical stored content. `files` are workspace code files a Process " +
      "block can `import \"utils.js\";` — OMIT to keep existing files, send an array (even []) to REPLACE " +
      "them (get_workspace_content returns them for a lossless round-trip). `zones` are the named " +
      "areas drawn behind the blocks; same rule (omit=keep, []=clear). See ZONES in get_block_model.",
    inputSchema: setWorkspaceContentSchema,
  },
  async ({ workspaceId, blocks, links, files, zones, seo }) =>
    withNote(
      withNote(
        await run(() => {
          preflight(blocks, files);
          return client.request("PUT", `/api/v1/workspaces/${workspaceId}/content`, { blocks, links: links ?? [], files, zones });
        }),
        describeSeo(auditFiles(files, seo)),
      ),
      // The block-level twin of the SEO note, and the same contract: attached to a write that
      // SUCCEEDED, never blocking it. Code on a block that will not run it, and a path that
      // publishes nothing, are both legal to store and both invisible until something 404s.
      describeNotes(notesForContent(blocks, links)),
    ),
);

server.registerTool(
  "add_to_workspace",
  {
    title: "Append a flow to a workspace",
    description:
      "APPENDS a self-contained flow (new blocks + links among them) to a workspace WITHOUT touching its " +
      "existing blocks — the SAFE way to add to a workspace that already has content. Unlike " +
      "set_workspace_content it cannot wipe existing flows and needs no read-modify-write: the server assigns " +
      "fresh non-colliding ids and lays the new flow out below the existing blocks. Links here may only " +
      "connect your NEW blocks to each other; to wire INTO an existing block, use get_workspace_content + " +
      "set_workspace_content instead. Returns the added blocks with their assigned ids + signalRGuid. " +
      "`zones` adds new canvas areas alongside the flow; an id that already exists is kept as it is, " +
      "so appending cannot redefine somebody else's zone either.",
    inputSchema: addToWorkspaceSchema,
  },
  async ({ workspaceId, blocks, links, files, zones, seo }) =>
    withNote(
      withNote(
        await run(() => {
          preflight(blocks, files);
          return client.request("POST", `/api/v1/workspaces/${workspaceId}/content/append`, { blocks, links: links ?? [], files, zones });
        }),
        describeSeo(auditFiles(files, seo)),
      ),
      describeNotes(notesForContent(blocks, links)),
    ),
);

server.registerTool(
  "infer_zones",
  {
    title: "Group an existing workspace into zones",
    description:
      "Reads a workspace's paths, static files and block types, groups its flows into labelled areas " +
      "and LAYS THE BLOCKS OUT inside them. For a workspace built before zones existed — otherwise the " +
      "biggest applications, the ones with the most to gain, stay the ones that look the most " +
      "disorganised. It MOVES blocks, which is the point; nothing else changes (no block is created, " +
      "deleted or edited, the links and code files are untouched), and every zone it produces is an " +
      "ordinary one the user can rename, recolour or delete. Requires confirm=true — call without it " +
      "first to see what it proposes. For a workspace you are BUILDING, pass zones to " +
      "set_workspace_content/add_to_workspace instead: you know what the areas are, this has to guess.",
    inputSchema: {
      workspaceId: z.number().int(),
      confirm: z.boolean().optional().describe("Must be true to move the blocks. Omit/false previews only."),
    },
    annotations: { destructiveHint: true },
  },
  async ({ workspaceId, confirm }) => {
    if (confirm !== true) {
      return ok(
        `Preview — will group workspace ${workspaceId}'s blocks into zones and MOVE them into place.\n` +
          `Existing zones are replaced by the inferred ones. Re-run infer_zones with confirm:true to proceed.`,
      );
    }
    return run(() => client.request("POST", `/api/v1/workspaces/${workspaceId}/content/zones/infer`));
  },
);

server.registerTool(
  "update_block",
  {
    title: "Update one block",
    description:
      "Changes ONE block in place. THIS is how you fix a block — do NOT re-send the whole workspace with " +
      "set_workspace_content to edit one field, and do NOT append a 'v2' block next to a broken one. " +
      "Send only the fields you're changing: everything else on the block, all other blocks, the links, " +
      "the code files, the camera and the hand-placed layout are untouched. Send \"\" to clear a field. " +
      "Get the blockId from get_workspace_content. Returns the block as it now stands.",
    inputSchema: updateBlockSchema,
  },
  async ({ workspaceId, blockId, ...patch }) =>
    withNote(
      await run(() => {
        // Mirrors the server's PATCH rule exactly (WorkspacesController.UpdateBlock): a patch is
        // syntax-checked only when it carries `code`, and that code is always parsed as a Process
        // block's — the patch doesn't tell us the block's real type, and checking is the safe read.
        if (patch.code !== undefined) {
          preflight([{ id: blockId, type: "Process", label: patch.label, code: patch.code }]);
        }
        return client.request("PATCH", `/api/v1/workspaces/${workspaceId}/content/blocks/${blockId}`, patch);
      }),
      // Read off the PATCH, which is why this says less than the server's own note: a patch that
      // omits `type` — every patch that is not changing it — cannot be judged for code that will
      // never run, so that half stays silent here rather than guessing. Fewer notes is the allowed
      // direction; inventing one is not.
      describeNotes(notesForBlock({ id: blockId, ...patch })),
    ),
);

server.registerTool(
  "delete_block",
  {
    title: "Delete one block",
    description:
      "Permanently deletes ONE block and every link touching it, leaving the rest of the workspace alone — " +
      "use it to clean up orphaned or superseded blocks. Requires confirm=true; call without confirm first " +
      "to preview. A deployed endpoint bound to this block is NOT removed (delete it with delete_endpoint), " +
      "and an on-prem runner behind a SignalR block is left provisioned.",
    inputSchema: deleteBlockSchema,
    annotations: { destructiveHint: true },
  },
  async ({ workspaceId, blockId, confirm }) => {
    if (confirm !== true) {
      return ok(
        `Preview — will delete block ${blockId} in workspace ${workspaceId}, plus every link touching it.\n` +
          `Re-run delete_block with confirm:true to proceed.`,
      );
    }
    return run(() => client.request("DELETE", `/api/v1/workspaces/${workspaceId}/content/blocks/${blockId}`));
  },
);

server.registerTool(
  "list_schedules",
  {
    title: "List a workspace's schedules",
    description:
      "Shows every schedule on a workspace: what it fires, its cron and timezone, when it next runs, " +
      "how the last run went, and why it is paused if it is. Check here before creating one — a " +
      "second schedule on the same block is two jobs, not an edit.\n\n" +
      "READ canvasAheadOfPin FIRST when a schedule looks broken. A schedule runs the COMMITTED " +
      "version it was pinned to, while deployed endpoints serve the live canvas — so one block can " +
      "answer new code over HTTP while the cron beside it still runs the old one. When " +
      "canvasAheadOfPin is true, canvasDrift lists exactly what differs; the symptom is reported as " +
      '"the cron does nothing" about a cron that is firing perfectly. The fix is ' +
      "commit_workspace_version and then a schedule pinned to the new version — editing the block " +
      "changes nothing on its own.\n\n" +
      "lastStatus is ONE outcome, not a history. Use list_schedule_runs before concluding anything " +
      "about whether a schedule fires.",
    inputSchema: listSchedulesSchema,
    annotations: { readOnlyHint: true },
  },
  async ({ workspaceId }) => run(() => client.request("GET", `/api/v1/workspaces/${workspaceId}/triggers`)),
);

server.registerTool(
  "list_schedule_runs",
  {
    title: "A schedule's recent firings",
    description:
      "Every recent firing of one schedule, newest first: when it started, how long it took, whether " +
      "it succeeded, and what HTTP status the execution returned.\n\n" +
      'THIS is how you answer "did the cron actually run". list_schedules carries only the LAST ' +
      "outcome, and block execution logs exist only for blocks with logging switched on — so a " +
      "healthy schedule with logging off leaves no trace anywhere else and looks exactly like one " +
      "that never fired. Check here before touching the cron, the block or the version: the usual " +
      "finding is that it ran fine every time and the real problem is elsewhere (start with " +
      "canvasAheadOfPin on list_schedules).\n\n" +
      "httpStatus separates the failures a user can act on: 429 is a quota they can raise, 503 is " +
      "the platform's problem, 500 is their code.",
    inputSchema: listScheduleRunsSchema,
    annotations: { readOnlyHint: true },
  },
  async ({ triggerId, limit }) =>
    run(() => client.request("GET", `/api/v1/triggers/${triggerId}/runs${limit === undefined ? "" : `?limit=${limit}`}`)),
);

server.registerTool(
  "create_schedule",
  {
    title: "Run a block on a schedule",
    description:
      "Starts firing a Schedule block on a cron, unattended. THIS is what makes a schedule real — " +
      "setting `schedule` on the block only records the cadence in the workspace's content. " +
      "Requires confirm=true; call without confirm first to preview. " +
      "It pins the latest COMMITTED version (commit first if there isn't one — the error says so), " +
      "and the plan decides the fastest allowed cadence: a free workspace is one schedule, hourly. " +
      "On a free plan the firing time is offset by a fixed number of seconds so every workspace " +
      "doesn't fire at once — the reply reports it, so quote the real time back to the user.\n\n" +
      "PINNING IS FROZEN, and that is the opposite of how deploy_endpoint behaves: an endpoint " +
      "serves the live auto-save and picks up every edit at once, a schedule keeps running its " +
      "commit. So editing a block the schedule fires changes nothing about tonight's run — that " +
      "takes a new commit and a schedule pinned to it. Say this to the user when you create one; " +
      "list_schedules reports canvasAheadOfPin once the two have parted company.",
    inputSchema: createScheduleSchema,
    annotations: { destructiveHint: false },
  },
  async ({ workspaceId, blockId, cron, timeZone, versionId, confirm }) => {
    if (confirm !== true) {
      return ok(
        `Preview — will fire block ${blockId} of workspace ${workspaceId} on "${cron}" (${timeZone ?? "UTC"}), ` +
          `pinned to ${versionId ? `version ${versionId}` : "the latest committed version"}.\n` +
          `This runs unattended and consumes the scheduled-run quota. Re-run create_schedule with confirm:true to proceed.`,
      );
    }
    return run(() =>
      client.request("POST", `/api/v1/workspaces/${workspaceId}/triggers`, { blockId, cron, timeZone, versionId }),
    );
  },
);

server.registerTool(
  "pause_schedule",
  {
    title: "Pause a schedule",
    description:
      "Stops a schedule firing, keeping it and its history. No confirmation needed: stopping a " +
      "runaway job should never be the harder thing to do. Use resume_schedule to start it again.",
    inputSchema: pauseScheduleSchema,
  },
  async ({ triggerId }) => run(() => client.request("POST", `/api/v1/triggers/${triggerId}/pause`)),
);

server.registerTool(
  "resume_schedule",
  {
    title: "Resume a paused schedule",
    description:
      "Starts a paused schedule again and clears its failure count. Requires confirm=true — this is " +
      "the moment code begins running unattended again. If it was auto-paused (five consecutive " +
      "failures, or an exhausted quota), fix the cause first: resuming a broken job just burns the " +
      "quota again and re-pauses it.",
    inputSchema: resumeScheduleSchema,
  },
  async ({ triggerId, confirm }) => {
    if (confirm !== true) {
      return ok(
        `Preview — will resume schedule ${triggerId}; it will run unattended on its cron.\n` +
          `Re-run resume_schedule with confirm:true to proceed.`,
      );
    }
    return run(() => client.request("POST", `/api/v1/triggers/${triggerId}/resume`));
  },
);

server.registerTool(
  "update_schedule",
  {
    title: "Point a schedule at a newer commit",
    description:
      "A schedule runs the COMMIT it was created on, not the canvas — so after you change and commit the " +
      "workflow, the schedule keeps running the old code. This repins it onto another commit (the " +
      "latest one when versionId is omitted) without touching its cron, jitter, run history or whether " +
      "it is enabled: no more delete-and-recreate. The auto-save cannot be pinned (commit first). " +
      "Requires confirm=true: it changes which code runs unattended.",
    inputSchema: updateScheduleSchema,
  },
  async ({ triggerId, versionId, confirm }) => {
    if (confirm !== true) {
      return ok(
        `Preview — will repin schedule ${triggerId} onto ${versionId ? `commit ${versionId}` : "the latest commit"}; ` +
          `its next unattended run will execute that code.
Re-run update_schedule with confirm:true to proceed.`,
      );
    }
    return run(() => client.request("POST", `/api/v1/triggers/${triggerId}/repin`, versionId ? { versionId } : {}));
  },
);

server.registerTool(
  "delete_schedule",
  {
    title: "Delete a schedule",
    description:
      "Permanently removes a schedule and its history. The block stays; only the firing goes. " +
      "Requires confirm=true; call without confirm first to preview. To stop it temporarily, " +
      "pause_schedule keeps the history.",
    inputSchema: deleteScheduleSchema,
    annotations: { destructiveHint: true },
  },
  async ({ triggerId, confirm }) => {
    if (confirm !== true) {
      return ok(
        `Preview — will permanently delete schedule ${triggerId} and its run history.\n` +
          `Re-run delete_schedule with confirm:true to proceed, or pause_schedule to just stop it.`,
      );
    }
    return run(() => client.request("DELETE", `/api/v1/triggers/${triggerId}`));
  },
);

server.registerTool(
  "list_files",
  {
    title: "List workspace code files",
    description:
      "Lists the workspace's code files with their sizes — names only, no content. Use it to see what " +
      "exists before reading or writing one, instead of pulling the whole workspace to find out.",
    inputSchema: listFilesSchema,
    annotations: { readOnlyHint: true },
  },
  async ({ workspaceId }) => run(() => client.request("GET", `/api/v1/workspaces/${workspaceId}/content/files`)),
);

server.registerTool(
  "read_file",
  {
    title: "Read one code file",
    description:
      "Returns ONE code file's content. Names are case-sensitive. Cheaper and safer than " +
      "get_workspace_content when you only need a file — and you must read a file before rewriting it, " +
      "since write_file replaces the whole thing.",
    inputSchema: readFileSchema,
    annotations: { readOnlyHint: true },
  },
  async ({ workspaceId, name }) => run(() => client.request("GET", codeFilePath(workspaceId, name))),
);

server.registerTool(
  "write_file",
  {
    title: "Create or replace one code file",
    description:
      "THIS is how you edit a workspace code file — a page, a stylesheet, a helper library. Creates it " +
      "if it doesn't exist. Do NOT re-send the whole workspace with set_workspace_content to change one " +
      "file: everything else (blocks, links, other files, the camera, the layout) stays untouched here, " +
      "and re-emitting files you didn't mean to change is how one of them gets silently corrupted. " +
      "`content` is the FULL new content, so this is the tool for CREATING a file or replacing one " +
      "outright — to change part of a file that already exists, use edit_file instead. " +
      "Names are case-sensitive; a name differing only in case from an existing file is rejected " +
      "(rename = write the new name, then delete_file the old one). Writing an HTML PAGE also returns " +
      "what a findable page is still missing (title, description, canonical, lang…) — advisory only, " +
      "the file is written either way; see get_block_model's PUBLISHING A SITE.",
    inputSchema: writeFileSchema,
  },
  async ({ workspaceId, name, content, seo }) =>
    withNote(
      await run(() => {
        // Same local pre-flight as the block writes, checked as a FILE: a code file defines things and
        // must not have a top-level return, unlike a block.
        preflight(undefined, [{ name, content }]);
        return client.request("PUT", codeFilePath(workspaceId, name), { content });
      }),
      // An HTML page gets read for what a findable page needs — after the write, never instead of it.
      describeSeo(auditPage(name, content, seo)),
    ),
);

server.registerTool(
  "edit_file",
  {
    title: "Change part of a code file",
    description:
      "Replaces ONE passage inside a file that already exists, leaving every other byte alone — the " +
      "tool to reach for whenever you are modifying rather than creating. write_file takes the FULL " +
      "content, so using it to change a heading on an 80 KB page means reproducing 80 KB exactly, and " +
      "one character wrong in that reproduction is a corruption that surfaces when a visitor loads the " +
      "page, not when the tool returns. `oldString` must match the file exactly (whitespace included) " +
      "and appear ONCE — include a line above and below to make it unique, or pass replaceAll. " +
      "`newString` may be empty to delete the passage. The read-modify-write happens server-side in " +
      "one request, so two edits cannot interleave. Nothing is saved if the result would not parse. " +
      "The reply carries the file's sha256, so you can prove what the server now holds.",
    inputSchema: editFileSchema,
  },
  async ({ workspaceId, name, oldString, newString, replaceAll, seo }) => {
    const path = codeFilePath(workspaceId, name);
    const result = await run(async () => {
      try {
        return await client.request("PATCH", path, { oldString, newString, replaceAll: replaceAll ?? false });
      } catch (err) {
        // A qu4zr older than this client has no PATCH route on the file resource. Saying so beats a
        // bare 404/405, which reads as "the file is missing" — the one thing it does not mean.
        const message = err instanceof Error ? err.message : String(err);
        if (/→ (404|405)/.test(message)) {
          throw new Error(
            "This qu4zr server does not support edit_file yet (it needs the anchored-file-edit route). " +
              "Use read_file + write_file for now, or ask the operator to update the server. " +
              `Original error: ${message}`,
          );
        }
        throw err;
      }
    });

    // The page checks need the whole page, which an edit deliberately never carries. Re-reading it
    // costs one round trip and NO tokens — the content is audited here and thrown away, never
    // returned — so an edited page gets the same advice a written one does.
    if (result.isError || seo === "none" || !/\.html?$/i.test(name)) return result;

    let note: string | undefined;
    try {
      const after = await client.request<{ content?: string }>("GET", path);
      note = describeSeo(auditPage(name, after?.content ?? "", seo));
    } catch {
      // The edit landed; failing to fetch it back for advice must not report the edit as failed.
    }
    return withNote(result, note);
  },
);

server.registerTool(
  "sync_files",
  {
    title: "Write many code files at once",
    description:
      "Writes MANY code files in ONE request — a whole site, from a list or straight from a folder on " +
      "this machine (localDir; fonts and images are read as base64, hidden and build folders skipped). " +
      "Use it instead of a write_file per file: one save, all or nothing, and every file carries a " +
      "sha256 computed here that the server checks before storing anything, so a corrupted transfer " +
      "stores none. Byte-identical files are reported `unchanged` and not rewritten. `prefix` puts local " +
      "files under a workspace folder (\"public\" → public/index.html). deleteMissing removes workspace " +
      "files the batch does not contain — only under prefix when one is given — and needs confirm:true.",
    inputSchema: syncFilesSchema,
    annotations: { destructiveHint: true },
  },
  async ({ workspaceId, files, localDir, prefix, deleteMissing, confirm }) => {
    if (remote && localDir) return ok(LOCAL_DIR_REFUSAL);
    const problem = syncArgsProblem({ files, localDir });
    if (problem) return ok(problem);

    return run(async () => {
      // A digest per file either way: for a local folder it proves the bytes on disk are the bytes
      // stored; for a list, that nothing was lost between here and the server.
      const collected = localDir
        ? await collectLocalFiles(localDir, prefix)
        : { items: (files ?? []).map((f) => ({ ...f, sha256: digest(f.content) })), skipped: [] };
      const items = collected.items;

      if (deleteMissing === true && confirm !== true) {
        return {
          preview: true,
          message: `Would write ${items.length} file(s) to workspace ${workspaceId} and DELETE every other file` +
            `${prefix ? ` under "${prefix}"` : " in the workspace"}. Re-run with confirm:true to proceed.`,
          files: items.map((i) => i.name),
          skipped: collected.skipped,
        };
      }

      preflight(undefined, items.filter((i) => i.name.endsWith(".js")).map((i) => ({ name: i.name, content: i.content })));
      const reply = await client.request(
        "POST",
        `/api/v1/workspaces/${workspaceId}/content/files`,
        syncBody(items, deleteMissing === true, deleteMissing === true ? prefix : undefined),
      );
      return collected.skipped.length > 0 ? { ...(reply as object), skipped: collected.skipped } : reply;
    });
  },
);

server.registerTool(
  "delete_file",
  {
    title: "Delete one code file",
    description:
      "Permanently deletes ONE code file. Requires confirm=true; call without confirm first to preview. " +
      "The reply lists the blocks and files that still `import` it — those are now broken references, " +
      "which is not cascaded for you: only the author can decide what should replace them.",
    inputSchema: deleteFileSchema,
    annotations: { destructiveHint: true },
  },
  async ({ workspaceId, name, confirm }) => {
    if (confirm !== true) {
      return ok(
        `Preview — will delete code file "${name}" from workspace ${workspaceId}. Blocks importing it will fail ` +
          `until updated.\nRe-run delete_file with confirm:true to proceed.`,
      );
    }
    return run(() => client.request("DELETE", codeFilePath(workspaceId, name)));
  },
);

server.registerTool(
  "validate_blocks",
  {
    title: "Check JavaScript without writing it",
    description:
      "Parses block code and code files and reports syntax errors WITHOUT touching any workspace — " +
      "no workspaceId, nothing written, nothing to undo if it fails. Use it freely while drafting or " +
      "fixing a block instead of discovering a typo from a rejected write. Returns { valid, " +
      "checkedBlocks, checkedFiles, diagnostics[] } with the line and column of each problem. " +
      'Note `import \"utils.js\";` / `import \"zod@4.4.3\";` lines are valid and are NOT errors.',
    inputSchema: validateBlocksSchema,
    annotations: { readOnlyHint: true },
  },
  async ({ blocks, files }) => run(() => client.request("POST", "/api/v1/validate", { blocks, files })),
);

server.registerTool(
  "audit_seo",
  {
    title: "Check whether pages can be found",
    description:
      "Reads HTML pages for what decides whether anyone finds them — title, meta description, " +
      "canonical, lang, viewport, Open Graph, one <h1>, alt text, JSON-LD — WITHOUT touching any " +
      "workspace. This is the server's audit, so it is the authority: the note attached to write_file " +
      "is a local subset of the same rules. Pass `baseUrl` — the domain's own baseUrl from " +
      "list_domains (e.g. https://marceau.qu4zr.com/), the same base the pages' canonicals use — to " +
      "also get the checks a single page cannot make about itself — a canonical pointing outside the " +
      "site, a hand-written sitemap listing URLs it does not own. Auditing several pages at once adds " +
      "the cross-page ones: two pages sharing a title or a description. " +
      "Returns { ready, checkedPages, errors, warnings, findings[] } where each finding has " +
      "a stable `code`. `ready` means no error-level findings — warnings are advice, not breakage. " +
      "Read it after building a site, and re-run it after fixing.",
    inputSchema: auditSeoSchema,
    annotations: { readOnlyHint: true },
  },
  async ({ files, baseUrl, mode }) =>
    run(() => client.request("POST", "/api/v1/seo/audit", { files, baseUrl, mode })),
);

server.registerTool(
  "get_app_analytics",
  {
    title: "Read an app's analytics",
    description:
      "Reads the product events a workspace's app records with analytics.track — as aggregates only: " +
      "totals and distinct actors per event, per-day counts, actors who did something N+ times, counts " +
      "by a property value, and retention cohorts (day 1/7/30). Never a list of who did what. The " +
      "request has the same shape as analytics.report() in a block. Use it to answer 'how many people " +
      "arrived / signed up / came back after 7 days' without writing a dashboard first.",
    inputSchema: {
      workspaceId: z.number().int(),
      days: z.number().int().min(1).max(400).optional().describe("Window in days (default 30)."),
      events: z.array(z.string()).optional(),
      daily: z.array(z.string()).optional(),
      atLeast: z.array(z.object({ event: z.string(), count: z.number().int().min(1) })).optional(),
      breakdowns: z.array(z.object({ event: z.string(), prop: z.string() })).optional(),
      retention: z
        .object({
          cohort: z.string(),
          activity: z.array(z.string()).optional(),
          days: z.array(z.number().int()).optional(),
        })
        .optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ workspaceId, ...request }) =>
    run(() => client.request("POST", `/api/v1/workspaces/${workspaceId}/analytics/report`, request)),
);

server.registerTool(
  "set_app_listing",
  {
    title: "List a site in the public app directory",
    description:
      "Asks for a domain's site to appear at qu4zr.com/apps (with its own page at qu4zr.com/apps/{slug}). " +
      "The listing starts PENDING: an operator approves it, and any later edit sends it back for review. " +
      "Only for a real, working site the user wants strangers to find — confirm with them first, and write " +
      "the title/tagline as a user would search for it. Categories: developer-tools, productivity, business, " +
      "education, health-fitness, lifestyle, entertainment, utilities. Pass withdraw:true to take it out. " +
      "Omit everything but domainId to read the current listing.",
    inputSchema: {
      domainId: z.number().int(),
      title: z.string().max(60).optional(),
      tagline: z.string().max(140).optional(),
      description: z.string().max(1000).optional(),
      category: z.string().optional(),
      withdraw: z.boolean().optional(),
    },
  },
  async ({ domainId, title, tagline, description, category, withdraw }) =>
    run(() => {
      if (withdraw === true) {
        return client.request("DELETE", `/api/v1/domains/${domainId}/listing`);
      }
      if (title === undefined && tagline === undefined && description === undefined && category === undefined) {
        return client.request("GET", `/api/v1/domains/${domainId}/listing`);
      }
      return client.request("PUT", `/api/v1/domains/${domainId}/listing`, { title, tagline, description, category });
    }),
);

server.registerTool(
  "commit_workspace_version",
  {
    title: "Commit a version",
    description: "Snapshots the workspace's current content as a named version.",
    inputSchema: {
      workspaceId: z.number().int(),
      commitMessage: z.string().optional(),
      versionTag: z.string().optional(),
    },
  },
  async ({ workspaceId, commitMessage, versionTag }) =>
    run(() => client.request("POST", `/api/v1/workspaces/${workspaceId}/versions`, { commitMessage, versionTag })),
);

server.registerTool(
  "delete_workspace",
  {
    title: "Delete a workspace",
    description:
      "Permanently deletes a workspace and its content. Requires confirm=true — first call WITHOUT " +
      "confirm to preview, show the user, then call again with confirm:true.",
    inputSchema: {
      workspaceId: z.number().int(),
      confirm: z.boolean().optional().describe("Must be true to delete. Omit/false returns a preview only."),
    },
    annotations: { destructiveHint: true },
  },
  async ({ workspaceId, confirm }) => {
    if (confirm !== true) {
      return ok(`Preview — will permanently delete workspace ${workspaceId} and all its content.\nRe-run delete_workspace with confirm:true to proceed.`);
    }
    return run(async () => {
      await client.request("DELETE", `/api/v1/workspaces/${workspaceId}`);
      return `Deleted workspace ${workspaceId}.`;
    });
  },
);

server.registerTool(
  "list_endpoints",
  {
    title: "List a workspace's API endpoints",
    description:
      "Lists the HTTP endpoints currently deployed for a workspace's current version. includeArchived:true " +
      "adds `pathVersions` to each: every version of that path on its domain, including the disabled copies " +
      "each commit archives (ids, labels, isMain) — what blocks deleting a main endpoint. Domain owner only " +
      "(null otherwise).",
    inputSchema: {
      workspaceId: z.number().int(),
      includeArchived: z.boolean().optional().describe("Also list every version of each path (archived copies)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ workspaceId, includeArchived }) =>
    run(() => client.request("GET", `/api/v1/workspaces/${workspaceId}/endpoints${includeArchived ? "?includeArchived=true" : ""}`)),
);

server.registerTool(
  "toggle_endpoint",
  {
    title: "Enable/disable a deployed endpoint",
    description:
      "Flips a deployed endpoint's enabled/disabled state (list_endpoints shows the current " +
      "isEnabled). A disabled endpoint stops serving live traffic but keeps its configuration, " +
      "so toggling it back on restores it. Powerful: requires confirm=true — first call WITHOUT " +
      "confirm to preview, then again with confirm:true.",
    inputSchema: {
      endpointId: z.number().int().describe("The endpoint's id — from list_endpoints."),
      confirm: z.boolean().optional().describe("Must be true to toggle. Omit/false returns a preview only."),
    },
    annotations: { destructiveHint: true },
  },
  async ({ endpointId, confirm }) => toggleEndpoint(client, endpointId, confirm),
);

server.registerTool(
  "update_endpoint",
  {
    title: "Update a deployed endpoint's config",
    description:
      "Updates a deployed endpoint's config in place — isMain, isEnabled, allowedVerbs, " +
      "detailedOutput, isAnonymous, authMode, requiredScopes and/or notes — without a full redeploy. Only the fields you " +
      "pass are changed; omit the rest. authMode decides who may call it: anonymous, apiKey, user (a visitor signed in " +
      "to the site), jwt (a token from one of the domain's API clients — create_domain_client — or a trusted issuer — " +
      "set_trusted_issuer), apiKeyOrJwt. Powerful (can change security posture, e.g. isAnonymous, " +
      "or take live traffic down via allowedVerbs/isEnabled): requires confirm=true — first call " +
      "WITHOUT confirm to preview the exact changes, then again with confirm:true.",
    inputSchema: {
      endpointId: z.number().int().describe("The endpoint's id — from list_endpoints."),
      isMain: z.boolean().optional().describe("Make this the main version for its path."),
      isEnabled: z.boolean().optional().describe("Enable/disable — same effect as toggle_endpoint but to a specific state."),
      allowedVerbs: z.array(z.string()).optional(),
      detailedOutput: z.boolean().optional(),
      isAnonymous: z.boolean().optional(),
      notes: z.string().optional(),
      authMode: z
        .enum(["anonymous", "apiKey", "user", "jwt", "apiKeyOrJwt"])
        .optional()
        .describe("Who may call it. Wins over isAnonymous when both are sent."),
      requiredScopes: z
        .string()
        .optional()
        .describe('Space-separated scopes a jwt / apiKeyOrJwt token must ALL carry, e.g. "orders:read". "" clears.'),
      confirm: z.boolean().optional().describe("Must be true to apply. Omit/false returns a preview only."),
    },
    annotations: { destructiveHint: true },
  },
  async ({ endpointId, isMain, isEnabled, allowedVerbs, detailedOutput, isAnonymous, notes, authMode, requiredScopes, confirm }) =>
    updateEndpoint(
      client,
      endpointId,
      { isMain, isEnabled, allowedVerbs, detailedOutput, isAnonymous, notes, authMode, requiredScopes },
      confirm,
    ),
);

server.registerTool(
  "delete_endpoint",
  {
    title: "Delete (un-deploy) an endpoint",
    description:
      "Permanently un-deploys an endpoint — its URL stops resolving and its configuration is " +
      "removed (unlike toggle_endpoint, this cannot be undone by re-enabling it; deploy_endpoint " +
      "would be needed to publish it again). Requires confirm=true — first call WITHOUT confirm " +
      "to preview, then again with confirm:true. A MAIN endpoint whose path still has other versions " +
      "(the archived, disabled copies each commit leaves — list_endpoints includeArchived shows them) is " +
      "refused unless withArchived:true, which removes the whole path on that domain in one call " +
      "(domain owner only). That is how a site moves to another domain: delete withArchived, redeploy.",
    inputSchema: {
      endpointId: z.number().int().describe("The endpoint's id — from list_endpoints."),
      withArchived: z.boolean().optional().describe("Also delete every other version of this path on its domain."),
      confirm: z.boolean().optional().describe("Must be true to delete. Omit/false returns a preview only."),
    },
    annotations: { destructiveHint: true },
  },
  async ({ endpointId, confirm, withArchived }) => deleteEndpoint(client, endpointId, confirm, withArchived),
);

server.registerTool(
  "list_domains",
  {
    title: "List your API domains",
    description:
      "Lists the API domains you can deploy endpoints into (id, name, slug, baseUrl). Use the " +
      "returned id as deploy_endpoint's domainId. Pass workspaceId to list the domains usable for a " +
      "specific workspace (e.g. a shared one — the owner's domains). If empty, create one with " +
      "create_domain — no UI step needed.",
    inputSchema: {
      query: z.string().optional().describe("Filter domains by name/slug."),
      workspaceId: z.number().int().optional().describe("List domains deployable for this workspace (its owner's)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, workspaceId }) => run(() => client.request("GET", `/api/v1/domains${qs({ query, workspaceId })}`)),
);

server.registerTool(
  "create_domain",
  {
    title: "Create an API domain",
    description:
      "Creates an API domain — the namespace your deployed endpoints live under. Its slug becomes " +
      "the first path segment of every endpoint in it: https://api.qu4zr.io/{slug}/{path} — and, where " +
      "site hosts are enabled, the HOSTNAME a site is served at (https://{slug}.{zone}/), so it is a " +
      "public, permanent, brandable name and not an internal id. The reply carries the domain's baseUrl; " +
      "use that as the canonical base for its pages rather than assembling a URL. Do this " +
      "BEFORE deploy_endpoint, then pass the returned id as deploy_endpoint's domainId. The slug is " +
      "GLOBALLY unique across all users and is effectively permanent once endpoints are deployed and " +
      "callers depend on the URL, so it requires confirm=true — call without confirm first to " +
      "preview, and let the user pick the slug rather than choosing a memorable one yourself. " +
      "Omit slug to derive it from name.",
    inputSchema: {
      name: z.string().min(1).describe('Display name, e.g. "Orders API".'),
      slug: z.string().optional().describe('URL segment, e.g. "orders-api". Globally unique. Defaults to name.'),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      confirm: z.boolean().optional().describe("Must be true to create. Omit/false returns a preview only."),
    },
  },
  async ({ name, slug, description, tags, confirm }) =>
    createDomain(client, { name, slug, description, tags }, confirm),
);

server.registerTool(
  "list_domain_api_keys",
  {
    title: "List a domain's API keys",
    description:
      "Lists the API keys on a domain (id, name, MASKED key, createdAt, expiresAt, isActive, " +
      "lastUsedAt) — the plaintext key is never shown here, only at create/rotate time. Use " +
      "create_domain_api_key to get one a caller can actually use against a non-anonymous endpoint.",
    inputSchema: { domainId: z.number().int().describe("The domain's id — from list_domains.") },
    annotations: { readOnlyHint: true },
  },
  async ({ domainId }) => listDomainApiKeys(client, domainId),
);

server.registerTool(
  "create_domain_api_key",
  {
    title: "Create a domain API key",
    description:
      "Mints a new API key on a domain — the credential callers pass as Authorization: Bearer " +
      "<key> (or ?code=<key>) to call a non-anonymous endpoint deployed in that domain. The " +
      "response's plaintext apiKey is shown EXACTLY ONCE and can never be retrieved again — " +
      "surface it to the user immediately and tell them to copy it now. Powerful: requires " +
      "confirm=true — first call WITHOUT confirm to preview, then again with confirm:true.",
    inputSchema: {
      domainId: z.number().int().describe("The domain's id — from list_domains."),
      name: z.string().optional().describe("Human-readable label for the key."),
      expiresAt: z.string().optional().describe("ISO 8601 expiry, e.g. \"2026-12-31T00:00:00Z\". Omit for no expiry."),
      confirm: z.boolean().optional().describe("Must be true to create. Omit/false returns a preview only."),
    },
    annotations: { destructiveHint: true },
  },
  async ({ domainId, name, expiresAt, confirm }) => createDomainApiKey(client, domainId, { name, expiresAt }, confirm),
);

server.registerTool(
  "update_domain_api_key",
  {
    title: "Update a domain API key",
    description:
      "Updates a domain API key's name, active state, and/or expiry in place — never changes the " +
      "key value itself (use rotate_domain_api_key for that). Only the fields you pass are changed. " +
      "Requires confirm=true — first call WITHOUT confirm to preview the exact changes, then again " +
      "with confirm:true.",
    inputSchema: {
      domainId: z.number().int().describe("The domain's id — from list_domains."),
      keyId: z.number().int().describe("The key's id — from list_domain_api_keys."),
      name: z.string().optional(),
      isActive: z.boolean().optional().describe("Deactivate (false) or reactivate (true) the key without deleting it."),
      expiresAt: z.string().optional().describe("ISO 8601 expiry."),
      confirm: z.boolean().optional().describe("Must be true to apply. Omit/false returns a preview only."),
    },
    annotations: { destructiveHint: true },
  },
  async ({ domainId, keyId, name, isActive, expiresAt, confirm }) =>
    updateDomainApiKey(client, domainId, keyId, { name, isActive, expiresAt }, confirm),
);

server.registerTool(
  "delete_domain_api_key",
  {
    title: "Delete a domain API key",
    description:
      "Permanently deletes a domain API key — any caller using it starts getting 401s immediately. " +
      "This cannot be undone (unlike update_domain_api_key's isActive:false, which is reversible). " +
      "Requires confirm=true — first call WITHOUT confirm to preview, then again with confirm:true.",
    inputSchema: {
      domainId: z.number().int().describe("The domain's id — from list_domains."),
      keyId: z.number().int().describe("The key's id — from list_domain_api_keys."),
      confirm: z.boolean().optional().describe("Must be true to delete. Omit/false returns a preview only."),
    },
    annotations: { destructiveHint: true },
  },
  async ({ domainId, keyId, confirm }) => deleteDomainApiKey(client, domainId, keyId, confirm),
);

server.registerTool(
  "rotate_domain_api_key",
  {
    title: "Rotate a domain API key",
    description:
      "Issues a brand-new key value for an existing domain API key slot and retires the old value — " +
      "use this for a compromised or routinely-expiring key without having to update every caller's " +
      "key id. By default the old key is deactivated immediately; pass keepOldKeyActive:true (with an " +
      "optional gracePeriodMinutes) to let both work for a transition window. The response's new " +
      "plaintext apiKey is shown EXACTLY ONCE — surface it to the user immediately. Requires " +
      "confirm=true — first call WITHOUT confirm to preview, then again with confirm:true.",
    inputSchema: {
      domainId: z.number().int().describe("The domain's id — from list_domains."),
      keyId: z.number().int().describe("The key's id — from list_domain_api_keys."),
      keepOldKeyActive: z.boolean().optional().describe("Keep the old key working for a grace period instead of deactivating it immediately."),
      gracePeriodMinutes: z.number().int().optional().describe("How long the old key stays active when keepOldKeyActive is true."),
      confirm: z.boolean().optional().describe("Must be true to rotate. Omit/false returns a preview only."),
    },
    annotations: { destructiveHint: true },
  },
  async ({ domainId, keyId, keepOldKeyActive, gracePeriodMinutes, confirm }) =>
    rotateDomainApiKey(client, domainId, keyId, { keepOldKeyActive, gracePeriodMinutes }, confirm),
);

const domainIdArg = z.number().int().describe("The domain's id — from list_domains.");
const clientIdArg = z.string().describe('The client\'s id ("dcl_…") — from list_domain_clients.');
const issuerName = z.string().describe('The issuer\'s name on this domain, e.g. "auth0" — lowercase letters, digits, hyphens.');
const confirmArg = z.boolean().optional().describe("Must be true to act. Omit/false returns a preview only.");

server.registerTool(
  "list_domain_clients",
  {
    title: "List a domain's API clients",
    description:
      "Lists the API clients of a domain — machine callers that exchange a client id + secret for a short-lived " +
      "token (OAuth 2 client_credentials) accepted by the domain's jwt / apiKeyOrJwt endpoints — with the token URL, " +
      "the JWKS and discovery URLs, the limits and the signing keys. Never a secret.",
    inputSchema: { domainId: domainIdArg },
    annotations: { readOnlyHint: true },
  },
  async ({ domainId }) => listDomainClients(client, domainId),
);

server.registerTool(
  "create_domain_client",
  {
    title: "Create a domain API client",
    description:
      "Creates an API client on a domain. The reply's clientSecret is shown EXACTLY ONCE — surface it to the user " +
      "immediately — with the token URL and a ready-to-run curl. A caller then POSTs grant_type=client_credentials " +
      "to that URL and sends the token as Authorization: Bearer <token> to an endpoint whose authMode is jwt or " +
      "apiKeyOrJwt (update_endpoint). Requires confirm=true — call WITHOUT confirm first to preview.",
    inputSchema: {
      domainId: domainIdArg,
      name: z.string().optional().describe("What the client is, e.g. \"Billing worker\"."),
      scopes: z.string().optional().describe('Space-separated scopes it may be granted, e.g. "orders:read orders:write".'),
      tokenLifetimeMinutes: z.number().int().optional().describe("How long its tokens last. Omit for the default."),
      rateLimitPerMinute: z
        .number()
        .int()
        .optional()
        .describe(
          "Its own gateway allowance in requests per minute (1-6000). Every client of a site calls as the site's owner " +
            "and shares one platform limit, so this keeps one of them from spending the others' share; past it the " +
            "client gets 429 CLIENT_RATE_LIMIT for the rest of the minute. Omit for none.",
        ),
      confirm: confirmArg,
    },
    annotations: { destructiveHint: true },
  },
  async ({ domainId, name, scopes, tokenLifetimeMinutes, rateLimitPerMinute, confirm }) =>
    createDomainClient(client, domainId, { name, scopes, tokenLifetimeMinutes, rateLimitPerMinute }, confirm),
);

server.registerTool(
  "update_domain_client",
  {
    title: "Update a domain API client",
    description:
      "Changes a client's name, scopes, token lifetime, rate limit or active state. active:false refuses its tokens from the next " +
      "request and is reversible. Never changes the secret (rotate_domain_client_secret). Requires confirm=true.",
    inputSchema: {
      domainId: domainIdArg,
      clientId: clientIdArg,
      name: z.string().optional(),
      scopes: z.string().optional().describe("Space-separated; replaces the list."),
      tokenLifetimeMinutes: z.number().int().optional(),
      rateLimitPerMinute: z
        .number()
        .int()
        .optional()
        .describe(
          "Its own gateway allowance in requests per minute (1-6000). Every client of a site calls as the site's owner " +
            "and shares one platform limit, so this keeps one of them from spending the others' share; past it the " +
            "client gets 429 CLIENT_RATE_LIMIT for the rest of the minute. Omit to keep it; 0 removes it.",
        ),
      active: z.boolean().optional(),
      confirm: confirmArg,
    },
    annotations: { destructiveHint: true },
  },
  async ({ domainId, clientId, name, scopes, tokenLifetimeMinutes, rateLimitPerMinute, active, confirm }) =>
    updateDomainClient(client, domainId, clientId, { name, scopes, tokenLifetimeMinutes, rateLimitPerMinute, active }, confirm),
);

server.registerTool(
  "rotate_domain_client_secret",
  {
    title: "Give a domain API client a new secret",
    description:
      "Issues a new secret; the old one and every token it bought stop working at once. The new clientSecret is shown " +
      "EXACTLY ONCE. For a leaked secret. Requires confirm=true.",
    inputSchema: { domainId: domainIdArg, clientId: clientIdArg, confirm: confirmArg },
    annotations: { destructiveHint: true },
  },
  async ({ domainId, clientId, confirm }) => rotateDomainClientSecret(client, domainId, clientId, confirm),
);

server.registerTool(
  "revoke_domain_client_tokens",
  {
    title: "Revoke a domain API client's tokens",
    description:
      "Refuses every token issued so far to a client, from the next request. The secret keeps working. Requires confirm=true.",
    inputSchema: { domainId: domainIdArg, clientId: clientIdArg, confirm: confirmArg },
    annotations: { destructiveHint: true },
  },
  async ({ domainId, clientId, confirm }) => revokeDomainClientTokens(client, domainId, clientId, confirm),
);

server.registerTool(
  "delete_domain_client",
  {
    title: "Delete a domain API client",
    description:
      "Permanently deletes a client; its tokens are refused from the next request. update_domain_client active:false is " +
      "the reversible way. Requires confirm=true.",
    inputSchema: { domainId: domainIdArg, clientId: clientIdArg, confirm: confirmArg },
    annotations: { destructiveHint: true },
  },
  async ({ domainId, clientId, confirm }) => deleteDomainClient(client, domainId, clientId, confirm),
);

server.registerTool(
  "rotate_domain_signing_key",
  {
    title: "Rotate a domain's token signing key",
    description:
      "Creates a new key for signing the domain's tokens. The previous key keeps verifying until the tokens it signed " +
      "expire, so nothing valid is cut off. For a key believed stolen: rotate, then revoke each client's tokens. " +
      "Requires confirm=true.",
    inputSchema: { domainId: domainIdArg, confirm: confirmArg },
    annotations: { destructiveHint: true },
  },
  async ({ domainId, confirm }) => rotateDomainSigningKey(client, domainId, confirm),
);

server.registerTool(
  "list_trusted_issuers",
  {
    title: "List a domain's trusted issuers",
    description:
      "Lists the external identity providers (Auth0, Okta, Entra, Cognito, Firebase, Keycloak…) whose tokens the " +
      "domain's jwt / apiKeyOrJwt endpoints accept, with the accepted scope claims and algorithms.",
    inputSchema: { domainId: domainIdArg },
    annotations: { readOnlyHint: true },
  },
  async ({ domainId }) => listTrustedIssuers(client, domainId),
);

server.registerTool(
  "set_trusted_issuer",
  {
    title: "Trust an external token issuer",
    description:
      "Makes the domain's jwt / apiKeyOrJwt endpoints accept tokens from an identity provider, or replaces the issuer " +
      "of that name. issuer must be the exact iss the provider puts in tokens (Auth0's ends with \"/\", Entra's does " +
      "not). audience is REQUIRED — the provider signs every app's tokens with the same keys. kind \"jwks\" (default) " +
      "verifies RS/PS/ES against published keys; kind \"hs256\" verifies HS256 against a shared secret (Supabase's " +
      "JWT secret, aud \"authenticated\") passed as secret — write-only, omit it to keep the stored one. The block " +
      "then sees request.auth.issuer (the name) and request.auth.subject. Check it with check_trusted_issuer. " +
      "Requires confirm=true.",
    inputSchema: {
      domainId: domainIdArg,
      name: issuerName,
      issuer: z.string().describe('The issuer URL, exactly as the token\'s iss, e.g. "https://tenant.eu.auth0.com/".'),
      audience: z.string().describe("The value the provider puts in aud for this API."),
      jwksUri: z.string().optional().describe("Omit to find the keys through the issuer's discovery document."),
      scopeClaim: z
        .enum(["scope", "scp", "permissions", "roles"])
        .optional()
        .describe("Where the provider puts permissions: scope (default), scp (Entra, Okta), permissions (Auth0 RBAC), roles."),
      enabled: z.boolean().optional().describe("false keeps the configuration but refuses its tokens."),
      kind: z
        .enum(["jwks", "hs256"])
        .optional()
        .describe('"jwks" (published public keys, default) or "hs256" (a shared secret). Omit to keep an existing issuer\'s kind.'),
      secret: z
        .string()
        .optional()
        .describe("hs256 only: the shared secret tokens are signed with, at least 32 bytes. Never returned. Omit to keep the stored one."),
      confirm: confirmArg,
    },
    annotations: { destructiveHint: true },
  },
  async ({ domainId, name, issuer, audience, jwksUri, scopeClaim, enabled, kind, secret, confirm }) =>
    setTrustedIssuer(client, domainId, name, { issuer, audience, jwksUri, scopeClaim, enabled, kind, secret }, confirm),
);

server.registerTool(
  "delete_trusted_issuer",
  {
    title: "Stop trusting an external token issuer",
    description: "Removes a trusted issuer; its tokens are refused from the next request. Requires confirm=true.",
    inputSchema: { domainId: domainIdArg, name: issuerName, confirm: confirmArg },
    annotations: { destructiveHint: true },
  },
  async ({ domainId, name, confirm }) => deleteTrustedIssuer(client, domainId, name, confirm),
);

server.registerTool(
  "check_trusted_issuer",
  {
    title: "Check a trusted issuer or one of its tokens",
    description:
      "Without a token: fetches the issuer's keys now and says whether it is reachable and how many usable keys it " +
      "publishes. With a token: runs it through exactly the gateway's check and says which check fails " +
      "(token.audience_mismatch, token.expired…) or what a block would see as request.auth. The caller of an endpoint " +
      "is only ever told invalid_token; this is where the reason is.",
    inputSchema: {
      domainId: domainIdArg,
      name: issuerName,
      token: z.string().optional().describe("A token from the provider (a leading \"Bearer \" is fine)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ domainId, name, token }) => checkTrustedIssuer(client, domainId, name, token),
);

server.registerTool(
  "deploy_endpoint",
  {
    title: "Deploy a block as an HTTP endpoint",
    description:
      "Publishes a workspace's block as a live HTTP API endpoint — or a page of a site — in the " +
      "given domain. Powerful: requires confirm=true — first call WITHOUT confirm to preview, then " +
      "again with confirm:true. Anything meant to be publicly reachable needs isAnonymous:true.\n\n" +
      'An endpoint serves the workspace AUTO-SAVE — the canvas, live — under the version label "head". ' +
      "Editing a block changes what the URL answers immediately: no redeploy, and committing does " +
      "not freeze it. That is the OPPOSITE of create_schedule, which pins a committed version and " +
      "keeps running it, so one block can serve new code over HTTP while a cron on the same block " +
      'still runs the old one. Name which of the two you mean whenever a user asks why a change "did ' +
      'not take". (commit_workspace_version does archive a copy of each deployed path at its own ' +
      "version label, but those copies are created disabled — nothing changes at the live URL.)",
    inputSchema: {
      workspaceId: z.number().int(),
      blockId: z.number().int(),
      domainId: z.number().int().describe("Target API domain id — call list_domains to find it (owned by the workspace owner)."),
      path: z
        .string()
        .describe(
          'Endpoint path, e.g. "orders". A path may be a FILE NAME ("index.html", "sitemap.xml"), and ' +
            '"/" deploys at the domain ROOT — https://api.qu4zr.io/{slug}/ — which is where a site\'s home ' +
            'page belongs. Avoid a first folder that looks like a version label ("v1", "latest", "dev"…): ' +
            "the gateway reads that segment as a version, not a folder.",
        ),
      allowedVerbs: z.array(z.string()).optional(),
      detailedOutput: z.boolean().optional(),
      isAnonymous: z.boolean().optional(),
      notes: z.string().optional(),
      confirm: z.boolean().optional().describe("Must be true to deploy. Omit/false returns a preview only."),
    },
    annotations: { destructiveHint: true },
  },
  async ({ workspaceId, blockId, domainId, path, allowedVerbs, detailedOutput, isAnonymous, notes, confirm }) => {
    if (confirm !== true) {
      return ok(
        `Preview — will deploy block ${blockId} of workspace ${workspaceId} as endpoint "${path}" in domain ${domainId}` +
          `${allowedVerbs ? ` (verbs: ${allowedVerbs.join(", ")})` : ""}.\n` +
          `Re-run deploy_endpoint with confirm:true to proceed.`,
      );
    }
    return run(() =>
      client.request("POST", `/api/v1/workspaces/${workspaceId}/blocks/${blockId}/endpoint`, {
        domainId,
        path,
        allowedVerbs,
        detailedOutput,
        isAnonymous,
        notes,
      }),
    );
  },
);

server.registerTool(
  "call_endpoint",
  {
    title: "Call a deployed endpoint for real",
    description:
      "Makes a REAL HTTP request to a deployed endpoint — the same request a browser or a customer " +
      "makes — and reports the status, content type and body. This is the ONLY check that goes " +
      "through the live URL: the deployment, the path, the allowed verbs and the API key are all " +
      "exercised, and none of them are visible to test_block or execute_workspace, which talk to " +
      "the sandbox directly. Run it as the last step of anything with a URL in it, and FIRST when a " +
      "page's own calls are failing: a 404 here means nothing is deployed at that path (setting " +
      "endpointPath on a block publishes nothing — deploy_endpoint does), while a 500 means the " +
      "block behind it threw. Name the domain and the path; the URL is built from that domain's own " +
      "baseUrl, so there is no address to pass and no way to test a URL that is not the one your " +
      "users were given. The request really runs the block and counts as one API call.",
    inputSchema: {
      domainId: z.number().int().describe("The domain's id — from list_domains."),
      path: z.string().describe('The deployed path, e.g. "api/orders". Empty string is the domain root.'),
      method: z.string().optional().describe("GET (default), POST, PUT, PATCH, DELETE or HEAD."),
      headers: z.record(z.string(), z.string()).optional(),
      query: z.record(z.string(), z.string()).optional(),
      body: z.string().optional().describe("Raw body, as a string. Sent as application/json unless you set a Content-Type header."),
      apiKey: z
        .string()
        .optional()
        .describe("Only for an endpoint deployed with isAnonymous:false — mint one with create_domain_api_key. Sent as a bearer token."),
    },
    annotations: { destructiveHint: true },
  },
  async ({ domainId, path, method, headers, query, body, apiKey }) =>
    callEndpoint(client, { domainId, path, method, headers, query, body, apiKey }),
);

server.registerTool(
  "execute_workspace",
  {
    title: "Run a workspace's block",
    description:
      "Executes a workspace starting at the given block (server-side). Powerful: requires confirm=true — " +
      "first call WITHOUT confirm to preview, then again with confirm:true.",
    inputSchema: {
      workspaceId: z.number().int(),
      blockId: z.number().int(),
      confirm: z.boolean().optional().describe("Must be true to execute. Omit/false returns a preview only."),
    },
    annotations: { destructiveHint: true },
  },
  async ({ workspaceId, blockId, confirm }) => {
    if (confirm !== true) {
      return ok(`Preview — will execute workspace ${workspaceId} starting at block ${blockId}.\nRe-run with confirm:true to proceed.`);
    }
    return run(() => client.request("POST", `/api/v1/workspaces/${workspaceId}/execute`, { blockId }));
  },
);

server.registerTool(
  "test_block",
  {
    title: "Dry-run a block with sample input",
    description:
      "Runs ONE saved block in isolation with sample input (the rest of the flow does NOT run) and " +
      "returns its output — or, on error, a 400 whose `details` carry the JS/sandbox error. Use it to " +
      "test a Process block and self-correct BEFORE deploying. `input` is the upstream value the block " +
      "reads as `input`; `request` simulates an API Endpoint flow's `request` global. The block's code " +
      "really runs (may make HTTP/SQL calls), so it needs flows:execute. Save the block first " +
      "(set_workspace_content), then test by its blockId. " +
      "PASS dryRun:true WHILE ITERATING: the block still runs on the real engine, but fetch and " +
      "sql.query are answered from stubs and reach NOTHING — no third-party API calls burned, no " +
      "writes to a real database. The reply's `dryRun` report lists every URL and query the block " +
      "would have hit, which is also how you discover what it actually talks to. Supply " +
      "dryRunHttp/dryRunSql to control the canned answers; unstubbed calls get an empty 200 / no " +
      "rows. Drop dryRun for a final real test before deploying. The reply carries a `usage` block " +
      "(statements, limitStatements, durationMs, fetches, storeOps) — SIZE YOUR BATCHES FROM IT " +
      "instead of guessing: if a run uses a small fraction of the statement budget, do more work per " +
      "call rather than paying for extra round-trips.",
    inputSchema: {
      workspaceId: z.number().int(),
      blockId: z.number().int(),
      input: z.any().optional().describe("Sample upstream output the block reads as `input`."),
      request: z
        .object({
          method: z.string().optional(),
          headers: z.record(z.string(), z.string()).optional(),
          query: z.record(z.string(), z.string()).optional(),
          body: z.string().optional(),
          params: z.record(z.string(), z.string()).optional(),
        })
        .optional()
        .describe("Simulate an API Endpoint flow's `request` global (method/headers/query/body/params)."),
      dryRun: z
        .boolean()
        .optional()
        .describe("Run on the real engine but stub fetch/sql so nothing outside is reached. Use while iterating."),
      dryRunHttp: z
        .array(z.object({
          urlContains: z.string().optional().describe("Match when the URL contains this. Omit to match any request."),
          status: z.number().int().optional(),
          body: z.string().optional().describe("Response body, verbatim (usually JSON text)."),
        }).strict())
        .optional()
        .describe("Canned HTTP replies, first match wins. Implies dryRun:true."),
      dryRunSql: z
        .array(z.object({
          queryContains: z.string().optional().describe("Match when the SQL contains this. Omit to match any query."),
          rowsJson: z.string().optional().describe('Rows as a JSON array, e.g. [{"id":1}]. Omit for no rows.'),
        }).strict())
        .optional()
        .describe("Canned SQL results, first match wins. Implies dryRun:true."),
    },
  },
  async ({ workspaceId, blockId, input, request, dryRun, dryRunHttp, dryRunSql }) => {
    const stubs = dryRunHttp || dryRunSql ? { http: dryRunHttp, sql: dryRunSql } : undefined;
    return run(() =>
      client.request("POST", `/api/v1/workspaces/${workspaceId}/blocks/${blockId}/test`, {
        input,
        request,
        dryRun: dryRun === true || stubs !== undefined ? true : undefined,
        dryRunOptions: stubs,
      }),
    );
  },
);

server.registerTool(
  "test_runner_handler",
  {
    title: "Test an on-prem handler on the user's runner",
    description:
      "Pushes a SignalR (on-prem) block's C# handler + sample input to the user's runner — which must be " +
      "running in TEST MODE (`dotnet run -- --test`) — and returns its output. The on-prem twin of " +
      "test_block: use it to iterate on a handler before the user bakes it into a download. signalRBlockId " +
      "is the block's guid (the signalRGuid from get_workspace_content). Omit handlerCode to run the saved " +
      "handler. Times out if the runner isn't in test mode — if so, tell the user to start it with --test.",
    inputSchema: {
      signalRBlockId: z.string().describe("The SignalR block's guid (its signalRGuid)."),
      handlerCode: z.string().optional().describe("C# handler to test now. Omit to run the block's saved handler."),
      input: z.any().optional().describe("Sample value the handler reads as `input`."),
    },
  },
  async ({ signalRBlockId, handlerCode, input }) =>
    run(() => client.request("POST", `/api/v1/runner/${signalRBlockId}/test`, { handlerCode, input })),
);

server.registerTool(
  "setup_runner",
  {
    title: "Set up + launch the on-prem runner on this machine",
    description:
      "Stands the on-prem runner up ON THIS MACHINE for a SignalR block, end-to-end: downloads the " +
      "ready-to-run project (the handler baked in), validates its integrity manifest, preserves " +
      "machine-local settings, writes it to ~/.qu4zr/runners/<id>/, builds it with `dotnet`, then " +
      "onboards + launches it in TEST MODE in the background. Failures identify integrity, local config, " +
      "SDK, generated plumbing, handler, or generic build stages. Once it's up, call " +
      "test_runner_handler to verify/iterate, then deploy_endpoint to publish. REQUIRES confirm:true — it " +
      "runs UNSANDBOXED AI-written C# on the user's machine. Needs the .NET SDK ('dotnet') installed. " +
      "Show the user Handler.cs (returned) so they can review what will run. " +
      "Pass installService:true to instead install it as an always-on OS service (survives reboots) — this " +
      "triggers an admin/UAC prompt the USER must approve; suggest it once the endpoint is verified + deployed.",
    inputSchema: {
      signalRBlockId: z.string().describe("The SignalR block's guid (its signalRGuid)."),
      confirm: z.boolean().optional().describe("Must be true: downloads, builds, and LAUNCHES unsandboxed C# on this machine."),
      run: z.boolean().optional().describe("Launch after building (default true). false = download + build only, then tell the user the command to run."),
      installService: z.boolean().optional().describe("Instead of a foreground launch, install the runner as an always-on OS service (admin/UAC prompt the user approves). Use for survive-reboot."),
    },
  },
  async ({ signalRBlockId, confirm, run: launch, installService }) =>
    run(async () => {
      if (!confirm) {
        return {
          needsConfirm: true,
          message:
            "setup_runner downloads, BUILDS, and LAUNCHES the on-prem runner (unsandboxed C# baked from " +
            "this block's handler) on the user's machine. Confirm with the user, then re-run with confirm:true.",
        };
      }

      // 1. Download the ready-to-run project (path -> content).
      const pkg = (await client.request(
        "GET",
        `/api/v1/runner/${signalRBlockId}/download`,
      )) as DownloadedRunnerPackage;
      let manifest;
      try {
        manifest = validateRunnerPackage(pkg);
      } catch (error) {
        const integrity = error instanceof RunnerPackageIntegrityError ? error : undefined;
        return {
          ok: false,
          stage: "integrity",
          code: integrity?.code ?? (error as Error).message,
          // Without this the code alone ("unsupported") is undiagnosable from the client machine.
          detail: integrity?.detail,
          client: `qu4zr-mcp ${version}`,
          serverPackageVersion: pkg?.package?.version,
          supportedManifestSchemaVersions: SUPPORTED_MANIFEST_SCHEMA_VERSIONS,
          error: "The runner package failed integrity validation and was not written or executed.",
        };
      }

      // 2. Write it to a stable per-block folder on this machine.
      const dir = join(homedir(), ".qu4zr", "runners", signalRBlockId);
      const preparedFiles = new Map<string, string>();
      for (const [rel, originalContent] of Object.entries(pkg.files)) {
        let content = originalContent;
        if (rel.toLowerCase() === "appsettings.json") {
          const full = join(dir, rel);
          const existing = await readFile(full, "utf8").catch(() => undefined);
          try {
            content = mergeRunnerAppSettings(originalContent, existing);
          } catch (error) {
            return {
              ok: false,
              stage: "configuration",
              code: (error as Error).message,
              error: "The existing local runner configuration is invalid and was not overwritten.",
              path: full,
            };
          }
        }
        preparedFiles.set(rel, content);
      }
      for (const [rel, content] of preparedFiles) {
        const full = join(dir, rel);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content, "utf8");
      }
      const csproj = join(dir, `${pkg.projectName}.csproj`);
      const handlerPath = join(dir, "Handler.cs");
      const handler = await readFile(handlerPath, "utf8").catch(() => "");

      // 3. Build (so a bad handler surfaces here, not after launch).
      let runnerAssembly: string;
      try {
        await execFileAsync("dotnet", ["build", csproj, "--nologo", "-clp:ErrorsOnly"], {
          timeout: 300_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        const target = await execFileAsync("dotnet", ["msbuild", csproj, "-nologo", "-getProperty:TargetPath"], {
          cwd: dir,
          timeout: 30_000,
          windowsHide: true,
        });
        if (!target.stdout.trim()) throw new Error("Runner build returned no TargetPath.");
        runnerAssembly = resolve(dir, target.stdout.trim());
      } catch (e: unknown) {
        const err = e as { code?: string; stdout?: string; stderr?: string };
        const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim().slice(-4000);
        const failure = classifyRunnerBuildFailure(output, err.code === "ENOENT");
        return {
          ok: false,
          stage: "build",
          code: failure.code,
          error: failure.message,
          dir,
          handlerPath,
          packageVersion: manifest.packageVersion,
          output,
        };
      }

      if (launch === false && !installService) {
        return {
          ok: true,
          stage: "built",
          packageVersion: manifest.packageVersion,
          dir,
          handlerPath,
          handler,
          next: `Built. Have the user review Handler.cs, then run in ${dir}:  dotnet run -- --test`,
        };
      }

      // 4. Fresh onboarding code so the runner authenticates headlessly (service install + launch both need it).
      const onboard = (await client.request("POST", `/api/v1/runner/${signalRBlockId}/onboarding-code`)) as {
        code: string;
      };

      // 4b. Install as an always-on OS service instead of a foreground launch (survives reboots). The
      // elevation prompt (UAC on Windows / sudo on *nix) IS the user's approval for this machine change.
      if (installService) {
        if (process.platform === "win32") {
          const ps1 = join(dir, "install-service.ps1");
          spawn(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','RemoteSigned','-File','${ps1}','-OnboardCode','${onboard.code}'`,
            ],
            { detached: true, stdio: "ignore" },
          ).unref();
          return {
            ok: true,
            stage: "installing-service",
            packageVersion: manifest.packageVersion,
            dir,
            handler,
            next:
              "Windows is prompting the user to APPROVE installing the runner as a service (UAC). Once they " +
              "approve, it publishes + registers the service and the endpoint stays live across reboots. If no " +
              `prompt appeared, have them right-click install-service.ps1 in ${dir} and Run as administrator.`,
          };
        }
        return {
          ok: true,
          stage: "install-script",
          packageVersion: manifest.packageVersion,
          dir,
          handler,
          next: `To install the always-on service, have the user run (it will ask for their sudo password):  sudo bash '${join(dir, "install-service.sh")}' ${onboard.code}`,
        };
      }

      // 5. Run the assembly we just built. `dotnet run` would rebuild and supervise another
      // process, so the returned pid was the CLI wrapper rather than the actual runner.
      const logFile = join(dir, "runner.log");
      const started = await launchDetached("dotnet", [runnerAssembly, "--onboard", onboard.code, "--test"], {
        cwd: dir, logFile,
      });
      if (!started.ok) {
        return {
          ...started, stage: "launch", packageVersion: manifest.packageVersion,
          dir, handlerPath, logFile,
          error: "The runner did not stay running. Read runner.log for the startup diagnostics, then retry setup_runner.",
        };
      }

      return {
        ok: true,
        stage: "launched",
        packageVersion: manifest.packageVersion,
        dir,
        handlerPath,
        handler,
        pid: started.pid,
        logFile,
        next:
          "The runner process is running in test mode. Check list_runner_clients for its connection, then call " +
          "test_runner_handler to verify the output, iterate on the handler, and deploy_endpoint (confirm) to publish.",
      };
    }),
);

server.registerTool(
  "list_runner_devices",
  {
    title: "List enrolled runner devices",
    description: "Lists independently enrolled devices, with connected=true/false for live presence or null when the Executor is unavailable, plus revoked and last-connected state.",
    inputSchema: { signalRBlockId: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ signalRBlockId }) =>
    run(() => client.request("GET", `/api/v1/runner/${signalRBlockId}/devices`)),
);

server.registerTool(
  "list_runner_clients",
  {
    title: "List Developer and Consumer runner clients",
    description:
      "Lists the dashboard-owned Developer Runner separately from Consumer App Runners. " +
      "Use this instead of inferring runner kind from a missing or present device id.",
    inputSchema: { signalRBlockId: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ signalRBlockId }) =>
    run(() => client.request("GET", `/api/v1/runner/${signalRBlockId}/clients`)),
);

server.registerTool(
  "get_consumer_runner_download",
  {
    title: "Get the public Consumer App Runner download",
    description:
      "Returns the direct HTTPS .exe URL an application must show to its end users. The executable " +
      "contains no credential: downloading creates no device, and identity is created only after the " +
      "application authenticates the user and claims pairing. When building a consumer application, " +
      "put this URL in its UI and verify the artifact is available before calling the app complete. " +
      "If the reply carries unsignedWarning, that warning belongs on the page beside the link.",
    inputSchema: {
      signalRBlockId: z.string(),
      runtimeIdentifier: z.enum(["win-x64", "win-arm64"]).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ signalRBlockId, runtimeIdentifier }) => run(async () => {
    const runtime = runtimeIdentifier ?? "win-x64";
    const status = await client.request(
      "GET",
      `/api/v1/runner/${signalRBlockId}/consumer-artifact-status?runtimeIdentifier=${encodeURIComponent(runtime)}`,
    ) as { available?: boolean; signatureLevel?: string };
    return {
      ...status,
      runtimeIdentifier: runtime,
      downloadUrl: status.available
        ? `${publicUrl}/api/runner/download/${signalRBlockId}/windows?runtimeIdentifier=${encodeURIComponent(runtime)}`
        : null,
      blocker: status.available
        ? null
        : "No Consumer App Runner artifact is published for this block and platform, so there is no link to put in the page yet. " +
          "Call release_runner_handler (confirm:true) to build one from the block's current handler, then poll until it is published. " +
          "Do not show a dead download action and do not call the application complete before then.",
      // Emitted ONLY while the artifact is unsigned, and that is the point: the day signatureLevel
      // becomes `authenticode` this field stops appearing, so nothing has to remember to go and
      // delete a now-false warning from a grounding string. Pages built before then keep theirs,
      // which is also right — those users are still downloading the unsigned build.
      unsignedWarning: status.available && status.signatureLevel !== "authenticode"
        ? "This artifact is UNSIGNED. The first launch shows a full-screen blue \"Windows protected your PC\" " +
          "screen whose only continue button is hidden behind More info, and somebody who was not warned closes " +
          "the tab and blames the application. Put the warning next to the download link, in the page's own voice, " +
          "saying what they will see and what to click — for example: \"It is not code-signed yet, so Windows will " +
          "show 'Windows protected your PC'. Click More info, then Run anyway.\" " +
          "Never describe the file as verified, signed or safe."
        : null,
      onboarding: "Open the application pairing URL after launch; never ask the end user for a dashboard onboarding code.",
    };
  }),
);

server.registerTool(
  "release_runner_handler",
  {
    title: "Release this handler to the app's users",
    description:
      "Compiles the block's CURRENT handler into the executable its end users download, and makes " +
      "that the published installer. This is what gives a consumer application a working download " +
      "link: without a release there is no artifact and no link. The build runs out of process and " +
      "takes a few minutes — poll get_runner_release_status, or get_consumer_runner_download, until " +
      "it reports published. Requires confirm:true: it distributes an executable to other people.",
    inputSchema: {
      signalRBlockId: z.string(),
      runtimeIdentifier: z.enum(["win-x64", "win-arm64"]).optional(),
      consumerPairingUrl: z.string().optional(),
      confirm: z.boolean().optional(),
    },
    annotations: { destructiveHint: false },
  },
  async ({ signalRBlockId, runtimeIdentifier, consumerPairingUrl, confirm }) => {
    if (!confirm) return ok({ needsConfirm: true, signalRBlockId, runtimeIdentifier: runtimeIdentifier ?? "win-x64" });
    return run(() => client.request("POST", `/api/v1/runner/${signalRBlockId}/releases`, {
      runtimeIdentifier, consumerPairingUrl,
    }));
  },
);

server.registerTool(
  "get_runner_release_status",
  {
    title: "Check what the app's users are running",
    description:
      "Reports the published release, any build in flight, the last failure and whether the block's " +
      "handler has been edited since it was released (`drift`). A failed build reports the author's " +
      "own compiler error. `drift: null` means nothing has ever been released, which is not the same " +
      "as being up to date.",
    inputSchema: {
      signalRBlockId: z.string(),
      runtimeIdentifier: z.enum(["win-x64", "win-arm64"]).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ signalRBlockId, runtimeIdentifier }) =>
    run(() => client.request(
      "GET",
      `/api/v1/runner/${signalRBlockId}/releases?runtimeIdentifier=${encodeURIComponent(runtimeIdentifier ?? "win-x64")}`)),
);

server.registerTool(
  "get_runner_artifact_status",
  {
    title: "Check consumer runner artifact",
    description:
      "Checks whether an immutable consumer runner is published for a SignalR block and platform, " +
      "including its version and signature level. This does not build, publish, or download anything.",
    inputSchema: {
      signalRBlockId: z.string(),
      runtimeIdentifier: z.enum(["win-x64", "win-arm64", "osx-x64", "osx-arm64", "linux-x64", "linux-arm64"]).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ signalRBlockId, runtimeIdentifier }) =>
    run(() => client.request(
      "GET",
      `/api/v1/runner/${signalRBlockId}/consumer-artifact-status?runtimeIdentifier=${encodeURIComponent(runtimeIdentifier ?? "win-x64")}`,
    )),
);

server.registerTool(
  "claim_runner_pairing",
  {
    title: "Claim a consumer runner pairing",
    description:
      "Claims a short-lived pairingId created by a generic consumer runner and binds it to one SignalR block. " +
      "Use this for integration testing or an explicitly requested manual pairing. In production the application's " +
      "authenticated BACKEND must call the same Management API route after mapping its own user to the device; never " +
      "put the Management credential in browser code. The pairingId expires and is single-claim.",
    inputSchema: {
      signalRBlockId: z.string().describe("The SignalR block guid (signalRGuid)."),
      pairingId: z.string().describe("Opaque pairing id received by the application's HTTPS handoff page."),
      name: z.string().min(1).max(100).optional().describe("User-facing computer name."),
      confirm: z.boolean().optional().describe("Must be true because this creates a durable runner device."),
    },
    annotations: { destructiveHint: true },
  },
  async ({ signalRBlockId, pairingId, name, confirm }) => {
    if (!confirm) return ok({ needsConfirm: true, signalRBlockId, pairingId });
    return run(() =>
      client.request("POST", `/api/v1/runner/${signalRBlockId}/pairings/${pairingId}/claim`, {
        name: name ?? "My computer",
      }),
    );
  },
);

server.registerTool(
  "execute_runner_device",
  {
    title: "Execute on one enrolled runner device",
    description:
      "Targets exactly one device. The application backend must resolve deviceId from its authenticated user mapping; " +
      "never accept an arbitrary browser-supplied device id as authorization.",
    inputSchema: { signalRBlockId: z.string(), deviceId: z.string(), input: z.any().optional() },
  },
  async ({ signalRBlockId, deviceId, input }) =>
    run(() => client.request("POST", `/api/v1/runner/${signalRBlockId}/devices/${deviceId}/execute`, { input })),
);

server.registerTool(
  "rename_runner_device",
  {
    title: "Rename one runner device",
    description: "Changes the owner-visible name of one enrolled device without changing its identity, credentials, or connection.",
    inputSchema: {
      signalRBlockId: z.string(),
      deviceId: z.string(),
      name: z.string().trim().min(1).max(100),
    },
  },
  async ({ signalRBlockId, deviceId, name }) =>
    run(() => client.request("PATCH", `/api/v1/runner/${signalRBlockId}/devices/${deviceId}`, { name })),
);

server.registerTool(
  "revoke_runner_device",
  {
    title: "Revoke one runner device",
    description: "Revokes only the selected device. Requires confirm:true and does not affect other users' runners.",
    inputSchema: { signalRBlockId: z.string(), deviceId: z.string(), confirm: z.boolean().optional() },
  },
  async ({ signalRBlockId, deviceId, confirm }) => {
    if (!confirm) return ok({ needsConfirm: true, signalRBlockId, deviceId });
    return run(() => client.request("DELETE", `/api/v1/runner/${signalRBlockId}/devices/${deviceId}`));
  },
);

server.registerTool(
  "revoke_all_consumer_runners",
  {
    title: "Revoke every Consumer App Runner",
    description:
      "Revokes and disconnects every Consumer App Runner enrolled on the block. The Developer Runner " +
      "is deliberately unaffected. Requires confirm:true.",
    inputSchema: { signalRBlockId: z.string(), confirm: z.boolean().optional() },
    annotations: { destructiveHint: true },
  },
  async ({ signalRBlockId, confirm }) => {
    if (!confirm) return ok({ needsConfirm: true, signalRBlockId });
    return run(() => client.request("DELETE", `/api/v1/runner/${signalRBlockId}/devices`));
  },
);

server.registerTool(
  "revoke_developer_runner",
  {
    title: "Revoke the Developer Runner",
    description:
      "Revokes the dashboard-owned Developer Runner and disconnects it immediately. Consumer App Runners " +
      "are deliberately unaffected. Requires confirm:true.",
    inputSchema: { signalRBlockId: z.string(), confirm: z.boolean().optional() },
    annotations: { destructiveHint: true },
  },
  async ({ signalRBlockId, confirm }) => {
    if (!confirm) return ok({ needsConfirm: true, signalRBlockId });
    return run(() => client.request("DELETE", `/api/v1/runner/${signalRBlockId}/developer`));
  },
);

server.registerTool(
  "get_logs",
  {
    title: "Read a block's execution logs",
    description:
      "Returns recent execution (call) logs for a block in a workspace. Each entry carries a `usage` " +
      "block (statements, durationMs, fetches, storeOps) for the execution it belongs to — so you " +
      "can see what a real gateway hit cost, not just your own test runs, and size batching from " +
      "production behaviour. Entries logged before usage tracking existed simply have no `usage`.",
    inputSchema: {
      workspaceId: z.number().int(),
      blockId: z.number().int(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ workspaceId, blockId, limit }) =>
    run(() => client.request("GET", `/api/v1/workspaces/${workspaceId}/blocks/${blockId}/logs${qs({ limit })}`)),
);

return server;
}

// ---- Start ------------------------------------------------------------------

async function main() {
  if (remote) {
    await serveHttp({ buildServer, baseUrl, version });
    return;
  }

  const transport = new StdioServerTransport();
  await buildServer().connect(transport);

  // Prove the credentials before claiming to be ready. The token used to be fetched lazily, on the
  // first tool call, so a wrong secret still printed "ready", the client still showed the server
  // connected, and the only symptom was a tool failing several turns into a conversation — which
  // reads as a broken tool, not as a config error. A rejected secret is fatal here; a network that
  // is not up yet is not, because a client may well launch this before the machine has a route.
  try {
    const identity = await client.verify();
    const granted = identity.scopes.length ? identity.scopes.join(" ") : scopes.join(" ");
    console.error(`qu4zr-mcp ${version} ready → ${baseUrl} (authenticated; scopes: ${granted})`);
  } catch (err) {
    if (err instanceof Qu4zrError && err.kind === "auth") {
      console.error(`qu4zr-mcp: ${err.message}\n\nRun 'qu4zr-mcp doctor' for the full picture.`);
      process.exit(1);
    }
    console.error(
      `qu4zr-mcp ${version} started → ${baseUrl}, but could not reach it yet:\n` +
        `${(err as Error).message}\n` +
        "Serving anyway — the next tool call retries. Run 'qu4zr-mcp doctor' to diagnose it.",
    );
  }
}

main().catch((err) => {
  console.error("qu4zr-mcp fatal:", err);
  process.exit(1);
});
