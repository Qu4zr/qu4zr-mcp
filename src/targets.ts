/**
 * Every way a person can point their assistant at this server, in one table.
 *
 * The clients do not agree, and the disagreements are silent: VS Code names the root key
 * `servers` and wants a `type`, Codex stores TOML, everyone else stores `mcpServers` JSON in a
 * different file. Copying the Claude Desktop snippet into any of the others produces a config
 * that saves cleanly and never loads, which is the single most common way this package fails to
 * start for somebody.
 *
 * So the divergence lives here, once, and `install`, `doctor` and the README all read from it.
 * The API Access page in the web app carries a deliberately parallel table (see
 * `wwwroot/js/api-clients-manager.js`, MCP_TARGETS) — keep the two in step.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface Creds {
  clientId: string;
  clientSecret: string;
  /** Only emitted when it differs from the package default. */
  baseUrl?: string;
  /** Only emitted when it differs from the package default. */
  scopes?: string;
}

export type Scope = "user" | "project";

export interface McpTarget {
  id: string;
  label: string;
  /** `cli` targets are registered by running a command; the others are a config file we edit. */
  kind: "cli" | "json" | "toml";
  /** The shell command that registers the server (kind === "cli"). */
  command?: (c: Creds, windows?: boolean) => string;
  /** Where the config lives, per scope. Undefined scope = this target has no such scope. */
  file?: (scope: Scope, cwd: string) => string | undefined;
  /** JSON configs: the object the server entry hangs off. VS Code is the odd one out. */
  rootKey?: "mcpServers" | "servers";
  /** What to paste when you are editing the file by hand. */
  snippet: (c: Creds, windows?: boolean, launcher?: Launcher) => string;
  note?: string;
}

export const DEFAULT_BASE_URL = "https://api.management.qu4zr.io";
export const DEFAULT_SCOPES = "flows:read flows:write flows:deploy flows:execute";

/** The env block every target passes to the process, minus whatever is already the default. */
export function envFor(c: Creds, windows: boolean = isWindows()): Record<string, string> {
  const env: Record<string, string> = {
    QU4ZR_CLIENT_ID: c.clientId,
    QU4ZR_CLIENT_SECRET: c.clientSecret,
  };
  // Unlike the `--use-system-ca` CLI flag, an older Node safely ignores this variable. It can
  // therefore go into every Windows client's environment without turning compatibility with Node
  // 18/20 into a startup failure. Recent Node releases use the roots Windows already trusts.
  if (windows) env.NODE_USE_SYSTEM_CA = "1";
  if (c.baseUrl && c.baseUrl !== DEFAULT_BASE_URL) env.QU4ZR_BASE_URL = c.baseUrl;
  if (c.scopes && c.scopes !== DEFAULT_SCOPES) env.QU4ZR_SCOPES = c.scopes;
  return env;
}

export const isWindows = () => platform() === "win32";

export interface Launcher {
  command: string;
  args: string[];
}

/**
 * How the server is started, and the single most expensive detail in this file.
 *
 * On Windows `npx` is a POSIX shell script with no extension; the runnable file is `npx.cmd`.
 * `CreateProcess("npx")` only ever appends `.exe`, so a client that spawns the command **directly
 * — without a shell — cannot start `npx` at all**, and nothing about the failure says so. Measured
 * on this machine: Codex reports it as *"MCP client for `qu4zr` timed out after 30 seconds"* and
 * suggests raising `startup_timeout_sec`, which cannot help, because nothing was ever spawned.
 *
 * Going through `cmd /c` fixes that executable-resolution problem for the JSON clients. Codex is
 * deliberately different: its TUI can write `initialize` while npm still owns stdin, and npm 11
 * may then stay alive without handing the pipe to qu4zr. `install codex` stages the runtime and
 * writes a direct Node launcher instead.
 *
 * `npx -y` either way: it needs no global install, so "add the server" stays one step that can fail
 * once rather than two that can each fail separately. (A global install does not dodge this — the
 * `qu4zr-mcp` it puts on PATH is the same kind of shim.)
 */
