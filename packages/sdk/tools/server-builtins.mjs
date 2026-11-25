import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";
import { isAbsolute, relative } from "node:path";

const action = ["node:path", "node:os", "node:crypto", "node:url"];

// The QuickJS host must supply exactly this list.
export const suppliedNodeModules = { action, local: [...action, "node:fs/promises"] };

export function nodeModule(path) {
  if (path.startsWith("node:") || path === "bun" || path.startsWith("bun:")) return path;
  if (isBuiltin(path)) return `node:${path}`;
}

function unavailable(pluginRoot, importer, module, lane) {
  const file = isAbsolute(importer) ? relative(pluginRoot, importer) : importer;
  const advice = suppliedNodeModules.local.includes(module)
    ? ' Move it into a local function or an action with on: "caller".'
    : "";

  return new Error(
    `Plugin import boundary: ${file} imports ${JSON.stringify(module)}, which is unavailable in ${lane}.${advice} A plugin that needs real Node can start it through proc in a local function or caller action.`,
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
        if (suppliedNodeModules.local.includes(module) && callerFiles?.has(importer))
          return { path: module, namespace: "unavailable-machine-module" };

        if (module) throw unavailable(pluginRoot, importer, module, lane);
      });
      build.onLoad({ filter: /.*/, namespace: "unavailable-machine-module" }, async ({ path }) => {
        const names = Object.keys(await import(path)).filter(
          (name) => /^[a-zA-Z_$][\w$]*$/.test(name) && name !== "default",
        );
        const bindings = names.map(
          (name, i) => `const binding${i} = unavailable; export {binding${i} as ${name}};`,
        );
        return {
          contents: `import { requireActionMachine } from ${JSON.stringify(fileURLToPath(new URL("../src/functions.ts", import.meta.url)))};
            const fail = () => requireActionMachine(${JSON.stringify(`This needs a machine: ${path} is not available on the server`)});
            const unavailable = new Proxy(function () {}, {
              apply: fail,
              construct: fail,
              get: fail,
            });
            ${bindings.join("\n")}
            export default unavailable;`,
          loader: "ts",
        };
      });
    },
  };
}
