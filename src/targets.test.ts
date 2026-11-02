import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  TARGETS,
  codexLauncher,
  envFor,
  findTarget,
  launchCommand,
  launcherFor,
  serverEntry,
  DEFAULT_BASE_URL,
  DEFAULT_SCOPES,
} from "./targets.js";
import { install, stageCodexRuntime } from "./install.js";

const creds = { clientId: "igdc_test", clientSecret: "igds_test" };

// ---- the table --------------------------------------------------------------

test("every target's snippet is valid in its own format", () => {
  for (const target of TARGETS) {
    const snippet = target.snippet(creds);
    if (target.kind === "toml") {
      assert.match(snippet, /^\[mcp_servers\.qu4zr\]/m, `${target.id} should declare a TOML table`);
    } else {
      assert.doesNotThrow(() => JSON.parse(snippet), `${target.id} should emit parseable JSON`);
    }
  }
});

// The whole reason this table exists. A `mcpServers` block in .vscode/mcp.json saves cleanly,
// loads nothing and reports nothing, which is indistinguishable from the server being broken.
test("VS Code gets `servers` and a stdio type; everyone else gets `mcpServers` and neither", () => {
  const vscode = JSON.parse(findTarget("vscode")!.snippet(creds));
  assert.ok(vscode.servers?.qu4zr, "VS Code's root key is `servers`");
  assert.equal(vscode.mcpServers, undefined);
  assert.equal(vscode.servers.qu4zr.type, "stdio");

  for (const target of TARGETS.filter((t) => t.kind === "json" && t.id !== "vscode")) {
    const config = JSON.parse(target.snippet(creds));
    assert.ok(config.mcpServers?.qu4zr, `${target.id} should use mcpServers`);
    assert.equal(config.mcpServers.qu4zr.type, undefined, `${target.id} should not carry a type`);
  }
});

// A wrapped command is unpasteable on Windows, where the continuation character is not `\`.
test("registration commands are one line and carry both credentials", () => {
  for (const target of TARGETS.filter((t) => t.command)) {
    const command = target.command!(creds);
    assert.ok(!command.includes("\n"), `${target.id}'s command must not wrap`);
    const codexInstaller = target.id === "codex" && command.includes(" install codex ");
    assert.match(command, codexInstaller ? /--client-id igdc_test/ : /QU4ZR_CLIENT_ID=igdc_test/);
    assert.match(command, codexInstaller ? /--client-secret igds_test/ : /QU4ZR_CLIENT_SECRET=igds_test/);
    assert.match(command, /qu4zr-mcp/);
  }
});

test("target ids are unique and resolve case-insensitively", () => {
  const ids = TARGETS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(findTarget("VSCode")?.id, "vscode");
  assert.equal(findTarget("Agy")?.id, "agy");
  assert.equal(findTarget("gemini")?.id, "agy", "the retired Gemini name remains a hidden alias");
  assert.equal(findTarget("nope"), undefined);
});

// Defaults belong in the package, not in ten thousand copies of a config file: a base URL pinned
// into everyone's config is a base URL that cannot be moved.
test("env carries the defaults only when they have been overridden", () => {
  assert.deepEqual(envFor(creds, false), {
    QU4ZR_CLIENT_ID: "igdc_test",
    QU4ZR_CLIENT_SECRET: "igds_test",
  });

  assert.deepEqual(envFor(creds, true), {
    QU4ZR_CLIENT_ID: "igdc_test",
    QU4ZR_CLIENT_SECRET: "igds_test",
    NODE_USE_SYSTEM_CA: "1",
  });

  const custom = envFor({ ...creds, baseUrl: "https://staging.example", scopes: "flows:read" }, false);
  assert.equal(custom.QU4ZR_BASE_URL, "https://staging.example");
  assert.equal(custom.QU4ZR_SCOPES, "flows:read");

  const defaults = envFor({ ...creds, baseUrl: DEFAULT_BASE_URL, scopes: DEFAULT_SCOPES }, false);
  assert.equal(defaults.QU4ZR_BASE_URL, undefined);
  assert.equal(defaults.QU4ZR_SCOPES, undefined);
});

test("the server entry runs through npx, so nothing has to be installed first", () => {
  const entry = serverEntry(creds, undefined, false) as { command: string; args: string[] };
  assert.equal(entry.command, "npx");
  assert.deepEqual(entry.args, ["-y", "qu4zr-mcp"]);
});

