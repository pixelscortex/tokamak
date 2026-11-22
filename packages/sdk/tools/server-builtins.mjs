import { isBuiltin } from "node:module";

export function isFileOrProcessModule(path) {
  return /^(?:node:)?(?:fs(?:\/promises)?|child_process)$/.test(path);
}

export function serverBuiltins(name) {
  return {
    name,
    setup(build) {
      build.onResolve({ filter: /.*/ }, ({ path, importer }) => {
        if (!importer || !(isBuiltin(path) || path === "bun" || path.startsWith("bun:"))) return;
        const advice = isFileOrProcessModule(path) ? " Move it into a local function." : "";
        throw new Error(`${importer}: ${path} is unavailable in server functions.${advice}`);
      });
    },
  };
}
