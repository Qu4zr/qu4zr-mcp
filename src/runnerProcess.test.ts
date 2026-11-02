import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchDetached } from "./runnerProcess.js";

// A runner that died a few seconds after setup_runner answered left nothing behind: the reply said
// "launching", and runner.log stayed empty. These cover the two things the launcher must now say.

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "qu4zr-runner-"));
  // Best effort: on Windows a runner that was just killed still holds its inherited handle on
  // runner.log for a moment. A leftover folder under the temp directory is not a test failure.
  const done = () => {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* left to the OS */ }
  };
  return { dir, logFile: join(dir, "runner.log"), done };
}

test("a runner that exits during startup is reported, not announced as running", async () => {
  const s = scratch();
  try {
    const result = await launchDetached(process.execPath, ["-e", "console.error('boom'); process.exit(3)"], {
      cwd: s.dir, logFile: s.logFile, startupWaitMs: 5_000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "runner_exited_during_startup");
    assert.equal(result.ok === false && result.exitCode, 3);

    const log = readFileSync(s.logFile, "utf8");
    assert.match(log, /\[launcher\] Runner \d+ exited \(code=3/);
    assert.match(log, /boom/, "the runner's own stderr lands in runner.log");
  } finally {
    s.done();
  }
});

test("a runner that stays up is returned with its own pid", async () => {
  const s = scratch();
  let pid: number | undefined;
  try {
    const result = await launchDetached(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
      cwd: s.dir, logFile: s.logFile, startupWaitMs: 300,
    });

    assert.equal(result.ok, true);
    pid = result.ok ? result.pid : undefined;
    assert.ok(pid && pid > 0);
    assert.doesNotThrow(() => process.kill(pid!, 0), "the pid is the runner's, and it is alive");
    assert.match(readFileSync(s.logFile, "utf8"), /\[launcher\] Runner started \(pid=\d+\)/);
  } finally {
    if (pid) {
      try { process.kill(pid); } catch { /* already gone */ }
      for (let i = 0; i < 50; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    s.done();
  }
});

test("the launcher never writes the command line, which carries the onboarding code", async () => {
  const s = scratch();
  try {
    await launchDetached(process.execPath, ["-e", "process.exit(0)", "--onboard", "ONBOARD-SECRET-123"], {
      cwd: s.dir, logFile: s.logFile, startupWaitMs: 5_000,
    });

    assert.doesNotMatch(readFileSync(s.logFile, "utf8"), /ONBOARD-SECRET-123/);
  } finally {
    s.done();
  }
});

test("an executable that cannot start is reported as a launch failure", async () => {
  const s = scratch();
  try {
    const result = await launchDetached(join(s.dir, "does-not-exist.exe"), [], {
      cwd: s.dir, logFile: s.logFile, startupWaitMs: 5_000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "runner_launch_failed");
  } finally {
    s.done();
  }
});
