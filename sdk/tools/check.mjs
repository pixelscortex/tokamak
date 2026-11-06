// Check the QuickJS half independently from tests. Inspect the native checker's
// resolved type dependency graph, not emitted imports: type-only imports and
// triple-slash directives can otherwise grant runtime code host/browser globals.
// Only runtime source and the checker's own ES2022 libraries may enter that graph.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { resolve, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = await realpath(resolve(root, "src"));

function checkedFiles(config) {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "check",
      "--no-script",
      "--no-pretty",
      "--listFilesOnly",
      "--project",
      config,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = new TextDecoder().decode(result.stdout);
  if (result.exitCode !== 0) {
    throw new Error(output + new TextDecoder().decode(result.stderr));
  }
  return output.trim().split(/\r?\n/).filter(Boolean);
}

// Ask the pinned compiler for its exact ES2022 library set. This avoids both a
// handwritten library allowlist and trusting extra libs imported by SDK source.
const temporary = await mkdtemp(join(root, ".check-"));
try {
  const empty = join(temporary, "empty.ts");
  const config = join(temporary, "tsconfig.json");
  await Bun.write(empty, "export {};\n");
  await Bun.write(
    config,
    JSON.stringify({
      compilerOptions: { lib: ["ES2022"], types: [], noEmit: true },
      files: [empty],
    }),
  );

  const libraries = new Set(checkedFiles(config).filter((file) => file !== empty));
  if (libraries.size === 0 || [...libraries].some((file) => !file.startsWith("bundled:///libs/"))) {
    throw new Error("Cannot establish the pinned checker's ES2022 library set");
  }

  for (const file of checkedFiles(resolve(root, "tsconfig.runtime.json"))) {
    if (libraries.has(file)) continue;
    if (!isAbsolute(file) || !(await realpath(file)).startsWith(runtime + sep)) {
      throw new Error(
        `Runtime type dependencies must stay inside sdk/src or ES2022 libraries: ${file}`,
      );
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

// --listFilesOnly discovers dependencies without checking their bodies. Both
// programs still need the ordinary check; test ambient types never join src's.
for (const config of ["tsconfig.runtime.json", "tsconfig.json"]) {
  const result = Bun.spawnSync(
    [process.execPath, "check", "--no-script", "--project", resolve(root, config)],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}
