import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";
import { isAbsolute, relative } from "node:path";

const action = ["node:path", "node:os", "node:crypto", "node:url"];

// The QuickJS host must supply exactly this list.
export const suppliedNodeModules = { action, local: [...action, "node:fs/promises"] };

function nodeModule(path) {
  if (path.startsWith("node:") || path === "bun" || path.startsWith("bun:")) return path;
  if (isBuiltin(path)) return `node:${path}`;
}

function unavailable(pluginRoot, importer, module, lane) {
  const file = isAbsolute(importer) ? relative(pluginRoot, importer) : importer;
  const advice = module === "node:fs/promises" ? " Move it into a local function." : "";

  return new Error(
    `Plugin import boundary: ${file} imports ${JSON.stringify(module)}, which is unavailable in ${lane}.${advice} A plugin that needs real Node can start it through proc in a local function.`,
  );
}

export function workerBuiltins(pluginRoot) {
  const supplied = suppliedNodeModules.local;

  return {
    name: "worker-node-builtins",
    setup(build) {
      build.onResolve({ filter: /.*/ }, ({ path, importer }) => {
        // Bun injects its own node:module import for the require shim.
        if (!importer || importer === "runtime") return;

        const module = nodeModule(path);
        if (!module || supplied.includes(module)) return;

        throw unavailable(pluginRoot, importer, module, "local functions");
      });
    },
  };
}

export function serverBuiltins(name, pluginRoot, lane, { callerFiles } = {}) {
  return {
    name,
    setup(build) {
      build.onResolve({ filter: /.*/ }, ({ path, importer }) => {
        if (!importer) return;

        const module = nodeModule(path);
        if (module === "node:fs/promises" && callerFiles?.has(importer))
          return { path: module, namespace: "unavailable-fs" };

        if (module) throw unavailable(pluginRoot, importer, module, lane);
      });
      build.onLoad({ filter: /.*/, namespace: "unavailable-fs" }, () => ({
        contents: `import { requireActionMachine } from ${JSON.stringify(fileURLToPath(new URL("../src/functions.ts", import.meta.url)))};
          const unavailable = requireActionMachine;
          export const constants = Object.freeze({ F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 });
          const api = {constants, ${localFsMethods.map((method) => `${method}: unavailable`).join(",")}};
          export const {${localFsMethods.join(",")}} = api;
          export default api;`,
        loader: "ts",
      }));
    },
  };
}

// Match the filesystem functions supplied by the Runner, not all of Node.
const localFsMethods = [
  "access",
  "chmod",
  "cp",
  "lstat",
  "mkdir",
  "mkdtemp",
  "open",
  "readdir",
  "readFile",
  "realpath",
  "rename",
  "rm",
  "rmdir",
  "stat",
  "symlink",
  "unlink",
  "writeFile",
];
