import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CommandError } from "./command";
import { acquireLock } from "./plugin-index";
import type { BuildDiagnostic } from "../../build/src/diagnostics";

const builder = fileURLToPath(new URL("../../build/src/build.ts", import.meta.url));
const prefix = "Tokamak build result: ";

type BuildResult = { ok: true; outputFolder?: string } | { ok: false; diagnostics: BuildDiagnostic[] };

export async function runBuilder(
  folder: string,
  mode: "--result-json" | "--check-index",
  next = mode === "--result-json" ? "tokamak plugin build --help" : "tokamak plugin add --help",
) {
  const processResult = promisify(execFile)(process.execPath, [builder, mode, resolve(folder)], {
    maxBuffer: 16 * 1024 * 1024,
  });
  processResult.child.stdin?.end();
  const { stdout, stderr, failed } = await processResult.then(
    ({ stdout, stderr }) => ({ stdout, stderr, failed: false }),
    (error: { stdout?: string; stderr?: string }) => ({
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      failed: true,
    }),
  );
  if (stderr) process.stderr.write(stderr);
  const record = stdout
    .split("\n")
    .reverse()
    .find((line) => line.startsWith(prefix));
  const result: BuildResult | undefined = record ? JSON.parse(record.slice(prefix.length)) : undefined;
  if (result?.ok && !failed)
    return {
      ...result,
      warnings: [...stderr.matchAll(/^Warning: (.+)$/gm)].map((match) => match[1]!),
    };
  throw new CommandError(
    mode === "--result-json" ? "Plugin build failed" : "Could not add plugin",
    next,
    result?.ok === false ? result.diagnostics : [{ message: "The artifact builder did not return a result" }],
  );
}

export async function withBuildLock<T>(folder: string | undefined, work: (root: string) => Promise<T>) {
  const absolute = resolve(folder ?? ".");
  const root = await realpath(absolute).catch(() => absolute);
  // Let the builder report missing folders using its structured diagnostics.
  const release = await acquireLock(root, ".tokamak-build").catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  try {
    return await work(root);
  } finally {
    await release?.();
  }
}
