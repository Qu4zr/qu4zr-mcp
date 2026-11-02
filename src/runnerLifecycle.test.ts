import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  classifyRunnerBuildFailure,
  mergeRunnerAppSettings,
  validateRunnerPackage,
  RunnerPackageIntegrityError,
  type DownloadedRunnerPackage,
} from "./runnerLifecycle.js";

function packageWith(files: Record<string, string>): DownloadedRunnerPackage {
  const manifest = {
    schemaVersion: 1,
    packageVersion: "1.0.0",
    files: Object.entries(files).map(([path, content]) => ({
      path,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    })),
  };
  return {
    projectName: "Runner",
    package: { schemaVersion: 1, version: "1.0.0" },
    files: { ...files, "_internal/package-manifest.json": JSON.stringify(manifest) },
  };
}

/**
 * The shape a C# record serialized with the .NET defaults produces. Every earlier test in this file
 * hand-rolled a camelCase manifest, so nothing here ever exercised what the server actually served —
 * and a PascalCase manifest failed as `runner_package_manifest_unsupported` in production.
 */
function pascalCasePackageWith(files: Record<string, string>): DownloadedRunnerPackage {
  const manifest = {
    SchemaVersion: 1,
    PackageVersion: "1.0.0",
    Files: Object.entries(files).map(([path, content]) => ({
      Path: path,
      Sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    })),
  };
  return {
    projectName: "Runner",
    package: { schemaVersion: 1, version: "1.0.0" },
    files: { ...files, "_internal/package-manifest.json": JSON.stringify(manifest) },
  };
}

function caught(act: () => unknown): RunnerPackageIntegrityError {
  try {
    act();
  } catch (error) {
    assert.ok(error instanceof RunnerPackageIntegrityError, `expected an integrity error, got ${error}`);
    return error;
  }
  throw new Error("expected validateRunnerPackage to throw");
}

test("valid package matches every declared hash", () => {
  const manifest = validateRunnerPackage(packageWith({ "Handler.cs": "return 1;", "Runner.csproj": "<Project />" }));
  assert.equal(manifest.packageVersion, "1.0.0");
});

test("changed payload is rejected before it is written or built", () => {
  const pkg = packageWith({ "Handler.cs": "safe" });
  pkg.files["Handler.cs"] = "tampered";
  assert.throws(() => validateRunnerPackage(pkg), /runner_package_hash_mismatch:Handler\.cs/);
});

test("undeclared payload is rejected", () => {
  const pkg = packageWith({ "Handler.cs": "safe" });
  pkg.files["surprise.cs"] = "unexpected";
  assert.throws(() => validateRunnerPackage(pkg), /runner_package_manifest_incomplete/);
});

test("paths cannot escape the per-runner directory", () => {
  const pkg = packageWith({ "../outside.cs": "unexpected" });
  assert.throws(() => validateRunnerPackage(pkg), /runner_package_manifest_invalid/);
});

test("a manifest keyed the way the server serializes it is still verified", () => {
  const manifest = validateRunnerPackage(
    pascalCasePackageWith({ "Handler.cs": "return 1;", "Runner.csproj": "<Project />" }),
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.packageVersion, "1.0.0");
  assert.equal(manifest.files.length, 2);
});

test("tampering is still caught in a server-shaped manifest", () => {
  const pkg = pascalCasePackageWith({ "Handler.cs": "safe" });
  pkg.files["Handler.cs"] = "tampered";
  assert.throws(() => validateRunnerPackage(pkg), /runner_package_hash_mismatch:Handler\.cs/);
});

test("an unsupported schema version names what was served and what is supported", () => {
  const pkg = packageWith({ "Handler.cs": "return 1;" });
  const manifest = JSON.parse(pkg.files["_internal/package-manifest.json"]) as Record<string, unknown>;
  manifest.schemaVersion = 2;
  pkg.files["_internal/package-manifest.json"] = JSON.stringify(manifest);
  pkg.package = { schemaVersion: 2, version: "1.0.0" };

  const error = caught(() => validateRunnerPackage(pkg));
  assert.equal(error.code, "runner_package_manifest_unsupported");
  assert.match(error.detail ?? "", /served schemaVersion 2/);
  assert.match(error.detail ?? "", /this client supports 1/);
});

test("a manifest with no schema version at all reports the keys it did carry", () => {
  const pkg = packageWith({ "Handler.cs": "return 1;" });
  pkg.files["_internal/package-manifest.json"] = JSON.stringify({ packageVersion: "1.0.0", files: [] });

  const error = caught(() => validateRunnerPackage(pkg));
  assert.equal(error.code, "runner_package_manifest_unsupported");
  assert.match(error.detail ?? "", /keys served: packageVersion, files/);
});

test("build failures distinguish generated plumbing from user handlers", () => {
  assert.equal(
    classifyRunnerBuildFailure("C:\\runner\\_internal\\SignalR\\ReconnectLoop.cs(1): error").code,
    "runner_generated_plumbing_compile_failed",
  );
  assert.equal(
    classifyRunnerBuildFailure("C:\\runner\\Handler.cs(4): error").code,
    "runner_handler_compile_failed",
  );
  assert.equal(classifyRunnerBuildFailure("restore failed").code, "runner_build_failed");
  assert.equal(classifyRunnerBuildFailure("", true).code, "dotnet_sdk_not_found");
});

test("regeneration preserves Local secrets and refreshes generated settings", () => {
  const merged = JSON.parse(mergeRunnerAppSettings(
    '{"DashboardUrl":"new","Local":{}}',
    '{"DashboardUrl":"old","Local":{"vlcPassword":"secret"}}',
  ));
  assert.equal(merged.DashboardUrl, "new");
  assert.deepEqual(merged.Local, { vlcPassword: "secret" });
});

test("invalid existing local configuration is never silently overwritten", () => {
  assert.throws(
    () => mergeRunnerAppSettings('{"Local":{}}', "not-json"),
    /runner_local_config_invalid/,
  );
});
