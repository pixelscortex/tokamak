import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { dataFolder } from "./data";

const name = "plugin-index.json";

export async function readIndex(): Promise<Map<string, string>> {
  const file = join(dataFolder(), name);
  const source = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  });
  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`Invalid plugin index: ${file}`);
  const entries = new Map<string, string>();
  for (const [id, folder] of Object.entries(parsed)) {
    if (typeof folder !== "string" || !isAbsolute(folder))
      throw new Error(`Invalid folder for ${id} in ${file}`);
    entries.set(id, folder);
  }
  return entries;
}

export async function writeIndex(entries: ReadonlyMap<string, string>) {
  const folder = dataFolder();
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const scratch = join(folder, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(scratch, JSON.stringify(Object.fromEntries(entries), null, 2) + "\n", { mode: 0o600 });
    await rename(scratch, join(folder, name));
  } finally {
    await rm(scratch, { force: true });
  }
}
