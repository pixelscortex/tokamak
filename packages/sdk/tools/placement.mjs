// Discover function placement from SDK types, including aliases and re-exports.
// Build entries name only their own definitions; transforms erase the others
// before either bundler reads their imports or emits any source.
import ts from "typescript";
import { readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  definitionInfo,
  definitionTypeInfo,
  pluginCompilerOptions,
  runtimeExportNames,
} from "./plugin-compiler.mjs";

import { resultValidator } from "./result-validator.mjs";
import { discoverProviders, contractTarget } from "./contracts.mjs";

const serverFunction = (kind) => kind !== "local";
export const runnerFunction = (kind) => kind === "local" || kind === "action";
export const runnerProvider = (provider) =>
  localProvider(provider) || provider.methods.some((m) => action(m.kind));
const serverProvider = (provider) => provider.place === "server";
const localProvider = (provider) => provider.place === "local";
const action = (kind) => kind === "action";
const noFunctions = () => false;

export const lanes = {
  window: { keep: noFunctions, provider: noFunctions, method: noFunctions },
  local: {
    keep: runnerFunction,
    provider: runnerProvider,
    method: runnerFunction,
  },
  server: { keep: serverFunction, provider: serverProvider, method: serverFunction },
  descriptor: {
    keep: (kind) => serverFunction(kind) && !action(kind),
    provider: serverProvider,
    method: (kind) => serverFunction(kind) && !action(kind),
  },
};

