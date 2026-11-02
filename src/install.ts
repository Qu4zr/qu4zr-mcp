/**
 * `qu4zr-mcp install <client>` — write the server into a client's config, in that client's shape.
 *
 * The alternative is what the docs used to do: show one JSON blob and let the reader work out
 * that their client wants a different root key, a different file, or TOML. That step is where
 * people fall off, and when they fall off there is nothing to see — a mis-shaped entry is saved
 * happily and simply never loads.
 *
 * Never destructive: the file is backed up before it is rewritten, an existing `qu4zr` entry is
 * only replaced with --force, and anything this cannot parse is printed for hand-editing instead
 * of being clobbered.
 */

import { cp, mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BASE_URL,
  DEFAULT_SCOPES,
  codexLauncher,
  codexHome,
  findTarget,
  isWindows,
  serverEntry,
  targetIds,
  type Creds,
  type McpTarget,
  type Launcher,
  type Scope,
} from "./targets.js";

interface Options {
  scope: Scope;
  print: boolean;
  force: boolean;
  /** Which machine the config is FOR — not always the one running this. See launcherFor. */
  windows: boolean;
  launcher?: Launcher;
  creds: Creds;
}

/**
 * `npx` is safe for this interactive install command, but not as Codex's long-lived stdio parent.
 * npm's npx cache is disposable, so copy the already-resolved runtime (package + dependencies) to
 * a stable Codex-owned directory and return the JavaScript entry Codex should launch with Node.
 */
export async function stageCodexRuntime(
  moduleUrl: string = import.meta.url,
  destinationRoot: string = join(codexHome(), "mcp", "qu4zr"),
): Promise<string> {
  let packageRoot = dirname(fileURLToPath(moduleUrl));
  while (packageRoot !== dirname(packageRoot)) {
    const manifest = join(packageRoot, "package.json");
    try {
      const parsed = JSON.parse(await readFile(manifest, "utf8")) as { name?: string };
      if (parsed.name === "qu4zr-mcp") break;
    } catch { /* keep walking */ }
    packageRoot = dirname(packageRoot);
  }

  const currentEntry = join(packageRoot, "dist", "index.js");
  const sourceNodeModules = dirname(packageRoot);
  const fromNpxCache = normalize(packageRoot).toLowerCase().split(/[\\/]+/).includes("_npx");

  // A global or checked-out package already has a stable path. Copying its whole node_modules tree
  // would be both wasteful and, for a checkout, potentially enormous.
  if (!fromNpxCache || basename(sourceNodeModules) !== "node_modules") return currentEntry;

  const destinationNodeModules = join(destinationRoot, "node_modules");
  if (resolve(sourceNodeModules) !== resolve(destinationNodeModules)) {
    await mkdir(destinationRoot, { recursive: true });
    await cp(sourceNodeModules, destinationNodeModules, { recursive: true, force: true });
  }
  return join(destinationNodeModules, "qu4zr-mcp", "dist", "index.js");
}

const exists = async (path: string) => {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
};

/** Reads flag values out of argv; everything not consumed is left alone. */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

export function usage(): string {
  return [
    "qu4zr-mcp install <client> [options]",
    "",
    `  client        one of: ${targetIds().join(", ")}`,
    "",
    "  --user        write the per-user config (default)",
    "  --project     write the config for the current directory",
    "  --print       print the snippet, write nothing",
    "  --force       replace an existing qu4zr entry",
    "  --windows / --posix   write the launcher for that OS (default: this machine; Codex/Windows must run there)",
    "  --client-id / --client-secret   defaults to QU4ZR_CLIENT_ID / QU4ZR_CLIENT_SECRET",
    "",
    "  Credentials come from Account -> API Access at https://qu4zr.com.",
  ].join("\n");
}

