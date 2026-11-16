/** Public artifact build: maintained compilers, one deterministic publisher. */
import { build } from "vite";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tokamak } from "./vite";

const args = process.argv.slice(2);
if (
  args.length > 2 ||
  (args.length === 2 && args[0] !== "--config") ||
  (args[0] === "--config" && args.length !== 2)
) {
  throw new Error("Expected [plugin folder] or --config <vite.config.ts>");
}
const root = args[0] && args[0] !== "--config" ? resolve(args[0]) : process.cwd();
const config =
  args[0] === "--config"
    ? resolve(args[1]!)
    : existsSync(resolve(root, "vite.config.ts"))
      ? resolve(root, "vite.config.ts")
      : false;
let directory: string | undefined;
const result = await build({
  ...(config ? { configFile: config } : { root, configFile: false }),
  build: { write: false },
  plugins: [
    ...(!config ? [tokamak()] : []),
    {
      name: "tokamak-output",
      configResolved(config) {
        if (config.build.write !== false) throw new Error("Generate all output before publishing");
        directory = resolve(config.root, config.build.outDir);
      },
    },
  ],
});
if (!directory) throw new Error("Artifact output directory was not resolved");
const files = (Array.isArray(result) ? result : [result]).flatMap((output) => {
  if (!("output" in output)) throw new Error("Artifact build does not support watch mode");
  return output.output;
});
// Manifest last; the M1 installer still needs its own complete-artifact staging.
files.sort(
  (a, b) =>
    Number(a.fileName === "manifest.json") - Number(b.fileName === "manifest.json") ||
    a.fileName.localeCompare(b.fileName),
);
let changed = 0;
let unchanged = 0;
for (const file of files) {
  const bytes = Buffer.from(file.type === "chunk" ? file.code : file.source);
  const destination = resolve(directory, file.fileName);
  try {
    if (bytes.equals(await readFile(destination))) {
      unchanged++;
      continue;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  changed++;
}
console.log(`Plugin artifact: ${changed} changed, ${unchanged} unchanged`);