export function functionPlacement(root, selected, namespace) {
  root = realpathSync(root);
  const src = resolve(root, "src");
  const files = selected ? [...selected.files] : [];
  function scan(dir) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (/^[._]|^(dist|node_modules|tests)$/.test(item.name)) continue;
      const path = resolve(dir, item.name);
      if (item.isDirectory()) scan(path);
      else if (/\.tsx?$/.test(path) && !/\.(d|test|spec)\.tsx?$/.test(path)) files.push(path);
    }
  }
  for (const directory of selected ? [] : [src]) {
    try {
      scan(directory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!files.length) return;
  const config = ts.findConfigFile(selected?.configRoot ?? root, ts.sys.fileExists);
  const options = config
    ? ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} })
        ?.options
    : { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.Preserve };
  const program = ts.createProgram(files.sort(), pluginCompilerOptions(root, options ?? {}));
  const checker = program.getTypeChecker();
  const modules = new Map();
  const hookType = (type) => type.getProperties().some((p) => p.name.startsWith("__@hookBrand@"));
  const providers = discoverProviders(root, files, program, checker);
  for (const path of files) {
    if (path === resolve(src, "server/api.ts")) continue;
    const source = program.getSourceFile(path);
    const symbol = checker.getSymbolAtLocation(source);
    const exports = new Map();
    const runtime = symbol && runtimeExportNames(checker, symbol);
    for (const value of symbol ? checker.getExportsOfModule(symbol) : []) {
      if (!runtime.has(value.name)) continue;
      const definition = definitionInfo(checker, value, source);
      const type = checker.getTypeOfSymbolAtLocation(value, source);
      if (hookType(type)) {
        if (path.startsWith(resolve(src, "client") + sep))
          throw new Error("Hooks must be exported from the plugin's server part");
        const reference = checker.getTypeOfSymbolAtLocation(type.getProperty("reference"), source);
        const brand = reference.getProperties().find((p) => p.name.startsWith("__@referenceTypes@"));
        const owner = brand && checker.getTypeOfSymbolAtLocation(brand, source).getProperty("owner");
        if (namespace && owner && checker.getTypeOfSymbolAtLocation(owner, source).value === namespace)
          throw new Error("Hooks must target a public query of another plugin");
        exports.set(value.name, { kind: "hook" });
      } else if (definition?.kind) {
        exports.set(value.name, {
          ...definition,
          ...(definition.kind === "query" ? { type, source } : {}),
        });
      }
    }
    if (exports.size) modules.set(path, exports);
  }

  function edits(path, lane) {
    const file = program.getSourceFile(path);
    if (!file || !files.includes(path)) return [];
    const cuts = [];
    const retained = new Set();
    const discard = new Set();
    const helpers = new Map();
    const symbolOf = (node) => checker.getSymbolAtLocation(node);

    const calls = new Map(providers.filter((p) => p.path === path).map((p) => [p.call, p]));
    const fields = new Map(
      providers.filter((p) => p.path === path).flatMap((p) => p.methods.map((m) => [m.field, m])),
    );
    function references(node, into, erased = false) {
      const provider = !erased && calls.get(node);
      if (provider && !lane.provider(provider)) {
        cuts.push([node.getStart(file), node.end, "undefined"]);
        references(node, discard, true);
        return;
      }
      const method = !erased && fields.get(node);
      if (method && !lane.method(method.kind)) {
        cuts.push([
          node.getStart(file),
          node.end,
          method.argument ? "undefined" : `${JSON.stringify(method.member)}: undefined`,
        ]);
        references(node, discard, true);
        return;
      }
      if (!erased && ts.isVariableDeclaration(node) && node.initializer) {
        const type = checker.getTypeAtLocation(node.initializer);
        const target = hookType(type) ? "hook" : definitionTypeInfo(checker, type, node)?.kind;
        if (target && !lane.keep(target)) {
          cuts.push([node.initializer.getStart(file), node.initializer.end, "undefined"]);
          references(node.initializer, discard, true);
          return;
        }
      }
      if (ts.isIdentifier(node) && !isDeclarationName(node)) {
        const symbol = ts.isExportSpecifier(node.parent)
          ? checker.getExportSpecifierLocalTargetSymbol(node.parent)
          : ts.isShorthandPropertyAssignment(node.parent)
            ? checker.getShorthandAssignmentValueSymbol(node.parent)
            : symbolOf(node);
        if (symbol) into.add(symbol);
      }
      ts.forEachChild(node, (child) => references(child, into, erased));
    }
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement)) continue;
      const helper = helperName(statement);
      const symbol = helper && symbolOf(helper);
      if (symbol) {
        const refs = new Set();
        references(statement, refs);
        helpers.set(symbol, { statement, refs });
      } else {
        references(statement, retained);
      }
    }

    // Follow private helper chains reachable from an erased handler. Shared
    // helpers and independent top-level effects stay in the entry's graph.
    function expand(symbols) {
      for (const symbol of symbols) for (const ref of helpers.get(symbol)?.refs ?? []) symbols.add(ref);
    }
    expand(discard);
    for (const symbol of helpers.keys()) if (!discard.has(symbol)) retained.add(symbol);
    expand(retained);
    const dropped = [];
    for (const [symbol, { statement }] of helpers)
      if (discard.has(symbol) && !retained.has(symbol))
        dropped.push([statement.getStart(file), statement.end, ""]);

    const imports = importEdits(file, (name) => {
      const symbol = symbolOf(name);
      return discard.has(symbol) && !retained.has(symbol);
    });
    return [
      ...dropped,
      ...imports,
      ...cuts.filter(([start]) => !dropped.some(([left, right]) => start >= left && start < right)),
    ];
  }

  function transform(path, lane) {
    const cuts = edits(path, lane);
    if (!cuts.length) return;
    let contents = program.getSourceFile(path).text;
    for (const [start, end, replacement] of cuts.sort((a, b) => b[0] - a[0]))
      contents = contents.slice(0, start) + replacement + contents.slice(end);
    return contents;
  }
<<<<<<< HEAD
  function results(server, organized) {
    return Object.fromEntries(
      [...modules].flatMap(([path, definitions]) =>
        [...definitions].flatMap(([name, { kind, type, source }]) => {
          const result = kind === "query" && resultValidator(checker, type, source);
          return result ? [[`${moduleName(server, path, organized)}:${name}`, result]] : [];
        }),
      ),
    );
  }
  return { modules, providers, transform, edits, results };