// The failure this was written for: `npx` on Windows is an extensionless shell script, so a client
// that spawns the command directly cannot start it — and reports that as a startup TIMEOUT, which
// sends people to raise a timeout that was never the problem. Measured on Codex 0.149.1.
test("Windows file-based clients use cmd, while Codex installs a direct Node launcher", () => {
  assert.deepEqual(launcherFor(true), { command: "cmd", args: ["/c", "npx", "-y", "qu4zr-mcp"] });
  assert.deepEqual(launcherFor(false), { command: "npx", args: ["-y", "qu4zr-mcp"] });
  assert.equal(launchCommand(true), "cmd /c npx -y qu4zr-mcp");
  assert.equal(launchCommand(false), "npx -y qu4zr-mcp");

  for (const target of TARGETS.filter((t) => t.id !== "codex")) {
    const windows = target.snippet(creds, true);
    const posix = target.snippet(creds, false);

    assert.match(windows, /cmd/, `${target.id}'s Windows snippet must launch through cmd`);
    assert.match(windows, /NODE_USE_SYSTEM_CA/, `${target.id}'s Windows snippet must trust Windows roots`);
    assert.ok(!/"command":\s*"npx"/.test(windows), `${target.id} still spawns npx directly on Windows`);
    assert.ok(!/\bcmd\b/.test(posix), `${target.id}'s POSIX snippet must not drag cmd in`);
    assert.ok(!/NODE_USE_SYSTEM_CA/.test(posix), `${target.id}'s POSIX snippet must not claim Windows roots`);

    if (target.command) {
      assert.match(target.command(creds, true), /cmd \/c npx -y qu4zr-mcp/, `${target.id} command`);
      assert.ok(!/\bcmd\b/.test(target.command(creds, false)), `${target.id} POSIX command`);
    }
  }


  const codex = findTarget("codex")!;
  assert.match(codex.command!(creds, true), /^npx -y qu4zr-mcp install codex --windows /);
  assert.match(codex.command!(creds, false), /^codex mcp add qu4zr /);
  const direct = codex.snippet(
    creds,
    true,
    codexLauncher("C:\\stable\\qu4zr\\dist\\index.js", "C:\\Node\\node.exe", true),
  );
  assert.match(direct, /command = "C:\\\\Node\\\\node\.exe"/);
  assert.match(direct, /args = \["--use-system-ca",/);
  assert.match(direct, /"NODE_USE_SYSTEM_CA" = "1"/);
  assert.match(direct, /C:\\\\stable\\\\qu4zr\\\\dist\\\\index\.js/);
  assert.ok(!direct.includes("npx"));
});

test("the Codex launcher only enables the Windows CA store when the running Node supports it", () => {
  assert.deepEqual(codexLauncher("C:\\stable\\index.js", "C:\\Node\\node.exe", true), {
    command: "C:\\Node\\node.exe",
    args: ["--use-system-ca", "C:\\stable\\index.js"],
  });
  assert.deepEqual(codexLauncher("C:\\stable\\index.js", "C:\\Node18\\node.exe", false), {
    command: "C:\\Node18\\node.exe",
    args: ["C:\\stable\\index.js"],
  });
});

// A shape check, because the array form is what actually lands in a config file and the string form
// ("cmd", "/c", "npx -y qu4zr-mcp") is a different thing that a client may or may not quote right.
test("the Windows launcher passes npx and its flags as separate arguments", () => {
  const entry = serverEntry(creds, undefined, true) as { command: string; args: string[] };
  assert.equal(entry.command, "cmd");
  assert.deepEqual(entry.args, ["/c", "npx", "-y", "qu4zr-mcp"]);
});

test("the direct Codex launcher receives initialize immediately over stdio", async () => {
  await inTempDir(async (dir) => {
    const fixture = join(dir, "stdio-fixture.mjs");
    await writeFile(
      fixture,
      "let s='';process.stdin.on('data',c=>{s+=c;const i=s.indexOf('\\n');if(i<0)return;const m=JSON.parse(s.slice(0,i));process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{serverInfo:{name:'fixture'}}})+'\\n')});",
      "utf8",
    );
    const launcher = codexLauncher(fixture);
    const child = spawn(launcher.command, launcher.args, { stdio: ["pipe", "pipe", "pipe"] });
    const result = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("initialize timed out")), 3_000);
      child.stdout.once("data", (chunk) => {
        clearTimeout(timer);
        resolve(String(chunk));
      });
      child.once("error", reject);
    });
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    assert.equal(JSON.parse(await result).result.serverInfo.name, "fixture");
    child.kill();
  });
});

