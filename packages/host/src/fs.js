import fs from "tokamak:fs";
import * as native from "tokamak:fs-extra";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
export * from "tokamak:fs";

const path = (value) => (value instanceof URL ? fileURLToPath(value) : String(value));
export const realpath = (value) => native.realpath(path(value));
export const unlink = (value) => native.unlink(path(value));

export async function cp(
  source,
  destination,
  { recursive = false, force = true, errorOnExist = false, preserveTimestamps = false } = {},
) {
  const from = await realpath(source);
  const to = resolve(path(destination));
  const prefix = from.endsWith(sep) ? from : from + sep;
  function checkDestination(path) {
    if (from === path || path.startsWith(prefix)) throw new Error("Cannot copy a path into itself");
  }
  checkDestination(to);

  async function copy(from, to) {
    const info = await fs.lstat(from);
    if (info.isDirectory()) {
      if (!recursive) throw new Error("Cannot copy a directory without the recursive option");
      await native.mkdirAll(to);
      checkDestination(await realpath(to));
      for (const name of await fs.readdir(from)) await copy(join(from, name), join(to, name));
      return;
    }
    if (!info.isFile()) throw new Error("Cannot copy a non-regular file on the QuickJS host");
    if (!force) {
      const exists = await fs.lstat(to).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (exists) {
        if (errorOnExist) throw new Error("Copy destination already exists");
        return;
      }
    }
    await native.mkdirAll(dirname(to));
    await native.copyFile(from, to, preserveTimestamps);
  }

  await copy(from, to);
}

export default { ...fs, cp, realpath, unlink };
