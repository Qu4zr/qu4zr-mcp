# qu4zr-mcp

An [MCP](https://modelcontextprotocol.io) server that lets your AI assistant — Claude Code,
Claude Desktop, GitHub Copilot, Cursor, Codex, Agy, Kiro, Windsurf — **build and manage
[qu4zr](https://qu4zr.com) workspaces** in natural language. It wraps the qu4zr Management API as
MCP tools.

A workspace is a canvas of blocks connected by links (one canvas per workspace).

> Ask your assistant: *"Create a workspace 'Orders' that exposes a `/orders` webhook and transforms
> the body, then show it to me."* — and it appears, editable, on your qu4zr canvas.

**Source and releases.** [github.com/Qu4zr/qu4zr-mcp](https://github.com/Qu4zr/qu4zr-mcp) is the
exact source of every release: each one is built and published to npm by that repository's
workflow, with a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements)
linking the package to the commit. The repository mirrors the package's folder in qu4zr's main
codebase, so issues are welcome there and pull requests are ported by hand.

## Without installing anything

If your assistant takes a remote MCP server (Claude, ChatGPT, Cursor, VS Code…), add

```
https://api.management.qu4zr.io/mcp
```

as a connector. It sends you to qu4zr to sign in and approve it — no secret to copy — and you can
disconnect it under **Account → API & AI Access**. The hosted server has every tool except the two
that act on your own machine: `setup_runner`, and `sync_files` from a local folder. For those, use the
package below.

## Setup

1. In qu4zr, go to **Account → API Access** and create an API client. Copy the
   **client id** and **client secret** (shown once).
2. Register the server with your assistant — one command, below.
3. `npx qu4zr-mcp doctor` if anything is off. It checks the same three things the server does
   (config → token → one real API call) and says which one broke.

Nothing to install first: `npx -y` fetches the package on demand. On Windows, the Codex installer
uses that one interactive invocation to stage a stable runtime, then Codex launches its
`dist/index.js` with the exact Node executable that ran the installer; `npx` is not left in the MCP
stdio path. When that Node supports it, the installer also enables Windows' trusted certificate
store automatically, so antivirus, VPN and corporate-proxy certificates work without extra setup.

### Clients with a command

```bash
# Claude Code                     (-s user registers it for every project; drop it for this one)
claude mcp add qu4zr -s user --env QU4ZR_CLIENT_ID=igdc_… --env QU4ZR_CLIENT_SECRET=igds_… -- npx -y qu4zr-mcp

# GitHub Copilot CLI
copilot mcp add qu4zr --env QU4ZR_CLIENT_ID=igdc_… --env QU4ZR_CLIENT_SECRET=igds_… -- npx -y qu4zr-mcp

# Codex CLI (macOS / Linux)
codex mcp add qu4zr --env QU4ZR_CLIENT_ID=igdc_… --env QU4ZR_CLIENT_SECRET=igds_… -- npx -y qu4zr-mcp

# Codex CLI (Windows) — installs a stable runtime and writes ~/.codex/config.toml
npx -y qu4zr-mcp install codex --windows --client-id igdc_… --client-secret igds_…

# Agy                             (all flags come before the server name)
agy mcp add --env QU4ZR_CLIENT_ID=igdc_… --env QU4ZR_CLIENT_SECRET=igds_… qu4zr npx -y qu4zr-mcp
```

One line on purpose — a `\` continuation does not survive a paste into PowerShell or cmd.

### On Windows: Codex launches Node directly

```bash
npx -y qu4zr-mcp install codex --windows --client-id igdc_… --client-secret igds_…
```

Run that command on the Windows machine where Codex runs: the generated TOML contains that
machine's absolute stable path. If an older `qu4zr` table already exists, review it and rerun with
`--force`; the installer backs up `config.toml` before replacing the main table and its `.env`
subtable.

```toml
[mcp_servers.qu4zr]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["--use-system-ca", "C:\\Users\\you\\.codex\\mcp\\qu4zr\\node_modules\\qu4zr-mcp\\dist\\index.js"]
env = { QU4ZR_CLIENT_ID = "igdc_…", QU4ZR_CLIENT_SECRET = "igds_…" }
```

`npx` on Windows is an extensionless POSIX shell script; the runnable file is `npx.cmd`, and
`CreateProcess` only ever appends `.exe`. A client that spawns the command **directly, without a
shell, cannot start `npx` at all** — and nothing about the failure says so. Codex reports it as:

> ⚠ MCP client for `qu4zr` timed out after 30 seconds. Add or adjust `startup_timeout_sec` in your
> config.toml

Raising that timeout cannot help. Bare `npx` may never start; through `cmd /c`, Codex 0.149.1 with
npm 11.16.0 can start `npx` but leave it attached to the eager MCP stdin before qu4zr receives
`initialize`. `qu4zr-mcp install codex` removes both failure modes by copying the already-downloaded
runtime under `~/.codex/mcp/qu4zr` and writing a direct launcher for the exact Node executable used
to install it. If that Node supports `--use-system-ca`, the launcher enables Windows' trusted-root
store too; older supported Node versions simply omit the flag. Other Windows clients keep the
`cmd /c` form until their startup behaviour is measured separately.

### Clients with a config file

`qu4zr-mcp install <client>` writes the entry for you, in that client's shape and in that client's
file. It backs the file up first, never replaces an existing `qu4zr` entry without `--force`, and
refuses to rewrite a file it cannot parse.

```bash
npx -y qu4zr-mcp install cursor          # or claude-desktop, vscode, kiro, windsurf, codex
npx -y qu4zr-mcp install vscode --project
npx -y qu4zr-mcp install kiro --print    # print the snippet, touch nothing
```

It reads `QU4ZR_CLIENT_ID` / `QU4ZR_CLIENT_SECRET` from the environment, or takes
`--client-id` / `--client-secret`.

By hand, if you prefer — **the clients disagree, and they disagree silently**. A block in the wrong
shape saves cleanly, loads nothing, and reports nothing:

| Client | File | Root key |
|---|---|---|
| Claude Desktop | `claude_desktop_config.json` (`%APPDATA%\Claude`, `~/Library/Application Support/Claude`, `~/.config/Claude`) | `mcpServers` |
| Cursor | `~/.cursor/mcp.json`, or `.cursor/mcp.json` per project | `mcpServers` |
| Kiro | `~/.kiro/settings/mcp.json`, or `.kiro/settings/mcp.json` per project | `mcpServers` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| VS Code / Copilot | `.vscode/mcp.json` | **`servers`**, and the entry needs `"type": "stdio"` |
| Codex CLI | `~/.codex/config.toml` | **TOML** table `[mcp_servers.qu4zr]` |

The standard JSON shape on macOS/Linux (Windows JSON clients use `cmd` +
`["/c", "npx", "-y", "qu4zr-mcp"]`):

```json
{
  "mcpServers": {
    "qu4zr": {
      "command": "npx",
      "args": ["-y", "qu4zr-mcp"],
      "env": {
        "QU4ZR_CLIENT_ID": "igdc_your_client_id",
        "QU4ZR_CLIENT_SECRET": "igds_your_client_secret"
      }
    }
  }
}
```

Claude Desktop reads that file once, at launch — quit it and reopen it, a reload is not enough.

## Environment variables

| Variable | Required | Default |
|----------|----------|---------|
| `QU4ZR_CLIENT_ID` | yes | — |
| `QU4ZR_CLIENT_SECRET` | yes | — |
| `QU4ZR_BASE_URL` | no | `https://api.management.qu4zr.io` |
| `QU4ZR_SCOPES` | no | `flows:read flows:write flows:deploy flows:execute` |
| `NODE_USE_SYSTEM_CA` | no | generated as `1` for every Windows client; recent Node trusts Windows roots |
| `NODE_EXTRA_CA_CERTS` | no | — — the root certificate of a proxy that re-signs your traffic |

They belong in the MCP config's own `env` block. A variable exported in your shell does not reach
a process your assistant spawns, which is why the server reports credentials as missing while
`echo $QU4ZR_CLIENT_ID` prints one.

To make the assistant **build-only** (no deploy/run), set
`QU4ZR_SCOPES="flows:read flows:write"`.

## When it doesn't start

`npx qu4zr-mcp doctor` prints the configuration it can actually see, exchanges a token, and makes
one authenticated call. The four failures worth naming in advance:

- **a startup timeout on Windows** (Codex: *"timed out after 30 seconds"*) — either bare `npx`
  never started, or `cmd /c npx` stayed attached to Codex's eager stdin before qu4zr received
  `initialize`. Run `npx -y qu4zr-mcp install codex --windows …`; raising
  `startup_timeout_sec` cannot repair either failure.
- **`invalid_client`** — the id or secret is wrong, or the client was disabled, deleted or expired.
  Rotate the secret under Account → API Access and update the config.
- **credentials missing** while your shell has them — see above: they have to be in the `env` block.
- **`UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN`** — an antivirus, corporate
  proxy or VPN is re-signing TLS with a root your Node install does not trust. Every generated
  Windows configuration sets `NODE_USE_SYSTEM_CA=1`; recent Node versions then use the Windows
  certificate store, while older versions safely ignore it. If the error remains, point Node at that root:
  `NODE_EXTRA_CA_CERTS=/path/to/corporate-root.pem`.

  **Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`.** It is the first thing a search suggests, and it
  disables certificate verification for every request the process makes — including the one that
  carries your client secret. The server warns on startup when it is set.

## What it does on your machine

No install script: `npm install` / `npx` run nothing. At run time the server talks only to the
qu4zr API over verified HTTPS, writes files only for `install <client>` and `setup_runner`, and
starts processes (`dotnet`, and the service installer behind a UAC/sudo prompt) only from
`setup_runner` with `confirm: true`. The full list is in [SECURITY.md](./SECURITY.md).

## Tools

| Tool | Scope | Notes |
|------|-------|-------|
| `get_block_model` | — | Workspace/block/link schema + runtime notes + example (read before building) |
| `list_workspaces` | flows:read | optional `nameStartsWith` / `nameContains` filter |
| `get_workspace_content` | flows:read | blocks + links of a workspace |
| `list_vault_secrets` | flows:read | vault + secret **names** only (never values) — for `sql.query` references |
| `create_workspace` | flows:write | |
| `set_workspace_content` | flows:write | **build** — replace a workspace's blocks + links (and `zones`, the named canvas areas) |
| `add_to_workspace` | flows:write | **append** a self-contained flow without touching existing blocks (may add `zones`) |
| `update_block` / `delete_block` | flows:write | edit **one block** — don't re-send the workspace to change a field (delete: `confirm: true`) |
| `list_files` / `read_file` | flows:read | the workspace's code files (pages, stylesheets, helper libraries), with each file's `sha256` |
| `edit_file` | flows:write | change **part** of an existing file (`oldString` → `newString`), leaving every other byte alone — the default for editing anything that already exists |
| `write_file` / `delete_file` | flows:write | **create** a code file or replace one outright (delete: `confirm: true`). Writing an HTML **page** also reports what it still needs to be findable (see [Sites](#sites-pages-not-just-apis)) |
| `audit_seo` | flows:read | read HTML pages for what makes them findable — nothing written; send the whole site + `baseUrl` for the cross-page checks |
| `get_site_visitors` | flows:read | real visitors of the caller's own sites per day (crawlers and cloud servers left out), returning, sources, bot share; all sites at once or one; up to 400 days |
| `get_site_traffic` | flows:read | one site's requests summed over up to 30 days: crawlers by name, busiest endpoints and paths with bot share, statuses, cache hits |
| `get_app_analytics` | flows:read | aggregates of the events an app records with `analytics.track` — totals, distinct actors, daily counts, thresholds, breakdowns, D1/D7/D30 retention; never who |
| `set_app_listing` | flows:deploy | ask for a site to be listed at qu4zr.com/apps (pending until an operator approves; edits go back for review), read the listing, or withdraw it |
| `infer_zones` | flows:write | group an EXISTING workspace's blocks into labelled canvas areas and lay them out (**`confirm: true`**). For something you are building, send `zones` with the content instead |
| `get_workspace_data` | flows:read | the workspace's key-value store — one key, or a listing (`keysOnly: true` lists keys, sizes and timestamps without the values) |
| `set_workspace_data` | flows:write | write one entry, optionally with a TTL |
| `delete_workspace_data` | flows:write | delete one `key`, a named list of `keys`, or everything under a `prefix` (**`confirm: true`**). Prefer `keys` when the store also holds entries you did not create |
| `describe_database` | flows:read | whether this workspace has its own SQL database, and how much of the allowance is used — ask before building anything that needs one |
| `query_database` | flows:read | run a READ against it (the connection cannot write). `SELECT name FROM sqlite_master WHERE type = 'table'` to see what is there |
| `execute_sql` | flows:write | CREATE / ALTER / INSERT / UPDATE / DELETE (**`confirm: true`**). No undo: a restore point reverts blocks and files, never rows |
| `list_schedules` | flows:read | what runs on a clock, when it next fires, why it paused |
| `create_schedule` | flows:deploy | put a Schedule block on a cron — **requires `confirm: true`**; pins the latest committed version |
| `pause_schedule` / `resume_schedule` | flows:write / flows:deploy | stopping is the easy direction; resuming needs `confirm: true` |
| `delete_schedule` | flows:write | removes the schedule, keeps the block (**`confirm: true`**) |
| `commit_workspace_version` | flows:write | snapshot a version |
| `delete_workspace` | flows:write | **requires `confirm: true`** (previews first) |
| `list_endpoints` | flows:read | |
| `list_domains` | flows:read | API domains to deploy into — resolves `deploy_endpoint`'s `domainId` |
| `list_domain_clients` | flows:read | a domain's **API clients** (machine callers using `client_credentials` tokens), the token/JWKS/discovery URLs and the signing keys — never a secret |
| `create_domain_client` / `rotate_domain_client_secret` | flows:deploy | mint a client, or a new secret for one — the `clientSecret` is in that reply only, with a ready-to-run `curl` (**`confirm: true`**) |
| `update_domain_client` / `revoke_domain_client_tokens` / `delete_domain_client` | flows:deploy | change scopes, lifetime, `rateLimitPerMinute` (the client's own allowance, `0` removes it) or `active`; refuse every token issued so far; delete (**`confirm: true`**) |
| `rotate_domain_signing_key` | flows:deploy | a new key for signing the domain's tokens; the previous one keeps verifying until its tokens expire (**`confirm: true`**) |
| `list_trusted_issuers` / `set_trusted_issuer` / `delete_trusted_issuer` | flows:read / flows:deploy | accept tokens from the user's own Auth0, Okta, Entra, Cognito, Firebase or Keycloak on `jwt` endpoints — the **audience is required** (**`confirm: true`** to change). `kind: "hs256"` + `secret` for a provider signing with a shared secret (Supabase): write-only, never echoed, omit to keep it |
| `check_trusted_issuer` | flows:read | fetch an issuer's keys now, or run a pasted token through the gateway's own check and say which check it fails |
| `deploy_endpoint` | flows:deploy | **requires `confirm: true`** (previews first) |
| `update_endpoint` | flows:deploy | verbs, visibility, notes, and **`authMode`** (`anonymous` / `apiKey` / `user` / `jwt` / `apiKeyOrJwt`) with `requiredScopes` (**`confirm: true`**) |
| `execute_workspace` | flows:execute | **requires `confirm: true`** (previews first) |
| `test_block` | flows:execute | dry-run one block with sample input → output/error (self-correct before deploy). Pass `request` for any block in an endpoint flow — without it there is no `request` global and the block answers `request is not defined` |
| `call_endpoint` | flows:read | a **real HTTP request** to a deployed endpoint — the only check that goes through the live URL, so the deployment, the path, the verbs and the key are all exercised. First thing to reach for when a page's own calls are failing |
| `setup_runner` | flows:execute | **on-prem** — download, build, onboard & launch the runner on your machine (`installService:true` to keep it always-on) |
| `list_runner_clients` | flows:read | List the Developer Runner separately from Consumer App Runners, with live presence |
| `list_runner_devices` | flows:read | List independently enrolled Consumer App Runner devices for a SignalR block |
| `get_consumer_runner_download` | flows:read | Return the public, secret-free consumer `.exe` URL only when its artifact is available |
| `get_runner_artifact_status` | flows:read | Check immutable consumer artifact availability, version and signature level |
| `release_runner_handler` | flows:deploy | Compile the block's current handler into the executable its users download (**requires `confirm:true`**) |
| `get_runner_release_status` | flows:read | What the app's users are running, any build in flight, the last compiler error, and whether the handler drifted since |
| `claim_runner_pairing` | flows:execute | Claim a waiting generic runner during integration testing (**requires `confirm:true`**) |
| `execute_runner_device` | flows:execute | Route one execution to exactly one authorized device |
| `rename_runner_device` | flows:execute | Rename one consumer device without changing its identity |
| `revoke_runner_device` | flows:execute | Revoke and disconnect one consumer device without invalidating the others |
| `revoke_all_consumer_runners` | flows:execute | Revoke every consumer device, never the Developer Runner (`confirm:true`) |
| `revoke_developer_runner` | flows:execute | Immediately revoke only the Developer Runner (`confirm:true`) |
| `test_runner_handler` | flows:execute | **on-prem** — compile + run a handler on your test-mode runner → output/error (self-correct loop) |
| `get_logs` | flows:read | recent execution logs for a block |

`delete_workspace`, `deploy_endpoint`, `execute_workspace` and the per-item deletes
(`delete_block`, `delete_file`) won't act until called with `confirm: true`, so the assistant always
shows you what it's about to do first. Your MCP client also prompts to approve each tool call.

(The OAuth scopes keep the identifiers `flows:read/write/deploy/execute` for compatibility
with existing API clients; the resource is "workspaces".)

Everything the assistant builds is written through the same API the qu4zr canvas uses, so
it shows up as a normal, fully-editable workspace on the site.

## Checking that it works

Four checks, and each sees something the others cannot. Skipping one does not make a build faster,
it makes it finish in a state nobody has looked at:

| | answers |
|---|---|
| `validate_blocks` | the code parses |
| `test_block` | one block returns what you expect — pass `request` for anything in an endpoint flow |
| `execute_workspace` | the blocks are **wired**: an endpoint whose Process block is not linked to it returns `null`, and that `null` is the finding |
| `call_endpoint` | the deployed **URL** answers — the deployment, the path, the verbs, the key |

Two mistakes are common enough that the write tools now warn about them, because both are legal to
save and invisible until something 404s:

- **An API Endpoint block does not run code.** It is a door, not a handler: its `code` is never
  executed — not on the request, not at the gateway — and the block emits its own `rawData` (`null`
  when empty). The request is handled by the Process block you *link it to*, which reads `request`.
  An endpoint with nothing downstream answers `null` to every caller, with a 200, forever.
- **`endpointPath` is not a URL.** It is a note on the block until `deploy_endpoint` runs, and every
  path needs its own deploy — adding a twelfth block to a workspace with eleven deployed endpoints
  publishes nothing. `list_endpoints` shows what is really deployed; `call_endpoint` proves it.

## Sites (pages, not just APIs)

A page is an HTML code file published by an API Endpoint block with `staticFile` set — served
verbatim, no JavaScript executed, so a crawler sees exactly the file that was written. The home page
goes at path `"/"` (the domain root); a path may also be a file name, which is how `sitemap.xml` or a
search-console verification file gets published. Public pages need `isAnonymous: true`.

**A site has its own address**, `https://<slug>.qu4zr.com/` — that is what a deploy reports back and
what `list_domains` returns as `baseUrl`. The gateway form `https://api.qu4zr.io/<slug>/` keeps
serving the same content for existing API callers. Since both answer, the canonical tag decides which
one is indexed: take the base from `baseUrl` rather than assembling a URL, or the pages and the
generated sitemap will name different hosts and a crawler will discard the sitemap.

**Pages are written search-ready by default.** The assistant is told to ask for the name, the
one-line description and the language — not whether you want SEO — and every page gets a title, meta
description, absolute canonical, Open Graph tags, one `<h1>` and structured data. Writing an HTML
page returns anything still missing, so the assistant can fix it on the spot; it is **advisory** and
never blocks the write. `seo: "minimal"` reports only the essentials, `seo: "none"` turns it off, and
a page carrying `<meta name="robots" content="noindex">` is exempt.

Once the site is built, `audit_seo` runs the **server's** audit over all the pages at once — the
authority, and the only one that can see across pages: two pages sharing a title, a canonical
pointing at a site you don't own, a hand-written sitemap listing URLs that aren't yours. It writes
nothing, so it can be re-run after every fix.

**`sitemap.xml` and `robots.txt` are the platform's job.** `sitemap.xml` is generated from the pages
actually deployed, so it cannot go stale — deploy your own at that path only if you need to override
it (pages templated by a Process block aren't visible to the generator). On the site's own host,
`robots.txt` is generated too: it allows crawling and carries the `Sitemap:` line, which is how a
crawler finds the sitemap without anyone submitting it. And the gateway marks every non-HTML reply
`X-Robots-Tag: noindex`, so API endpoints stay out of search results on their own.

## On-prem runners (run logic on your machine)

A **SignalR** block runs C# logic on a small runner on *your* machine or network (internal DBs,
local files) over an outbound connection — no VPN, no inbound ports. The assistant authors the C#
handler, then with `setup_runner` downloads, builds, onboards and launches the runner for you (you
approve the launch). Run it with `--test` and `test_runner_handler` compiles + runs the handler on
your machine so the assistant can verify and iterate. To keep the endpoint alive across reboots,
`setup_runner` with `installService:true` registers it as a Windows service / systemd unit — gated
behind an admin / UAC / `sudo` approval. Connection strings live in the runner's local config and
are never sent to qu4zr or the assistant.

Each consumer installation has a durable `deviceId`. Multiple devices may connect to the same
SignalR block concurrently; reconnecting the same device replaces only that device's old connection.
Executions are routed explicitly by `(blockId, deviceId)` with no broadcast fallback, and results
are accepted only from the connection that received the request.

For consumer applications, do not send users to the qu4zr dashboard or ask them to paste onboarding
codes. Publish the immutable installer with the application's HTTPS pairing page baked in. It opens
that page with only `pairingId`; the application backend authenticates the user and claims it through
`POST /api/v1/runner/{blockId}/pairings/{pairingId}/claim`. `claim_runner_pairing` exercises this
during development but is not a browser API. The Management API credential stays in server-side
vault configuration and never in PWA JavaScript. Subsequent commands use the device-specific execute
route only after the same server-side ownership lookup.

Local values referenced by the handler (`local["name"]`) are configured by a temporary loopback
page on first consumer launch and encrypted with the current Windows user's DPAPI key. Only key
names are baked into the artifact; values never reach qu4zr, MCP or the application backend.

`get_consumer_runner_download` returns the public
`https://qu4zr.com/api/runner/download/{blockId}/windows?runtimeIdentifier=win-x64` URL for the
application's download button. The download creates no device or ticket; enrollment starts only
when the executable launches and its pairing is claimed. The authenticated Management API proxy
route remains available, while the older enrollment ZIP is a compatibility path.

Before exposing that download, `get_runner_artifact_status` reports whether the requested platform
is published, its immutable version and whether Windows will see it as `unsigned` or
`authenticode`. It is read-only and never returns artifact bytes, filesystem paths or credentials.

Runner setup diagnostics use structured lifecycle stages instead of treating every failure as a
handler bug. Package consumers must validate hashes and relative paths before writing, preserve
existing `Local` settings during regeneration, and distinguish missing SDK, generated plumbing,
`Handler.cs`, and generic restore/build failures. Keep the `packageVersion` with diagnostic reports.

## Develop

```bash
npm install
npm run build      # tsc → dist/
QU4ZR_CLIENT_ID=… QU4ZR_CLIENT_SECRET=… npm start
```

## License

MIT


## Application verification: local source to public evidence

Mail DNS Diff (`https://mail-diff.qu4zr.com/`; local reference
`C:/dev/_innovation/mail-diff/`) reuses the API Watch deployment pattern with no new primitive.
Require a server SHA-256 on every file push, replay the deployed files and graph in an offline
journey harness, then verify the actual public paths with `call_endpoint`. `test_block` does
not let a caller set request.path. Commit after pushing and re-pin schedules: HTTP follows live
content, scheduled work follows its committed version.

Do not assume dryRun rolls back every side effect: database calls can be stubbed while a store
schema marker or lease survives. Confirm actual schema existence; use bounded leases.
`analytics.report` returns `retention.points` with day/eligible/retained and `daily` rows with
date/name/total/actors. An app's dashboard should use these exact shapes and should call a
successful `mail.send` **queued**, not delivered.

For dynamic shareable results, publish a sitemap that includes only eligible reviewed pages.
Audit the rendered HTML as well as the static entry pages, and read live X-Robots-Tag headers
on pages, sitemap.xml and robots.txt. An accepted IndexNow request is submission evidence;
Google Search Console submission and app-directory operator approval are separate steps.