export const launcherFor = (windows: boolean): Launcher =>
  windows
    ? { command: "cmd", args: ["/c", "npx", "-y", "qu4zr-mcp"] }
    : { command: "npx", args: ["-y", "qu4zr-mcp"] };

/** What a CLI's `--` tail, or a shell, has to be handed. */
export const launchCommand = (windows: boolean) =>
  windows ? "cmd /c npx -y qu4zr-mcp" : "npx -y qu4zr-mcp";

/**
 * Direct Node launcher used by Codex on Windows after `install codex` stages the package.
 *
 * The installer passes the absolute executable that is running it, so Codex neither depends on a
 * later PATH lookup nor accidentally starts a different Node. Recent Node releases can also use
 * Windows' trusted-root store. That matters on machines where an antivirus, VPN or corporate
 * proxy re-signs HTTPS: Windows trusts the root while Node's bundled CA set does not.
 */
export const codexLauncher = (
  entryPath: string,
  nodeCommand: string = "node",
  useSystemCa: boolean = false,
): Launcher => ({
  command: nodeCommand,
  args: [...(useSystemCa ? ["--use-system-ca"] : []), entryPath],
});

export function serverEntry(
  c: Creds,
  extra?: Record<string, unknown>,
  windows: boolean = isWindows(),
): Record<string, unknown> {
  return {
    ...(extra ?? {}),
    ...launcherFor(windows),
    env: envFor(c, windows),
  };
}

/**
 * One line, no backslash continuations. A wrapped shell command is easier to read and impossible
 * to paste: the continuation character differs between bash, cmd and PowerShell, and the people
 * most likely to be copying this are on Windows.
 */
const envFlags = (c: Creds, flag: string, windows: boolean) =>
  Object.entries(envFor(c, windows))
    .map(([k, v]) => `${flag} ${k}=${v}`)
    .join(" ");

const installCredentialFlags = (c: Creds) =>
  [
    `--client-id ${c.clientId}`,
    `--client-secret ${c.clientSecret}`,
    ...(c.baseUrl && c.baseUrl !== DEFAULT_BASE_URL ? [`--base-url ${c.baseUrl}`] : []),
    ...(c.scopes && c.scopes !== DEFAULT_SCOPES ? [`--scopes ${JSON.stringify(c.scopes)}`] : []),
  ].join(" ");

const jsonSnippet = (c: Creds, rootKey: string, windows: boolean, extra?: Record<string, unknown>) =>
  JSON.stringify({ [rootKey]: { qu4zr: serverEntry(c, extra, windows) } }, null, 2);

const home = () => homedir();
export const codexHome = () => process.env.CODEX_HOME ?? join(home(), ".codex");
const isWin = isWindows;

