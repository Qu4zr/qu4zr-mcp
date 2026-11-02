import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";

export type RunnerLaunchResult =
  | { ok: true; pid: number }
  | { ok: false; code: string; exitCode?: number | null; signal?: string | null };

/** Launch the built application itself, with no terminal or `dotnet run` parent to keep alive. */
export async function launchDetached(
  executable: string,
  args: string[],
  options: { cwd: string; logFile: string; startupWaitMs?: number },
): Promise<RunnerLaunchResult> {
  const record = (message: string) => {
    // Never record argv: it contains the one-time onboarding credential.
    try { appendFileSync(options.logFile, `${new Date().toISOString()} [launcher] ${message}\n`); }
    catch { /* Losing a diagnostic must not terminate a running application. */ }
  };

  let log: number;
  try {
    log = openSync(options.logFile, "a");
  } catch {
    return { ok: false, code: "runner_log_unavailable" };
  }

  try {
    record("Starting runner.");
    return await new Promise<RunnerLaunchResult>((resolve) => {
      const child = spawn(executable, args, {
        cwd: options.cwd,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log, log],
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: RunnerLaunchResult) => {
        clearTimeout(timer);
        child.unref();
        resolve(result);
      };
      child.once("error", (error: NodeJS.ErrnoException) => {
        record(`Runner launch failed (${error.code ?? "unknown"}).`);
        finish({ ok: false, code: "runner_launch_failed" });
      });
      child.once("exit", (exitCode, signal) => {
        record(`Runner ${child.pid} exited (code=${exitCode}, signal=${signal ?? "none"}).`);
        finish({ ok: false, code: "runner_exited_during_startup", exitCode, signal });
      });
      child.once("spawn", () => {
        record(`Runner started (pid=${child.pid}).`);
        timer = setTimeout(() => finish({ ok: true, pid: child.pid! }), options.startupWaitMs ?? 1500);
      });
    });
  } catch {
    record("Runner launch failed.");
    return { ok: false, code: "runner_launch_failed" };
  } finally {
    // The child owns inherited copies. Keeping ours open leaked a descriptor on every setup.
    closeSync(log);
  }
}
