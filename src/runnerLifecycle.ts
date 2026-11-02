import { createHash } from "node:crypto";

export interface RunnerPackageManifestFile {
  path: string;
  sha256: string;
}

export interface RunnerPackageManifest {
  schemaVersion: number;
  packageVersion: string;
  files: RunnerPackageManifestFile[];
}

export interface DownloadedRunnerPackage {
  projectName: string;
  package?: { schemaVersion: number; version: string };
  files: Record<string, string>;
}

export type RunnerBuildFailureCode =
  | "dotnet_sdk_not_found"
  | "runner_generated_plumbing_compile_failed"
  | "runner_handler_compile_failed"
  | "runner_build_failed";

export interface RunnerBuildFailure {
  code: RunnerBuildFailureCode;
  message: string;
}

const MANIFEST_PATH = "_internal/package-manifest.json";

/** Manifest contract versions this client knows how to verify. */
export const SUPPORTED_MANIFEST_SCHEMA_VERSIONS: readonly number[] = [1];

/**
 * An integrity failure carrying a stable `code` plus a `detail` a user can act on. The code alone
 * ("unsupported") could not say which version was seen and which was expected, so every server/client
 * skew looked identical from the client machine.
 */
export class RunnerPackageIntegrityError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "RunnerPackageIntegrityError";
  }
}

function fail(code: string, detail?: string): never {
  throw new RunnerPackageIntegrityError(code, detail);
}

/**
 * Reads a manifest field by name, ignoring case. The server serializes the manifest from a C# record,
 * so its serializer naming policy decides whether the keys arrive as `schemaVersion` or `SchemaVersion`;
 * the PowerShell artifact builder has always read them case-insensitively and never saw the difference.
 */
function field(source: unknown, name: string): unknown {
  if (!source || typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;
  if (name in record) return record[name];
  const lowered = name.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === lowered) return record[key];
  }
  return undefined;
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0 &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path.includes(":") &&
    path.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