/** %APPDATA% on Windows, the usual per-OS spots elsewhere. */
function claudeDesktopFile(): string {
  if (isWin()) {
    return join(process.env.APPDATA ?? join(home(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  if (platform() === "darwin") {
    return join(home(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return join(home(), ".config", "Claude", "claude_desktop_config.json");
}

export const TARGETS: McpTarget[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    kind: "cli",
    command: (c, w = isWindows()) => `claude mcp add qu4zr -s user ${envFlags(c, "--env", w)} -- ${launchCommand(w)}`,
    snippet: (c, w = isWindows()) => jsonSnippet(c, "mcpServers", w),
    note: "`-s user` registers it once for every project. Drop it for this project only. `claude mcp list` shows what took.",
  },
  {
    id: "copilot",
    label: "GitHub Copilot CLI",
    kind: "cli",
    command: (c, w = isWindows()) => `copilot mcp add qu4zr ${envFlags(c, "--env", w)} -- ${launchCommand(w)}`,
    snippet: (c, w = isWindows()) => jsonSnippet(c, "mcpServers", w),
    note: "`copilot mcp add --help` if your build wants a different shape. `/mcp` inside the CLI lists the servers it loaded.",
  },
  {
    id: "codex",
    label: "Codex CLI",
    kind: "toml",
    file: (scope) => (scope === "user" ? join(codexHome(), "config.toml") : undefined),
    command: (c, w = isWindows()) =>
      w
        ? `npx -y qu4zr-mcp install codex --windows ${installCredentialFlags(c)}`
        : `codex mcp add qu4zr ${envFlags(c, "--env", false)} -- ${launchCommand(false)}`,
    snippet: (c, w = isWindows(), installedLauncher) => {
      const env = Object.entries(envFor(c, w))
        .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
        .join(", ");
      const defaultCodexEntry = join(
        codexHome(),
        "mcp",
        "qu4zr",
        "node_modules",
        "qu4zr-mcp",
        "dist",
        "index.js",
      );
      const { command, args } = installedLauncher ?? (w ? codexLauncher(defaultCodexEntry) : launcherFor(false));
      return [
        "[mcp_servers.qu4zr]",
        `command = ${JSON.stringify(command)}`,
        `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]`,
        `env = { ${env} }`,
      ].join("\n");
    },
    note: "Codex stores TOML, not JSON, under `mcp_servers`. On Windows run `qu4zr-mcp install codex`: it stages a stable copy, points Codex at the exact Node executable and, when Node supports it, uses Windows' trusted certificate store automatically.",
  },
  {
    id: "agy",
    label: "Agy",
    kind: "cli",
    command: (c, w = isWindows()) => `agy mcp add ${envFlags(c, "--env", w)} qu4zr ${launchCommand(w)}`,
    snippet: (c, w = isWindows()) => jsonSnippet(c, "mcpServers", w),
    note: "Agy requires every flag before the server name; the installer emits them in that order.",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    kind: "json",
    rootKey: "mcpServers",
    file: (scope) => (scope === "user" ? claudeDesktopFile() : undefined),
    snippet: (c, w = isWindows()) => jsonSnippet(c, "mcpServers", w),
    note: "Quit and reopen Claude Desktop afterwards — it reads the file once, at launch.",
  },
  {
    id: "cursor",
    label: "Cursor",
    kind: "json",
    rootKey: "mcpServers",
    file: (scope, cwd) =>
      scope === "user" ? join(home(), ".cursor", "mcp.json") : join(cwd, ".cursor", "mcp.json"),
    snippet: (c, w = isWindows()) => jsonSnippet(c, "mcpServers", w),
  },
  {
    id: "vscode",
    label: "VS Code / Copilot",
    kind: "json",
    rootKey: "servers",
    file: (scope, cwd) => (scope === "project" ? join(cwd, ".vscode", "mcp.json") : undefined),
    snippet: (c, w = isWindows()) => jsonSnippet(c, "servers", w, { type: "stdio" }),
    note: "VS Code is the exception: the root key is `servers`, not `mcpServers`, and the entry carries `\"type\": \"stdio\"`. A `mcpServers` block here loads nothing and reports nothing.",
  },
  {
    id: "kiro",
    label: "Kiro",
    kind: "json",
    rootKey: "mcpServers",
    file: (scope, cwd) =>
      scope === "user"
        ? join(home(), ".kiro", "settings", "mcp.json")
        : join(cwd, ".kiro", "settings", "mcp.json"),
    snippet: (c, w = isWindows()) => jsonSnippet(c, "mcpServers", w),
  },
  {
    id: "windsurf",
    label: "Windsurf",
    kind: "json",
    rootKey: "mcpServers",
    file: (scope) => (scope === "user" ? join(home(), ".codeium", "windsurf", "mcp_config.json") : undefined),
    snippet: (c, w = isWindows()) => jsonSnippet(c, "mcpServers", w),
  },
  {
    id: "json",
    label: "Any other MCP client",
    kind: "json",
    rootKey: "mcpServers",
    snippet: (c, w = isWindows()) => jsonSnippet(c, "mcpServers", w),
    note: "The standard shape. If your client wants a different root key, the inner `qu4zr` object is what it needs.",
  },
];

export const findTarget = (id: string): McpTarget | undefined => {
  // Keep old automation working after Gemini CLI became Agy, without continuing to advertise the
  // obsolete name in targetIds(), help or the website.
  const normalized = id.toLowerCase() === "gemini" ? "agy" : id.toLowerCase();
  return TARGETS.find((t) => t.id === normalized);
};

export const targetIds = () => TARGETS.map((t) => t.id);
