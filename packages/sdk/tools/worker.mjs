import { Visibility } from "../src/visibility.ts";
import { join, sep } from "node:path";
import { functionPlacement, lanes, placementTransform, registrySource } from "./placement.mjs";
import { bunPluginBoundary } from "./plugin-boundary.mjs";
import { contractTarget } from "./contracts.mjs";
import { serverBuiltins, workerBuiltins } from "./server-builtins.mjs";

export async function workerSources({
  root,
  files,
  modules,
  hasSchema,
  sdkRoot,
  header,
  pluginRoot,
  placement,
}) {
  const paths = files.map((file) => join(root, file));
  placement ??= functionPlacement(pluginRoot, { files: paths, configRoot: root });
  const inLane = (keep) =>
    paths.flatMap((path, index) => {
      const definitions = placement?.modules.get(path);
      const names = definitions
        ? [...definitions].filter(([, definition]) => keep(definition.kind)).map(([name]) => name)
        : [];
      return names.length ? [[path, modules[index], names]] : [];
    });
  const actions = inLane((kind) => kind === "action");
  // QuickJS holds dispatch metadata. The Bun worker validates the original
  // definitions, so their handlers and argument validators stay with them.
  const metadata = actions.flatMap(([path, module, names]) =>
    names.map((name) => ({
      name: `${module}:${name}`,
      kind: "action",
      args: { kind: "any" },
      visibility: placement.modules.get(path).get(name).visibility,
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
        });
  await buildWorkerBundles({
    root,
    sdkRoot,
    pluginRoot,
    source: registrySource({
      root,
      modules: actions,
      providers: providers.filter((p) => p.methods.some((m) => m.kind === "action")),
      lane: lanes.worker,
      worker: true,
      header,
    }),
    name: "worker",
    plugins: placement ? [placementTransform(placement, lanes.worker)] : [],
  });
  return {
    source: registrySource({
      root,
      modules: inLane(lanes.descriptor.keep),
      hasSchema,
      metadata,
      providers,
      lane: lanes.descriptor,
      header,
    }),
    plugins: [
      serverBuiltins("worker-server-builtins"),
      ...(placement ? [placementTransform(placement, lanes.descriptor)] : []),
    ],
  };
}

export async function buildWorkerBundles({ root, sdkRoot, pluginRoot, name, source, plugins = [] }) {
  for (const [asset, contents, sourcemap] of [
    [name + ".js", source, "external"],
    [
      name + "-entry.js",
      (await Bun.file(join(sdkRoot, "worker/entry.ts")).text())
        .replace('"./process"', JSON.stringify(join(sdkRoot, "worker/process.ts")))
        .replace('"./contracts"', JSON.stringify(join(sdkRoot, "worker/contracts.ts")))
        .replace('"./invocation-host"', JSON.stringify(join(sdkRoot, "worker/invocation-host.ts")))
        .replaceAll("../src/", sdkRoot.split(sep).join("/") + "/src/"),
      "none",
    ],
  ]) {
    const result = await Bun.build({
      entrypoints: ["tokamak-worker:entry"],
      target: "node",
      format: "esm",
      packages: "bundle",
      sourcemap,
      outdir: join(root, "dist"),
      naming: asset,
      env: "disable",
      plugins: [
        ...(asset === name + ".js" ? [workerBuiltins(name === "local")] : []),
        bunPluginBoundary(pluginRoot, { publicOnly: name === "local" }),
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
              contents,
              loader: "ts",
              resolveDir: join(sdkRoot, "worker"),
            }));
          },
        },
      ],
    });
    if (!result.success) throw new AggregateError(result.logs, "Worker bundle failed");
  }
}
