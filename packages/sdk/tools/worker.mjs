import { isServerRoot } from "./server-files.mjs";
import { Visibility } from "../src/visibility.ts";
import { join } from "node:path";
import { functionPlacement, lanes, placementTransform, registrySource } from "./placement.mjs";
import { bunPluginBoundary } from "./plugin-boundary.mjs";
import { contractTarget } from "./contracts.mjs";
import { serverBuiltins, workerBuiltins } from "./server-builtins.mjs";

export function transactionSources({
  root,
  files,
  modules,
  hasSchema,
  header,
  pluginRoot,
  placement,
  namespace,
}) {
  const paths = files.map((file) => join(root, file));
  placement ??= functionPlacement(pluginRoot, { files: paths, configRoot: root }, namespace);
  const inLane = (keep) =>
    paths.flatMap((path, index) => {
      const definitions = placement?.modules.get(path);
      const names = definitions
        ? [...definitions].filter(([, definition]) => keep(definition.kind)).map(([name]) => name)
        : [];
      return names.length ? [[path, modules[index], names]] : [];
    });
  const actions = inLane((kind) => kind === "action");
  // The action process validates arguments. Transactions only need the
  // action metadata to advertise and route those calls.
  const metadata = actions.flatMap(([path, module, names]) =>
    names.map((name) => ({
      name: `${module}:${name}`,
      kind: "action",
      args: { kind: "any" },
      visibility: placement.modules.get(path).get(name).visibility,
      on: placement.modules.get(path).get(name).on,
    })),
  );
  const providers = placement?.providers ?? [];
  for (const provider of providers)
    for (const method of provider.methods)
      if (method.kind === "action")
        metadata.push({
          name: contractTarget(provider, method),
          kind: "action",
          args: { kind: "any" },
          visibility: Visibility.Internal,
          on: method.on,
        });
  return {
    source: registrySource({
      root,
      modules: inLane(lanes.descriptor.keep),
      hasSchema,
      metadata,
      placement,
      hasActionHooks: inLane((kind) => kind === "actionHook").length > 0,
      results: placement?.results(root, isServerRoot(root)),
      points: placement?.points(root, isServerRoot(root)),
      providers,
      lane: lanes.descriptor,
      header,
    }),
    plugins: [
      serverBuiltins("transaction-builtins", pluginRoot, "queries and mutations"),
      ...(placement ? [placementTransform(placement, lanes.descriptor)] : []),
    ],
  };
}

export async function buildLocalBundle({ root, sdkRoot, pluginRoot, source, plugins, actionModules }) {
  const result = await Bun.build({
    entrypoints: ["tokamak-worker:entry"],
    target: "node",
    format: "esm",
    packages: "bundle",
    sourcemap: "external",
    outdir: join(root, "dist"),
    naming: "local.js",
    env: "disable",
    plugins: [
      workerBuiltins(pluginRoot),
      bunPluginBoundary(pluginRoot, { publicOnly: (path) => !actionModules.has(path) }),
      ...plugins,
      {
        name: "worker-sdk",
        setup(build) {
          build.onResolve({ filter: /^@tokamak\/sdk$/ }, () => ({ path: join(sdkRoot, "src/index.ts") }));
        },
      },
      {
        name: "worker-source",
        setup(build) {
          build.onResolve({ filter: /^tokamak-worker:entry$/ }, () => ({
            path: "entry",
            namespace: "worker",
          }));
          build.onLoad({ filter: /.*/, namespace: "worker" }, () => ({
            contents: source,
            loader: "ts",
            resolveDir: join(sdkRoot, "worker"),
          }));
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, "Local bundle failed");
}