export async function install(argv: string[]): Promise<number> {
  const id = argv.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error(usage());
    return 1;
  }

  const target = findTarget(id);
  if (!target) {
    console.error(`qu4zr-mcp: unknown client "${id}".\n\n${usage()}`);
    return 1;
  }

  const opts: Options = {
    scope: argv.includes("--project") ? "project" : "user",
    print: argv.includes("--print"),
    force: argv.includes("--force"),
    windows: argv.includes("--windows") ? true : argv.includes("--posix") ? false : isWindows(),
    creds: {
      clientId: flag(argv, "client-id") ?? process.env.QU4ZR_CLIENT_ID ?? "igdc_your_client_id",
      clientSecret:
        flag(argv, "client-secret") ?? process.env.QU4ZR_CLIENT_SECRET ?? "igds_your_client_secret",
      baseUrl: flag(argv, "base-url") ?? process.env.QU4ZR_BASE_URL ?? DEFAULT_BASE_URL,
      scopes: flag(argv, "scopes") ?? process.env.QU4ZR_SCOPES ?? DEFAULT_SCOPES,
    },
  };

  const placeholder =
    opts.creds.clientId.startsWith("igdc_your") || opts.creds.clientSecret.startsWith("igds_your");

  if (target.id === "codex" && opts.windows && !isWindows()) {
    console.error(
      "qu4zr-mcp: Codex's Windows launcher contains a stable path on the target machine. Run this\n" +
        "install command on that Windows machine; --windows cannot manufacture its path remotely.",
    );
    return 1;
  }

  // A CLI-registered client has its own command and its own store; writing a file for it would
  // put the server somewhere the CLI does not read. Print the command it wants instead.
  if (target.kind === "cli" && target.command) {
    console.log(`Run this to register qu4zr with ${target.label}:\n`);
    console.log(target.command(opts.creds, opts.windows));
    if (target.note) console.log(`\n${target.note}`);
    if (placeholder) console.log("\nReplace the placeholder credentials — Account -> API Access.");
    return 0;
  }

  const path = target.file?.(opts.scope, process.cwd());
  if (opts.print || !path) {
    if (!path && !opts.print) {
      console.log(
        `${target.label} has no ${opts.scope}-level config this can write. Paste this instead:\n`,
      );
    }
    // A Windows Codex snippet is only useful after the stable runtime exists. `--print` promises
    // not to write anything, so print the one command that performs both steps instead.
    console.log(target.id === "codex" && opts.windows && target.command
      ? target.command(opts.creds, true)
      : target.snippet(opts.creds, opts.windows));
    if (target.note) console.log(`\n${target.note}`);
    return 0;
  }

  if (placeholder) {
    console.error(
      "qu4zr-mcp: no credentials. Pass --client-id / --client-secret, or set QU4ZR_CLIENT_ID and\n" +
        "QU4ZR_CLIENT_SECRET (Account -> API Access). Use --print to see the snippet without them.",
    );
    return 1;
  }

  try {
    if (target.id === "codex" && opts.windows) {
      const entry = await stageCodexRuntime();
      // `--use-system-ca` is not present in every Node version allowed by this package. Detect it
      // instead of guessing: unsupported CLI flags make Node exit before MCP initialize, which
      // would turn the TLS convenience back into another opaque startup failure.
      const useSystemCa = process.allowedNodeEnvironmentFlags.has("--use-system-ca");
      opts.launcher = codexLauncher(entry, process.execPath, useSystemCa);
    }
    const written =
      target.kind === "toml"
        ? await writeToml(path, target, opts)
        : await writeJson(path, target, opts);
    if (!written) return 1;
    if (target.id === "codex" && opts.windows) {
      console.log("qu4zr-mcp: staged a stable Codex runtime");
      if (opts.launcher?.args.includes("--use-system-ca")) {
        console.log("qu4zr-mcp: enabled the Windows trusted certificate store for Node HTTPS");
      }
    }
    console.log(`qu4zr-mcp: wrote the qu4zr server into ${path}`);
    if (target.note) console.log(target.note);
    console.log("Restart " + target.label + " so it picks the server up, then ask it to list your workspaces.");
    return 0;
  } catch (err) {
    console.error(`qu4zr-mcp: could not write ${path}: ${(err as Error).message}`);
    const fallback = target.id === "codex" && opts.windows && target.command
      ? target.command(opts.creds, true)
      : target.snippet(opts.creds, opts.windows);
    console.error(`\nPaste this in by hand instead:\n\n${fallback}`);
    return 1;
  }
}

/** Back up whatever is there before replacing it. Silent on a file that does not exist yet. */
async function backup(path: string): Promise<void> {
  if (!(await exists(path))) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await copyFile(path, `${path}.bak-${stamp}`);
}

async function writeJson(path: string, target: McpTarget, opts: Options): Promise<boolean> {
  const rootKey = target.rootKey ?? "mcpServers";
  let config: Record<string, unknown> = {};

  if (await exists(path)) {
    const raw = await readFile(path, "utf8");
    if (raw.trim()) {
      try {
        config = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Comments, a trailing comma, a half-finished edit — all things a person's real config
        // legitimately contains, and none of them worth losing to an automated rewrite.
        console.error(
          `qu4zr-mcp: ${path} is not valid JSON, so it will not be rewritten (comments and trailing\n` +
            "commas do this). Add this entry by hand:\n",
        );
        console.error(target.snippet(opts.creds, opts.windows));
        return false;
      }
    }
  }

  const servers = (config[rootKey] ??= {}) as Record<string, unknown>;
  if (servers.qu4zr && !opts.force) {
    console.error(
      `qu4zr-mcp: ${path} already has a "qu4zr" server. Re-run with --force to replace it.`,
    );
    return false;
  }

  servers.qu4zr = serverEntry(
    opts.creds,
    target.id === "vscode" ? { type: "stdio" } : undefined,
    opts.windows,
  );

  await backup(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return true;
}

async function writeToml(path: string, target: McpTarget, opts: Options): Promise<boolean> {
  let raw = (await exists(path)) ? await readFile(path, "utf8") : "";

  // Appending is the only safe edit here: rewriting TOML means round-tripping somebody's whole
  // config through a parser that would drop their comments and reorder their tables.
  if (/^\s*\[mcp_servers\.qu4zr\]/m.test(raw) && !opts.force) {
    console.error(
      `qu4zr-mcp: ${path} already has an [mcp_servers.qu4zr] table. Edit it by hand — appending a\n` +
        "second one would give you a file the parser rejects. It should read:\n",
    );
    console.error(target.snippet(opts.creds, opts.windows));
    return false;
  }

  if (opts.force) {
    // Remove the main table and every nested table Codex CLI may have emitted (notably `.env`).
    // Work line-by-line so comments and every unrelated TOML table remain byte-for-byte intact.
    let insideQu4zr = false;
    raw = raw
      .split(/(?<=\n)/)
      .filter((line) => {
        const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?(?:\r?\n)?$/);
        if (header) insideQu4zr = /^mcp_servers\.qu4zr(?:\.|$)/.test(header[1]);
        return !insideQu4zr;
      })
      .join("")
      .replace(/(?:\r?\n){3,}/g, "\n\n")
      .trimEnd();
    if (raw) raw += "\n";
  }

  await backup(path);
  await mkdir(dirname(path), { recursive: true });
  const separator = raw && !raw.endsWith("\n") ? "\n\n" : raw ? "\n" : "";
  await writeFile(path, `${raw}${separator}${target.snippet(opts.creds, opts.windows, opts.launcher)}\n`, "utf8");
  return true;
}