=======
  const callerFiles = new Set([
    ...[...modules]
      .filter(([, exports]) => [...exports.values()].some((d) => d.on === "caller"))
      .map(([path]) => path),
    ...providers.filter((p) => p.methods.some((m) => m.on === "caller")).map((p) => p.path),
  ]);
  for (const path of callerFiles) {
    const file = program.getSourceFile(path);
    if (!file) continue;
    function visit(node) {
      const specifier =
        (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
        (ts.isExportDeclaration(node) && !node.isTypeOnly)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined;
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const dependency = checker.getSymbolAtLocation(specifier)?.declarations?.find(ts.isSourceFile);
        if (dependency && !dependency.isDeclarationFile && dependency.fileName.startsWith(root + sep))
          callerFiles.add(dependency.fileName);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }

  for (const path of files) {
    const file = program.getSourceFile(path);
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        definitionTypeInfo(checker, checker.getTypeAtLocation(node), node)?.kind === "action"
      ) {
        const options = node.arguments[0];
        const type = options && checker.getTypeAtLocation(options);
        if (type?.getProperty("handler") && type.getProperty("on")) {
          const properties = ts.isObjectLiteralExpression(options) ? [...options.properties].reverse() : [];
          const field = properties.find((property) => {
            if (ts.isSpreadAssignment(property))
              return !!checker.getTypeAtLocation(property.expression).getProperty("on");
            const name = property.name;
            return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === "on";
          });
          if (
            !field ||
            !ts.isPropertyAssignment(field) ||
            !ts.isStringLiteral(field.initializer) ||
            !["caller", "server"].includes(field.initializer.text)
          )
            throw new Error(`Action placement in ${path} must use on: "caller" or on: "server" as a literal`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }

  return { modules, providers, callerFiles, transform, edits };
>>>>>>> 4ff4e5cd (Resolve action placement on the server and share Runner invocation controls)
}

function isDeclarationName(node) {
  return (
    (ts.isVariableDeclaration(node.parent) || ts.isFunctionDeclaration(node.parent)) &&
    node.parent.name === node
  );
}

function helperName(statement) {
  if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return;
  if (ts.isFunctionDeclaration(statement)) return statement.name;
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return;
  const declaration = statement.declarationList.declarations[0];
  if (ts.isIdentifier(declaration.name)) return declaration.name;
}

function importEdits(file, unused) {
  const edits = [];
  for (const node of file.statements) {
    if (!ts.isImportDeclaration(node) || !node.importClause || node.importClause.isTypeOnly) continue;
    const clause = node.importClause;
    const defaultName = clause.name && (!unused(clause.name) ? clause.name.text : "");
    const bindings = clause.namedBindings;
    let changed = clause.name && !defaultName;
    let named = "";
    if (bindings && ts.isNamespaceImport(bindings)) {
      if (!unused(bindings.name)) named = bindings.getText(file);
      else changed = true;
    } else if (bindings) {
      const kept = bindings.elements.filter((item) => !unused(item.name));
      changed ||= kept.length !== bindings.elements.length;
      if (kept.length) named = "{ " + kept.map((item) => item.getText(file)).join(", ") + " }";
    }
    if (!changed) continue;
    const names = [defaultName, named].filter(Boolean).join(", ");
    const replacement = names ? `import ${names} from ${node.moduleSpecifier.getText(file)};` : "";
    edits.push([node.getStart(file), node.end, replacement]);
  }
  return edits;
}

export function moduleName(root, file, organized) {
  const path = relative(root, file)
    .split(sep)
    .join("/")
    .replace(/\.tsx?$/, "");
  return organized && !path.startsWith("../") ? path.split("/").at(-1) : path.replace(/^\.\.\//, "");
}

export function placedModules(placement, root, organized, keep) {
  return [...placement.modules].flatMap(([path, exports]) => {
    const names = [...exports].filter(([, definition]) => keep(definition.kind)).map(([name]) => name);
    return names.length ? [[path, moduleName(root, path, organized), names]] : [];
  });
}

export function registrySource({
  root,
  modules,
  hasSchema,
  metadata,
  results,
  providers = [],
  lane = lanes.server,
  worker = false,
  header = "",
}) {
  const imports = [];
  const entries = [];
  for (const [index, [path, module, names]] of modules.entries()) {
    const source = JSON.stringify(path.replace(/\.tsx?$/, ""));
    if (!names) {
      // Standalone features have always registered every exported SDK definition.
      imports.push(`import * as m${index} from ${source};`);
      entries.push(`${JSON.stringify(module)}: m${index}`);
      continue;
    }
    const namesWithBindings = names.map((name, i) => [name, `f${index}_${i}`]);
    imports.push(
      `import { ${namesWithBindings.map(([name, binding]) => `${JSON.stringify(name)} as ${binding}`).join(", ")} } from ${source};`,
    );
    entries.push(
      `${JSON.stringify(module)}: {${namesWithBindings.map(([name, binding]) => `${JSON.stringify(name)}: ${binding}`).join(", ")}}`,
    );
  }
  const registrations = providers.filter(lane.provider);
  const contractImports = registrations.map((p, i) => {
    const name = p.exported === "default" ? `provider${i}` : `{ ${p.exported} as provider${i} }`;
    return `import ${name} from ${JSON.stringify(p.path.replace(/\.tsx?$/, ""))};`;
  });
  imports.push(...contractImports);
  const localProviders = registrations.flatMap((p, i) =>
    localProvider(p) ? [`${JSON.stringify(p.registration)}: provider${i}`] : [],
  );
  const serverData = registrations.map(
    (p, i) =>
      `${JSON.stringify(p.registration)}: contractData(provider${i}.implementation, ${JSON.stringify(p.methods.map((m) => m.member))})`,
  );
  const targets = registrations.flatMap((p, i) =>
    (localProvider(p) ? [] : p.methods)
      .filter((m) => lane.method(m.kind))
      .map(
        (m) =>
          `${JSON.stringify(contractTarget(p, m))}: provider${i}.implementation[${JSON.stringify(m.member)}]`,
      ),
  );
  const registry = targets.length
    ? `createRegistry({${entries.join(",")}}, {${targets.join(",")}})`
    : `createRegistry({${entries.join(",")}})`;
  const definitions = imports.join("\n");
  if (worker)
    return (
      header +
      `import {createRegistry} from "@tokamak/sdk";\n${definitions}\nexport const functions = ${registry};\n${localProviders.length && lane === lanes.local ? `export const contractProviders = {${localProviders.join(",")}};\n` : ""}`
    );
  return (
    header +
    'import {createRegistry, functionMetadata, schemaMetadata, invokeFunction, createHookRegistry, hookMetadata, invokeHook, type HostBridge, type JsonValue} from "@tokamak/sdk";\n' +
    (serverData.length ? 'import {contractData} from "@tokamak/sdk/internal/contracts";\n' : "") +
    definitions +
    "\n" +
    (hasSchema
      ? `import schemaValue from ${JSON.stringify(join(root, "schema"))};\nexport const schema = schemaMetadata(schemaValue);\n`
      : "export const schema = schemaMetadata(null);\n") +
    `export const functions = ${registry};\nexport const metadata = ${
      metadata?.length
        ? `[...functionMetadata(functions), ...${JSON.stringify(metadata)}]`
        : "functionMetadata(functions)"
    };\n` +
    `const hooks = createHookRegistry({${entries.join(",")}});\n` +
    `export const describe = () => ({schema, functions: metadata, hooks: hookMetadata(hooks), results: ${JSON.stringify(results ?? {})}${serverData.length ? `, contractProviders: {${serverData.join(",")}}` : ""}});\n` +
    "export const invoke = (request: {name: string; args: JsonValue}, host: HostBridge) => invokeFunction(functions, request, host);\n" +
    "export const invoke_hook = (request: Parameters<typeof invokeHook>[1], host: HostBridge) => invokeHook(hooks, request, host);\n"
  );
}

export function placementTransform(placement, lane) {
  return {
    name: "tokamak-function-placement",
    setup(build) {
      build.onLoad({ filter: /\.tsx?$/ }, ({ path }) => {
        const contents = placement.transform(path, lane);
        if (contents !== undefined)
          return { contents, loader: path.endsWith(".tsx") ? "tsx" : "ts", resolveDir: dirname(path) };
      });
    },
  };
}