export function validateRunnerPackage(pkg: DownloadedRunnerPackage): RunnerPackageManifest {
  const rawManifest = pkg.files?.[MANIFEST_PATH];
  if (!rawManifest) {
    fail("runner_package_manifest_missing", `the package has no ${MANIFEST_PATH}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest);
  } catch {
    fail("runner_package_manifest_invalid", `${MANIFEST_PATH} is not valid JSON`);
  }

  const schemaVersion = field(parsed, "schemaVersion");
  const packageVersion = field(parsed, "packageVersion");
  const rawFiles = field(parsed, "files");
  const supported = SUPPORTED_MANIFEST_SCHEMA_VERSIONS.join(", ");

  if (typeof schemaVersion !== "number" || !SUPPORTED_MANIFEST_SCHEMA_VERSIONS.includes(schemaVersion)) {
    const keys = Object.keys((parsed ?? {}) as object).join(", ") || "none";
    fail(
      "runner_package_manifest_unsupported",
      schemaVersion === undefined
        ? `the manifest declared no schemaVersion (keys served: ${keys}); this client supports ${supported}. ` +
          "The server is emitting a different manifest shape than the documented one."
        : `the server served schemaVersion ${JSON.stringify(schemaVersion)}; this client supports ${supported}. ` +
          "Upgrade qu4zr-mcp, or roll the server back to a manifest this client can verify.",
    );
  }
  if (typeof packageVersion !== "string" || packageVersion === "") {
    fail("runner_package_manifest_invalid", "the manifest declares no packageVersion");
  }
  if (!Array.isArray(rawFiles)) {
    fail("runner_package_manifest_invalid", "the manifest declares no files array");
  }

  const manifest: RunnerPackageManifest = {
    schemaVersion,
    packageVersion,
    files: rawFiles.map(entry => ({
      path: field(entry, "path") as string,
      sha256: field(entry, "sha256") as string,
    })),
  };

  const envelopeSchema = field(pkg.package, "schemaVersion");
  const envelopeVersion = field(pkg.package, "version");
  if (pkg.package && (envelopeSchema !== manifest.schemaVersion || envelopeVersion !== manifest.packageVersion)) {
    fail(
      "runner_package_metadata_mismatch",
      `the download envelope announced schemaVersion ${JSON.stringify(envelopeSchema ?? null)} / version ` +
        `${JSON.stringify(envelopeVersion ?? null)}, the manifest declares ${manifest.schemaVersion} / ` +
        `${JSON.stringify(manifest.packageVersion)}`,
    );
  }

  const declared = new Set<string>();
  for (const file of manifest.files) {
    if (typeof file?.path !== "string" || !isSafeRelativePath(file.path)) {
      fail("runner_package_manifest_invalid", `unusable path in the manifest: ${JSON.stringify(file?.path ?? null)}`);
    }
    if (typeof file.sha256 !== "string" || !/^[a-f\d]{64}$/i.test(file.sha256)) {
      fail("runner_package_manifest_invalid", `${file.path} declares no usable sha256`);
    }
    if (declared.has(file.path)) {
      fail("runner_package_manifest_invalid", `${file.path} is declared twice`);
    }
    declared.add(file.path);

    const content = pkg.files[file.path];
    if (content === undefined) {
      fail(`runner_package_file_missing:${file.path}`, `the manifest declares ${file.path} but the download omitted it`);
    }
    const actual = createHash("sha256").update(content, "utf8").digest("hex");
    if (actual !== file.sha256.toLowerCase()) {
      fail(`runner_package_hash_mismatch:${file.path}`, `expected ${file.sha256.toLowerCase()}, got ${actual}`);
    }
  }

  const payloadPaths = Object.keys(pkg.files).filter(path => path !== MANIFEST_PATH);
  const undeclared = payloadPaths.filter(path => !isSafeRelativePath(path) || !declared.has(path));
  if (undeclared.length > 0 || declared.size !== payloadPaths.length) {
    fail(
      "runner_package_manifest_incomplete",
      undeclared.length > 0
        ? `files the manifest does not cover: ${undeclared.join(", ")}`
        : `the manifest declares ${declared.size} files, the download carries ${payloadPaths.length}`,
    );
  }

  return manifest;
}

export function classifyRunnerBuildFailure(output: string, executableMissing = false): RunnerBuildFailure {
  if (executableMissing) {
    return {
      code: "dotnet_sdk_not_found",
      message: "The .NET SDK ('dotnet') was not found on PATH. Install .NET 8 SDK, then retry.",
    };
  }

  if (/(?:^|[\\/])_internal[\\/].+\.(?:cs|csproj)\b/im.test(output)) {
    return {
      code: "runner_generated_plumbing_compile_failed",
      message: "Generated runner plumbing did not compile. Do not edit _internal; report the package version and compiler output.",
    };
  }

  if (/(?:^|[\\/])Handler\.cs\b/im.test(output)) {
    return {
      code: "runner_handler_compile_failed",
      message: "Handler.cs did not compile. Fix the saved handler and retry.",
    };
  }

  return {
    code: "runner_build_failed",
    message: "The runner build failed. Inspect the compiler output before changing the handler.",
  };
}

/** Preserve machine-local values while accepting new generated non-secret settings. */
export function mergeRunnerAppSettings(generated: string, existing?: string): string {
  const next = JSON.parse(generated) as Record<string, unknown>;
  if (!existing) return `${JSON.stringify(next, null, 2)}\n`;

  try {
    const current = JSON.parse(existing) as Record<string, unknown>;
    if (current.Local && typeof current.Local === "object" && !Array.isArray(current.Local)) {
      next.Local = current.Local;
    }
  } catch {
    throw new Error("runner_local_config_invalid");
  }

  return `${JSON.stringify(next, null, 2)}\n`;
}
