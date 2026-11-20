import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CommandError } from "./command";
import type { BuildDiagnostic } from "../../build/src/diagnostics";

const builder = fileURLToPath(new URL("../../build/src/build.ts", import.meta.url));
const prefix = "Tokamak build result: ";

type BuildResult = { ok: true; outputFolder?: string } | { ok: false; diagnostics: BuildDiagnostic[] };

export async function runBuilder(folder: string, mode: "--result-json" | "--check-index") {
  const processResult = promisify(execFile)(process.execPath, [builder, mode, folder], {
    maxBuffer: 16 * 1024 * 1024,
  });
  processResult.child.stdin?.end();
  const { stdout, failed } = await processResult.then(
    ({ stdout }) => ({ stdout, failed: false }),
    (error: { stdout?: string }) => ({ stdout: error.stdout ?? "", failed: true }),
  );
  const record = stdout
    .split("\n")
    .reverse()
    .find((line) => line.startsWith(prefix));
  const result: BuildResult | undefined = record ? JSON.parse(record.slice(prefix.length)) : undefined;
  if (result?.ok && !failed) return result;
  throw new CommandError(
    mode === "--result-json" ? "Plugin build failed" : "Could not add plugin",
    mode === "--result-json" ? "tokamak plugin build --help" : "tokamak plugin add --help",
    result?.ok === false ? result.diagnostics : [{ message: "The artifact builder did not return a result" }],
  );
}
