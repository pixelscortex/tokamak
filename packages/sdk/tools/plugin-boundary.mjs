import { readDescriptor } from "./plugin-descriptor.ts";
import { Visibility } from "../src/visibility.ts";
// One import policy for the SDK's Bun bundles and the public Vite builder.
// Provider source is read by TypeScript for types/metadata, never evaluated or bundled.
import { discoverPoints, pointReferenceTypes } from "./points.mjs";
import ts from "typescript";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { windowStateModule } from "../src/window-state-protocol.ts";
import { isInternalReferenceModule, isServerModule, isServerRoot, serverDirectory } from "./server-files.mjs";
import { generated, definitionInfo, pluginCompilerOptions, runtimeExportNames } from "./plugin-compiler.mjs";

import { contractDeclarations, importedContractEntry } from "./contracts.mjs";

import { tableDeclarations, tableReferences, tableReferenceSource } from "./table-references.mjs";

const specifier = /^plugin:([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)(?:\/(server|client|contracts|tables))?$/;
export function parsePluginSpecifier(text) {
  const match = specifier.exec(text);
  if (!match) return;
  return { id: match[1], side: match[2] ?? "server" };
}
const inside = (root, file) => {
  const local = relative(root, file);
  return local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(".." + sep));
};
function canonical(file) {
  const path = resolve(file);
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : resolve(canonical(parent), basename(path));
}
// The SDK is the host contract every plugin builds against. A workspace may
// resolve it by a tsconfig alias to its source instead of through node_modules.
const sdkRoot = canonical(resolve(import.meta.dirname, ".."));
const excluded =
  /(?:^|\/)(?:node_modules|dist|tests|__tests__|\.tokamak)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const windowSdk = ["@tokamak/sdk/client", windowStateModule];

function assertWindowImport(path, id) {
  if (id === windowStateModule || id === "@tokamak/sdk/window-state-host")
    throw new Error(`Window state runtime imports are reserved for the plugin build: ${path}`);
}

function assertWindowSide(path, id) {
  if (windowSdk.some((name) => id === name || id.startsWith(name + "/") || id.startsWith(name + "?")))
    throw new Error(`Window state is only available in the window: ${path}`);
}

export function featurePluginRoot(folder) {
  return isServerRoot(folder)
    ? resolve(folder, "../..")
    : basename(folder) === "src" && existsSync(resolve(folder, "../plugin.ts"))
      ? dirname(folder)
      : folder;
}

function configuration(file) {
  const path = ts.findConfigFile(dirname(file), ts.sys.fileExists);
  if (!path) return { options: {} };
  const config = ts.readConfigFile(path, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(path));
}

function diagnostic(importer, id, target) {
  return new Error(
    `Plugin import boundary: ${importer} imports ${JSON.stringify(id)}${target ? ` (${target})` : ""} outside its plugin folder. ` +
      'Keep helpers inside this plugin or install a package through node_modules. Use "plugin:<id>/server" for public types and host-call references, or "plugin:<id>/client" for the client registry.',
  );
}

function pluginOwner(file) {
  for (let dir = dirname(file); dirname(dir) !== dir; dir = dirname(dir)) {
    if (existsSync(resolve(dir, "plugin.ts")) && existsSync(resolve(dir, "package.json"))) return dir;
  }
}

export function assertPluginResolution(root, importer, id, target, packageImport = false) {
  root = canonical(root);
  target = canonical(target);
  const owner = pluginOwner(target);
  if (owner && canonical(owner) !== root) throw diagnostic(importer, id, target);
  if (!inside(root, canonical(importer))) return; // ordinary package-internal dependency
  if (/^@tokamak\/sdk(?:\/|$)/.test(id) && inside(sdkRoot, target)) return;
  if (inside(root, target)) return;
  if (packageImport) return;
  throw diagnostic(importer, id, target);
}

function provider(root, id) {
  const reference = parsePluginSpecifier(id);
  if (!reference) throw new Error(`Invalid plugin specifier ${id}`);
  const { side } = reference;
  const folder = resolve(root, "..", reference.id);
  const backendEntry = resolve(serverDirectory(folder), "api.ts");
  const entry =
    side === "contracts"
      ? importedContractEntry(root, reference.id)
      : side === "server"
        ? existsSync(backendEntry)
          ? backendEntry
          : resolve(folder, "api.ts")
        : resolve(
            folder,
            existsSync(resolve(folder, "src/client/api.ts")) ? "src/client/api.ts" : "src/client/api.tsx",
          );
  if (side === "tables")
    return { folder, entry: resolve(serverDirectory(folder), "schema.ts"), side, id: reference.id };
  if (!existsSync(entry)) throw new Error(`Plugin import ${id}: missing public API ${entry}`);
  return { folder, entry, side, id: reference.id };
}

