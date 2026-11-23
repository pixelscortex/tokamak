import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";

const actionModules = new Set(["node:path", "node:os", "node:crypto", "node:url"]);
const aiControls = fileURLToPath(new URL("../../../plugins/ai/src/server/controls.ts", import.meta.url));

function nodeModule(path) {
  if (path.startsWith("node:")) return path;
  if (isBuiltin(path)) return `node:${path}`;
}

function unavailable(importer, module, lane, advice = "") {
  return new Error(
    `Plugin import boundary: ${importer} imports ${JSON.stringify(module)}, which is unavailable in ${lane}.${advice} A plugin that needs real Node can start it through proc in a local function.`,
  );
}

export function workerBuiltins(local) {
  return {
    name: "worker-node-builtins",
    setup(build) {
      build.onResolve({ filter: /.*/ }, ({ path, importer }) => {
        // Bun injects its own node:module import for the require shim.
        if (!importer || importer === "runtime") return;

        const module = nodeModule(path);
        if (!module || actionModules.has(module)) return;
        if (local && module === "node:fs/promises") return;
        // Keep the starter AI plugin's Bun turn controls working during the migration.
        if (local && module === "node:async_hooks" && importer === aiControls) return;

        throw unavailable(importer, module, local ? "local functions" : "server actions");
      });
    },
  };
}

export function isFileOrProcessModule(path) {
  return /^(?:node:)?(?:fs(?:\/promises)?|child_process)$/.test(path);
}

export function serverBuiltins(name) {
  return {
    name,
    setup(build) {
      build.onResolve({ filter: /.*/ }, ({ path, importer }) => {
        if (!importer) return;
        const module = nodeModule(path);
        if (!(module || path === "bun" || path.startsWith("bun:"))) return;

        const advice = isFileOrProcessModule(path) ? " Move it into a local function." : "";
        if (module) throw unavailable(importer, module, "server functions", advice);
        throw new Error(`${importer}: ${path} is unavailable in server functions.${advice}`);
      });
    },
  };
}
