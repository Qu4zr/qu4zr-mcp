# Security

## Reporting a vulnerability

Email **contact@qu4zr.com** with "security" in the subject. Please do not open a public issue
first. You will get an answer within 72 hours.

## What this package does on your machine

`qu4zr-mcp` is a stdio MCP server. Installing it runs nothing: it has no `preinstall`,
`install`, `postinstall` or `prepare` script, and has never had one in any published version.

At run time it:

- **talks to one host**, the qu4zr Management API (`QU4ZR_BASE_URL`,
  `https://api.management.qu4zr.io` by default), over HTTPS with normal certificate verification. It never sets `NODE_TLS_REJECT_UNAUTHORIZED`; it
  only *reads* it, to warn you when something else has turned verification off.
- **reads its credentials from its environment** (`QU4ZR_CLIENT_ID`, `QU4ZR_CLIENT_SECRET`). The
  secret is sent only to the qu4zr token endpoint.
- **writes files only when you run a command that says so:**
  - `qu4zr-mcp install <client>` adds a `qu4zr` entry to that client's MCP configuration
    (for Codex on Windows it also copies the package into `~/.codex/mcp/qu4zr` so it starts fast).
  - the `setup_runner` tool fetches the source of an on-prem runner project (C#, generated from
    your block's handler) from the same API and writes it to `~/.qu4zr/runners/<blockId>`.
- **starts processes only from `setup_runner`**, after the assistant passes `confirm: true`:
  - `dotnet build` / `dotnet run` for the runner project it just wrote;
  - with `installService: true`, the generated `install-service.ps1` (Windows, through a UAC
    prompt you approve, with execution policy `RemoteSigned`) or `install-service.sh`
    (Linux/macOS, which you run with `sudo` yourself). The service is passed a one-time
    onboarding code that expires after 15 minutes.

No binary is downloaded, and nothing else is spawned or executed.

## The hosted server (`serve-http`)

qu4zr also runs this package as a remote MCP server at `https://api.management.qu4zr.io/mcp`.
That mode differs on purpose:

- **no credentials of its own**: each request carries the bearer token of the person whose AI
  client sent it (OAuth 2.1 authorization code + PKCE, approved on qu4zr's consent screen), and
  every API call made while serving it uses that token, checked with the API first;
- **nothing on the machine**: `setup_runner` is not registered, and `sync_files` refuses
  `localDir`. Files travel in the request instead;
- **stateless**: nothing about a person is kept between requests.

A person disconnects an application under Account → API & AI Access; it can no longer renew its
access, and the access token it holds expires within 30 minutes.

## Dependencies

Three runtime dependencies: `@modelcontextprotocol/sdk`, `zod`, `acorn`.