function publicReferences(folder, entry) {
  const options = pluginCompilerOptions(folder, configuration(entry).options);
  const backend = serverDirectory(folder);
  const authored = ts.sys
    .readDirectory(backend, [".ts"])
    .filter((file) => isServerModule(backend, relative(backend, file).split(sep).join("/")));
  const program = ts.createProgram([entry, ...authored], options);
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(entry);
  const module = checker.getSymbolAtLocation(file);
  const original = (symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const targets = new Map();
  const sources = [];
  for (const source of program.getSourceFiles()) {
    const local = relative(backend, source.fileName).split(sep).join("/");
    if (!isServerModule(backend, local)) continue;
    sources.push(source);
    const symbol = checker.getSymbolAtLocation(source);
    const runtime = symbol && runtimeExportNames(checker, symbol);
    for (const exported of symbol ? checker.getExportsOfModule(symbol) : []) {
      if (!runtime.has(exported.name)) continue;
      const target = original(exported);
      const definition = definitionInfo(checker, target, source);
      if (!definition) continue;
      const moduleName = isServerRoot(backend) ? basename(local, ".ts") : local.slice(0, -3);
      if (!targets.has(target) || target.valueDeclaration?.getSourceFile() === source)
        targets.set(target, [
          moduleName,
          exported.name,
          definition.visibility,
          definition.kind,
          source.fileName,
        ]);
    }
  }
  const points = discoverPoints(
    sources,
    checker,
    [...targets]
      .filter(([, [, , , kind]]) => ["query", "mutation", "action"].includes(kind))
      .map(([symbol]) => symbol),
  );
  for (const [symbol, target] of targets) target.push(points.get(symbol));
  const runtime = module ? runtimeExportNames(checker, module) : new Set();
  const refs = (module ? checker.getExportsOfModule(module) : []).flatMap((exported) => {
    if (!runtime.has(exported.name)) return [];
    const target = targets.get(original(exported));
    return target && target[2] !== Visibility.Internal && target[3] !== "local"
      ? [[exported.name, target]]
      : [];
  });
  const imports = new Set();
  for (const source of program.getSourceFiles()) {
    if (!inside(folder, source.fileName) || inside(generated(folder), source.fileName)) continue;
    for (const imported of ts.preProcessFile(source.text, true, true).importedFiles)
      if (imported.fileName.startsWith("plugin:")) imports.add(imported.fileName);
  }
  const internal = [...targets.values()].filter(([, , visibility]) => visibility === Visibility.Internal);
  return { refs, imports, internal };
}

export function pluginReferenceSource(root, id, { publicOnly = false } = {}) {
  const target = provider(root, id);
  if (target.side === "tables")
    return tableReferenceSource(
      tableReferences(target.folder, target.id, configuration(target.entry).options),
    );
  if (target.side === "contracts")
    return (
      'import { contractReference } from "@tokamak/sdk/internal/contracts";\n' +
      contractDeclarations(target.entry)
        .map(
          ({ exported, name, place, dataMethods }) =>
            `export const ${exported} = contractReference(${JSON.stringify(name)}, ${JSON.stringify(place)}, ${JSON.stringify(target.id)}${dataMethods === undefined ? "" : ", " + JSON.stringify(dataMethods)});`,
        )
        .join("\n")
    );
  if (target.side === "client") throw new Error(`Use ${id} in a client bundle through the client registry`);
  const { refs: all, internal } = publicReferences(target.folder, target.entry);
  const refs = publicOnly ? all.filter(([, [, , visibility]]) => visibility === Visibility.Public) : all;
  const internalRefs = publicOnly ? [] : internal;
  const kinds = Object.fromEntries(
    [...refs.map(([, target]) => target), ...internalRefs].map(([module, method, , kind]) => [
      `${module}:${method}`,
      kind,
    ]),
  );
  const points = Object.fromEntries(
    [...refs.map(([, ref]) => ref), ...internalRefs].flatMap(([module, method, , , , named]) =>
      named?.size ? [[`${module}:${method}`, [...named.keys()]]] : [],
    ),
  );
  return (
    'import { createApi } from "@tokamak/sdk";\n' +
    `const references = createApi(${JSON.stringify(target.id)}, ${JSON.stringify(Object.keys(kinds))}, ${JSON.stringify(kinds)}, ${JSON.stringify(points)});\n` +
    `export const internal = createApi(${JSON.stringify(target.id)}, ${JSON.stringify(internalRefs.map(([module, method]) => `${module}:${method}`))}, ${JSON.stringify(kinds)}, ${JSON.stringify(points)});\n` +
    refs
      .map(
        ([name, [module, method]]) =>
          `export const ${name} = references[${JSON.stringify(module)}][${JSON.stringify(method)}];`,
      )
      .join("\n") +
    `\nexport const api = {${refs.map(([name]) => name).join(",")}};\n`
  );
}

function declarePlugin(root, id, declared, depends, tableOwners) {
  if (declared.has(id)) return;
  declared.add(id);
  const target = provider(root, id);
  const path = resolve(generated(root), target.id, `${target.side}.d.ts`);
  mkdirSync(dirname(path), { recursive: true });
  if (target.side === "tables") {
    const tables = tableReferences(target.folder, target.id, configuration(target.entry).options);
    writeFileSync(path, tableDeclarations(target.id, tables, Object.hasOwn(depends ?? {}, target.id)));
    return;
  }
  const parts = resolve(dirname(target.entry), "_generated/components.d.ts");
  const entry = JSON.stringify(target.side === "client" && existsSync(parts) ? parts : target.entry);
  if (target.side === "contracts") {
    writeFileSync(
      path,
      `export type * from ${entry};\n` +
        contractDeclarations(target.entry)
          .map(
            ({ exported }) =>
              `export declare const ${exported}: typeof import(${entry})[${JSON.stringify(exported)}];`,
          )
          .join("\n") +
        "\n",
    );
    return;
  }
  const { refs, imports, internal } = publicReferences(target.folder, target.entry);
  const aliases = [];
  const referenceType = ([module, method, , kind, source, points], type = "ReferenceFromDefinition") =>
    `import("@tokamak/sdk").${type}<typeof import(${JSON.stringify(source)})[${JSON.stringify(method)}], ${JSON.stringify(target.id)}> & { readonly [functionName]: ${JSON.stringify(`${target.id}/${module}:${method}`)} }${pointReferenceTypes(points, kind, target.id, `${target.id}/${module}:${method}`, aliases)}`;
  const qualify = (type) =>
    tableOwners.has(target.id)
      ? `import("@tokamak/sdk").QualifiedPluginApi<${JSON.stringify(target.id)}, ${type}>`
      : type;
  const internalTree = {};
  for (const ref of internal) {
    let branch = internalTree;
    for (const segment of ref[0].split("/")) branch = branch[segment] ??= Object.create(null);
    branch[ref[1]] = `${qualify(`{ref: ${referenceType(ref, "HookReferenceFromDefinition")}}`)}["ref"]`;
  }
  const declaration = (tree) =>
    `{${Object.entries(tree)
      .map(
        ([key, value]) =>
          `readonly ${JSON.stringify(key)}: ${typeof value === "string" ? value : declaration(value)};`,
      )
      .join("")}}`;
  const publicApi =
    target.side === "server" &&
    qualify(declaration(Object.fromEntries(refs.map(([name, ref]) => [name, referenceType(ref)]))));
  writeFileSync(
    path,
    `// Generated public plugin types. Runtime imports use references or the client registry.\n` +
      (target.side === "client"
        ? `export * from ${entry};\n`
        : 'import { functionName } from "@tokamak/sdk";\n' +
          `export type * from ${entry};\n` +
          aliases.join("") +
          `type PublicApi = ${publicApi};\n` +
          `export declare const internal: ${declaration(internalTree)};\n` +
          `export declare const api: PublicApi;\n` +
          refs
            .map(([name]) => `export declare const ${name}: PublicApi[${JSON.stringify(name)}];\n`)
            .join("")),
  );
  // Public API types can themselves depend on other sanctioned public types.
  // Materialize that type graph in the consumer; no provider code is emitted.
  for (const dependency of imports) declarePlugin(root, dependency, declared, depends, tableOwners);
}

/** Check even erased type imports and unused source modules; tests are separate. */
export function checkPluginImports(root, depends = readDescriptor(root)?.depends ?? {}) {
  root = resolve(root);
  const declared = new Set();
  const imports = new Map();
  const tableOwners = new Set();
  function checkFile(path) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const options = configuration(path).options;
    function check(id) {
      assertWindowImport(path, id);
      if (id.startsWith("@tokamak/sdk/internal/"))
        throw new Error(`Internal SDK imports are reserved for the plugin build: ${path}`);
      if (/^src\/(?:server|local)\//.test(relative(root, path).split(sep).join("/")))
        assertWindowSide(path, id);
      if (id.startsWith("plugin:")) {
        if (!imports.has(id)) imports.set(id, path);
        const reference = parsePluginSpecifier(id);
        if (reference?.side === "tables" && Object.hasOwn(depends, reference.id))
          tableOwners.add(reference.id);
        return;
      }
      if (id.startsWith("@plugins/")) throw diagnostic(path, id);
      if (isBuiltin(id)) return;
      const resolved = ts.resolveModuleName(id, path, options, ts.sys).resolvedModule;
      if (resolved) {
        const bare = !id.startsWith(".") && !isAbsolute(id);
        assertPluginResolution(
          root,
          path,
          id,
          resolved.resolvedFileName,
          bare && resolved.isExternalLibraryImport,
        );
      } else if (id.startsWith(".") || isAbsolute(id)) {
        // Assets (including CSS) are outside TypeScript's module resolver.
        const target = resolve(dirname(path), id.split("?")[0]);
        assertPluginResolution(root, path, id, target);
      }
    }
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      )
        check(node.moduleSpecifier.text);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      )
        check(node.argument.literal.text);
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteralLike(node.moduleReference.expression)
      )
        check(node.moduleReference.expression.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) check(arg.text);
        else
          throw new Error(
            `Dynamic plugin imports require a string literal: ${path}. Computed imports cannot be checked against the plugin boundary.`,
          );
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const ref of source.referencedFiles) check(ref.fileName);
  }
  const visited = new Set();
  function walk(dir) {
    if (!existsSync(dir)) return;
    const real = canonical(dir);
    if (visited.has(real)) return;
    visited.add(real);
    // Check ordinary importing files before following directory links, so an
    // escape reports the authored import whenever there is one.
    const items = readdirSync(dir, { withFileTypes: true }).sort(
      (a, b) => Number(a.isSymbolicLink()) - Number(b.isSymbolicLink()),
    );
    for (const item of items) {
      const path = resolve(dir, item.name);
      if (excluded.test(relative(root, path).split(sep).join("/")) || /^vite\.config\./.test(item.name))
        continue;
      if (item.isSymbolicLink() && !inside(canonical(root), canonical(path)))
        throw diagnostic(path, item.name, canonical(path));
      if (item.isDirectory() || (item.isSymbolicLink() && statSync(path).isDirectory())) walk(path);
      else if (/\.[cm]?[jt]sx?$/.test(item.name)) checkFile(path);
    }
  }
  walk(root);
  for (const [id, path] of imports) {
    try {
      declarePlugin(root, id, declared, depends, tableOwners);
    } catch (error) {
      throw new Error(`${diagnostic(path, id).message} ${error.message}`);
    }
  }
}