test("an npx runtime is copied to Codex-owned stable storage", async () => {
  await inTempDir(async (dir) => {
    const packageRoot = join(dir, "_npx", "hash", "node_modules", "qu4zr-mcp");
    const sourceEntry = join(packageRoot, "dist", "index.js");
    const destination = join(dir, "stable");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), '{"name":"qu4zr-mcp"}', "utf8");
    await writeFile(sourceEntry, "// server", "utf8");

    const entry = await stageCodexRuntime(pathToFileURL(join(packageRoot, "dist", "install.js")).href, destination);
    assert.equal(entry, join(destination, "node_modules", "qu4zr-mcp", "dist", "index.js"));
    assert.equal(await readFile(entry, "utf8"), "// server");
  });
});

// ---- install ----------------------------------------------------------------

/** Runs install() in a throwaway directory with the console muted. */
async function inTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "qu4zr-install-"));
  const cwd = process.cwd();
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    process.chdir(dir);
    return await body(dir);
  } finally {
    process.chdir(cwd);
    console.log = log;
    console.error = error;
  }
}

const args = ["--project", "--client-id", "igdc_test", "--client-secret", "igds_test"];

test("install merges into an existing config instead of replacing it, and backs it up first", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, ".vscode", "mcp.json");
    await mkdir(join(dir, ".vscode"));
    await writeFile(path, JSON.stringify({ servers: { other: { command: "foo" } } }), "utf8");

    assert.equal(await install(["vscode", ...args]), 0);

    const config = JSON.parse(await readFile(path, "utf8"));
    assert.ok(config.servers.other, "the server that was already there must survive");
    assert.equal(config.servers.qu4zr.env.QU4ZR_CLIENT_ID, "igdc_test");

    const backups = (await readdir(join(dir, ".vscode"))).filter((f) => f.includes(".bak-"));
    assert.equal(backups.length, 1, "the original should have been copied aside");
  });
});

test("install refuses to overwrite an existing qu4zr entry without --force", async () => {
  await inTempDir(async (dir) => {
    assert.equal(await install(["vscode", ...args]), 0);
    assert.equal(await install(["vscode", ...args]), 1);

    assert.equal(await install(["vscode", ...args, "--force"]), 0);
  });
});

test("Codex --force replaces its main and nested TOML tables with a direct Node launcher", { skip: process.platform !== "win32" }, async () => {
  await inTempDir(async (dir) => {
    const oldHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(dir, ".codex");
    try {
      const path = join(process.env.CODEX_HOME, "config.toml");
      await mkdir(process.env.CODEX_HOME, { recursive: true });
      await writeFile(
        path,
        '[projects."keep"]\ntrust_level = "trusted"\n\n[mcp_servers.qu4zr]\ncommand = "cmd"\nargs = ["/c", "npx"]\n\n[mcp_servers.qu4zr.env]\nQU4ZR_CLIENT_ID = "old"\n',
        "utf8",
      );

      assert.equal(await install(["codex", "--windows", "--force", "--client-id", "igdc_test", "--client-secret", "igds_test"]), 0);
      const config = await readFile(path, "utf8");
      assert.match(config, /\[projects\."keep"\]/);
      assert.equal((config.match(/\[mcp_servers\.qu4zr\]/g) ?? []).length, 1);
      assert.doesNotMatch(config, /mcp_servers\.qu4zr\.env/);
      assert.match(config, new RegExp(`command = ${JSON.stringify(process.execPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      if (process.allowedNodeEnvironmentFlags.has("--use-system-ca")) {
        assert.match(config, /args = \["--use-system-ca",/);
      }
      assert.doesNotMatch(config, /command = "cmd"|"npx"/);
      assert.match(config, /"QU4ZR_CLIENT_ID" = "igdc_test"/);
    } finally {
      if (oldHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldHome;
    }
  });
});

// Real configs contain comments and trailing commas. Rewriting one through JSON.parse would
// silently delete them; refusing costs the user a paste and nothing else.
test("install leaves a config it cannot parse alone", async () => {
  await inTempDir(async (dir) => {
    const path = join(dir, ".vscode", "mcp.json");
    await mkdir(join(dir, ".vscode"));
    const original = '{ // my notes\n  "servers": {}\n}';
    await writeFile(path, original, "utf8");

    assert.equal(await install(["vscode", ...args]), 1);
    assert.equal(await readFile(path, "utf8"), original);
  });
});

test("install writes nothing for --print", async () => {
  await inTempDir(async (dir) => {
    assert.equal(await install(["vscode", ...args, "--print"]), 0);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("install refuses to write placeholder credentials into a config", async () => {
  await inTempDir(async (dir) => {
    assert.equal(await install(["vscode", "--project"]), 1);
    assert.deepEqual(await readdir(dir), []);
  });
});
