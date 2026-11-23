import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type BuiltManifest = {
  entries: {
    local?: { entry: string; code: string; map: string };
    worker?: { entry: string };
  };
  hashes: Record<string, string>;
};

/** Copy a built plugin for the Server, keeping the manifest bytes and build ID. */
export async function stageServerPlugin(source: string, destination: string) {
  const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8")) as BuiltManifest;
  const { local, worker } = manifest.entries;
  const omitted = new Set([local?.entry, local?.code, local?.map, worker?.entry]);
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination);
  for (const name of [...Object.keys(manifest.hashes), "manifest.json"]) {
    if (omitted.has(name)) continue;
    if (name.split("/").some((part) => !part || part === "." || part === ".." || /[\\:]/.test(part))) {
      throw new Error(`Invalid artifact path: ${name}`);
    }
    const target = join(destination, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, name), target);
  }
}

if (import.meta.main) {
  const [, , source, destination] = process.argv;
  if (!source || !destination) throw new Error("Expected a built plugin directory and a new destination");
  await stageServerPlugin(source, destination);
}
