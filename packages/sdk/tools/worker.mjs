// Classify exported definitions through their SDK types, without evaluating
// authored modules on the build machine (aliases and reexports work too).
import ts from "typescript";
import { dirname, join, sep } from "node:path";
import { bunPluginBoundary, pluginCompilerOptions } from "./plugin-boundary.mjs";

export async function workerSources({
  root,
  files,
  modules,
  hasSchema,
  sdkRoot,
  header,
  pluginRoot,
  diagnostics,
}) {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists);
  const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile).config : {};
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  const program = ts.createProgram(
    files.map((file) => join(root, file)),
    pluginCompilerOptions(pluginRoot, parsed.options),
  );
  const checker = program.getTypeChecker();
  const imports = [];
  const actions = [];
  const metadata = [];
  for (const [i, file] of files.entries()) {
    const source = program.getSourceFile(join(root, file));
    const symbol = source && checker.getSymbolAtLocation(source);
    const local = [];
    const remote = [];
    for (const exported of symbol ? checker.getExportsOfModule(symbol) : []) {
      const type = checker.getTypeOfSymbolAtLocation(exported, source);
      const kind = type.getProperty("kind");
      if (!kind || !type.getProperty("invoke")) continue;
      const value = checker.getTypeOfSymbolAtLocation(kind, source);
      if (!(value.flags & ts.TypeFlags.StringLiteral)) continue;
      if (value.value === "action") {
        remote.push(exported.name);
        // Arguments are validated by the original definition in invokeFunction
        // inside Bun. QuickJS holds routing metadata, never an action handler.
        metadata.push({ name: `${modules[i]}:${exported.name}`, kind: "action", args: { kind: "any" } });
      } else if (["query", "mutation"].includes(value.value)) local.push(exported.name);
    }
    const module = JSON.stringify(join(root, file.slice(0, -3)));
    if (local.length)
      imports.push(
        `import { ${local.map((name) => `${name} as f${i}_${name}`).join(",")} } from ${module};\nconst m${i} = {${local.map((name) => `${name}: f${i}_${name}`).join(",")}};`,
      );
    if (remote.length)
      actions.push(
        `import { ${remote.map((name) => `${name} as f${i}_${name}`).join(",")} } from ${module};\nconst m${i} = {${remote.map((name) => `${name}: f${i}_${name}`).join(",")}};`,
      );
  }
  const registry = (items) =>
    `createRegistry({${items
      .map((item) => {
        const i = Number(/const m(\d+)/.exec(item)[1]);
        return `${JSON.stringify(modules[i])}: m${i}`;
      })
      .join(",")}})`;
  const workerSource =
    header +
    `import {createRegistry} from ${JSON.stringify(join(sdkRoot, "src/index.ts"))};\n` +
    actions.join("\n") +
    `\nexport const functions = ${registry(actions)};\n`;
  for (const [name, source, sourcemap] of [
    ["worker.js", workerSource, "external"],
    [
      "worker-entry.js",
      (await Bun.file(join(sdkRoot, "worker/entry.ts")).text()).replaceAll(
        "../src/",
        sdkRoot.split(sep).join("/") + "/src/",
      ),
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
      naming: name,
      plugins: [
        bunPluginBoundary(pluginRoot, diagnostics),
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
    if (!result.success) throw new AggregateError(result.logs, "Worker bundle failed");
    // The server executes a verified snapshot under a different filename.
    // Keep the separate map asset and expose it to the worker for stack mapping.
    if (sourcemap === "external") {
      const script = join(root, "dist", name);
      const map = await Bun.file(script + ".map").json();
      delete map.sourcesContent;
      await Bun.write(
        script,
        (await Bun.file(script).text()) + `\nexport const workerSourceMap = ${JSON.stringify(map)};\n`,
      );
    }
  }
  const source =
    header +
    `import {createRegistry, functionMetadata, schemaMetadata, invokeFunction, type HostBridge, type JsonValue} from "@tokamak/sdk";\n` +
    imports.join("\n") +
    "\n" +
    (hasSchema
      ? `import schemaValue from ${JSON.stringify(join(root, "schema"))};\nexport const schema = schemaMetadata(schemaValue);\n`
      : "export const schema = schemaMetadata(null);\n") +
    `const functions = ${registry(imports)};\nexport const metadata = [...functionMetadata(functions), ...${JSON.stringify(metadata)}];\nexport const describe = () => ({schema, functions: metadata});\nexport const invoke = (request: {name: string; args: JsonValue}, host: HostBridge) => invokeFunction(functions, request, host);\n`;
  return {
    source,
    plugins: [
      {
        name: "quickjs-functions",
        setup(build) {
          build.onResolve({ filter: /^node:/ }, ({ path }) => ({ path, external: true }));
          build.onLoad({ filter: /\.tsx?$/ }, async ({ path }) => {
            const file = program.getSourceFile(path);
            if (!file) return;
            const edits = [];
            function visit(node) {
              if (ts.isVariableDeclaration(node) && node.initializer) {
                const type = checker.getTypeAtLocation(node.initializer);
                const kind = type.getProperty("kind");
                if (
                  kind &&
                  type.getProperty("invoke") &&
                  checker.getTypeOfSymbolAtLocation(kind, node).value === "action"
                )
                  edits.push([node.initializer.getStart(file), node.initializer.end]);
              }
              ts.forEachChild(node, visit);
            }
            visit(file);
            if (!edits.length) return;
            let contents = file.text;
            for (const [start, end] of edits.sort((a, b) => b[0] - a[0]))
              contents = contents.slice(0, start) + "undefined" + contents.slice(end);
            return { contents, loader: "ts", resolveDir: dirname(path) };
          });
        },
      },
    ],
  };
}
