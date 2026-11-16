import { basename, dirname } from "node:path";

export function isServerRoot(root) {
  return basename(root) === "server" && basename(dirname(root)) === "src";
}

/** The authored modules registered by the backend bundler. */
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