export function bunPluginReferences(root, options) {
  return {
    name: "plugin-references",
    setup(build) {
      build.onResolve({ filter: /^@tokamak\/sdk$/ }, ({ importer }) => {
        if (importer.startsWith("plugin:")) return { path: Bun.resolveSync("@tokamak/sdk", root) };
      });
      build.onResolve({ filter: /^plugin:/ }, ({ path, importer }) => {
        const restricted =
          typeof options?.publicOnly === "function" ? options.publicOnly(importer) : options?.publicOnly;
        return { path, namespace: restricted ? "public-plugin-reference" : "plugin-reference" };
      });
      for (const namespace of ["plugin-reference", "public-plugin-reference"])
        build.onLoad({ filter: /.*/, namespace }, ({ path }) => ({
          contents: pluginReferenceSource(root, path, {
            publicOnly: namespace === "public-plugin-reference",
          }),
          loader: "js",
          resolveDir: root,
        }));
    },
  };
}

export function bunPluginBoundary(root, { publicOnly = false } = {}) {
  return {
    name: "plugin-import-boundary",
    setup(build) {
      bunPluginReferences(root, { publicOnly }).setup(build);
      build.onResolve({ filter: /.*/, namespace: "file" }, ({ path, importer }) => {
        if (!importer || !isAbsolute(importer) || path.startsWith("node:") || isBuiltin(path)) return;
        assertWindowSide(importer, path);
        const target = Bun.resolveSync(path, dirname(importer));
        if (
          (typeof publicOnly === "function" ? publicOnly(importer) : publicOnly) &&
          isInternalReferenceModule(canonical(target))
        )
          throw new Error(
            `Local code cannot import internal references: ${path}. Import the generated public api instead.`,
          );
        const bare = !path.startsWith(".") && !isAbsolute(path);
        // Bun resolves workspace symlinks to their real location. A bare import
        // must also resolve via node_modules, not a tsconfig source alias.
        assertPluginResolution(
          root,
          importer,
          path,
          target,
          bare &&
            Boolean(
              ts.resolveModuleName(path, importer, configuration(importer).options, ts.sys).resolvedModule
                ?.isExternalLibraryImport,
            ),
        );
      });
    },
  };
}
