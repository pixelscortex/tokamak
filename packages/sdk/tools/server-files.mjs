import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export function serverDirectory(root) {
  if (existsSync(resolve(root, "src/server"))) return resolve(root, "src/server");
  return resolve(root, "src");
}

export function isServerRoot(root) {
  return basename(root) === "server" && basename(dirname(root)) === "src";
}

export function isInternalReferenceModule(file) {
  return basename(dirname(file)) === "_generated" && ["internal.ts", "plugin.ts"].includes(basename(file));
}

/** The authored modules registered by the server bundler. */
export function isServerModule(root, file) {
  return (
    file.endsWith(".ts") &&
    !file
      .split("/")
      .some(
        (part) =>
          part === ".." ||
          part.startsWith("_") ||
          part.startsWith(".") ||
          ["node_modules", "dist", "tests"].includes(part),
      ) &&
    !(isServerRoot(root) && file === "api.ts") &&
    file !== "schema.ts" &&
    !/\.(d|test|spec)\.ts$/.test(file)
  );
}
