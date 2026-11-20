import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { acquireLock, codeOf } from "./lock";
import { processIsAlive } from "./process";
import { dataFolder } from "./data";

const name = "plugin-index.json";

async function readIndex(folder: string): Promise<Map<string, string>> {
  const file = join(folder, name);
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

async function writeIndex(folder: string, entries: ReadonlyMap<string, string>) {
  const scratch = join(folder, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(scratch, JSON.stringify(Object.fromEntries(entries), null, 2) + "\n", { mode: 0o600 });
    await rename(scratch, join(folder, name));
  } finally {
    await rm(scratch, { force: true });
  }
}

async function removeEmptyLock(lock: string) {
  await rmdir(lock).catch((error: unknown) => {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(codeOf(error) ?? "")) throw error;
  });
}

async function reapLock(lock: string) {
  const owners = await readdir(lock).catch((error: unknown) => {
    if (codeOf(error) === "ENOENT") return [];
    throw error;
  });
  for (const owner of owners) {
    const match = /^(\d+)\./.exec(owner);
    if (match && !processIsAlive(Number(match[1]))) await rm(join(lock, owner), { force: true });
  }
  await removeEmptyLock(lock);
}

export async function updateIndex(change: (entries: Map<string, string>) => boolean) {
  const folder = dataFolder();
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const lock = join(folder, `${name}.lock`);
  const owner = `${process.pid}.${randomUUID()}`;
  const candidate = await mkdtemp(join(folder, `.${name}.lock-`));
  let acquired = false;
  try {
    // Publish a nonempty lock atomically. A reaper can unlink only the dead
    // owner's uniquely named file, and cannot remove a new owner's directory.
    await writeFile(join(candidate, owner), "", { flag: "wx", mode: 0o600 });
    await acquireLock(
      () => rename(candidate, lock),
      15_000,
      async (error) => {
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(codeOf(error) ?? "")) throw error;
        await reapLock(lock);
      },
      `plugin index lock: ${lock}`,
    );
    acquired = true;
    const entries = await readIndex(folder);
    if (change(entries)) await writeIndex(folder, entries);
  } finally {
    const directory = acquired ? lock : candidate;
    await rm(join(directory, owner), { force: true });
    await removeEmptyLock(directory);
  }
}
