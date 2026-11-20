// One import policy for the SDK's Bun bundles and the public Vite builder.
// Dependency types and reference metadata come from built artifacts.
import ts from "typescript";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { fetchLocal } from "../../runtime/tools/local-server.ts";
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
import { isServerModule, isServerRoot } from "./server-files.mjs";
import { checkTokamakImport, sharedImports } from "../../build/src/shared-libraries.mts";

const specifier = /^plugin:([^/]+)(?:\/(server|client))?$/;
const inside = (root, file) => {
  const local = relative(root, file);
  return local === "" || (!isAbsolute(local) && local !== ".." && !local.startsWith(".." + sep));
};
const canonical = (file) => (existsSync(file) ? realpathSync(file) : resolve(file));
const server = (root) => resolve(root, existsSync(resolve(root, "src/server")) ? "src/server" : "backend");
const generated = (root) => resolve(root, ".tokamak/types");
// The SDK is the host contract every plugin builds against. A workspace may
// resolve it by a tsconfig alias to its source instead of through node_modules.
const sdkRoot = canonical(resolve(import.meta.dirname, ".."));
const excluded =
  /(?:^|\/)(?:node_modules|dist|tests|__tests__|\.tokamak)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function featurePluginRoot(folder) {
  return isServerRoot(folder)
    ? resolve(folder, "../..")
    : basename(folder) === "backend"
      ? dirname(folder)
      : folder;
}

function configuration(file) {
  const path = ts.findConfigFile(dirname(file), ts.sys.fileExists);
  if (!path) return { options: {} };
  const config = ts.readConfigFile(path, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(path));
}

const checkoutWindow = resolve(sdkRoot, "../../app");
const moduleDefaults = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
};
let checkoutPaths;
function sharedTypePaths() {
  if (checkoutPaths) return checkoutPaths;
  checkoutPaths = {};
  const importer = resolve(checkoutWindow, "src/styles.ts");
  for (const id of sharedImports) {
    const target = ts.resolveModuleName(id, importer, moduleDefaults, ts.sys).resolvedModule;
    if (target) checkoutPaths[id] = [target.resolvedFileName];
  }
  return checkoutPaths;
}

export function pluginTsconfig(root, folder) {
  for (let dir = folder; inside(root, dir); dir = dirname(dir)) {
    const path = resolve(dir, "tsconfig.json");
    if (existsSync(path)) return path;
    if (dir === root || dirname(dir) === dir) break;
  }
}

export function readPluginCompilerOptions(root, folder, window = false) {
  const path = pluginTsconfig(root, folder);
  const config = path ? ts.readConfigFile(path, ts.sys.readFile) : { config: {} };
  const parsed = ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, path ? dirname(path) : folder);
  const invalid = config.error ?? parsed.errors.find(({ code }) => code !== 18002 && code !== 18003);
  if (invalid) throw new Error(ts.flattenDiagnosticMessageText(invalid.messageText, "\n"));
  return pluginCompilerOptions(root, {
    ...(window
      ? {
          lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
          jsx: ts.JsxEmit.Preserve,
          jsxImportSource: "@solidjs/web",
          allowImportingTsExtensions: true,
          skipLibCheck: true,
        }
      : {}),
    ...parsed.options,
  });
}

export function pluginCompilerOptions(root, options) {
  // Resolve inherited paths at their declaring config, before adding our own.
  const base = options.baseUrl ?? options.pathsBasePath ?? root;
  const paths = Object.fromEntries(
    Object.entries(options.paths ?? {})
      .filter(([key]) => !key.startsWith("plugin:"))
      .map(([key, values]) => [key, values.map((value) => resolve(base, value))]),
  );
  return {
    ...moduleDefaults,
    ...options,
    paths: {
      ...sharedTypePaths(),
      ...paths,
      "plugin:*/server": [resolve(generated(root), "*/server.d.ts")],
      "plugin:*/client": [resolve(generated(root), "*/client.d.ts")],
      "plugin:*": [resolve(generated(root), "*/server.d.ts")],
    },
  };
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

/** Runtime exports only: erased named/star re-exports must never grant references. */
export function runtimeExportNames(checker, module, seen = new Set()) {
  if (seen.has(module)) return new Set();
  seen.add(module);
  const file = module.declarations?.find(ts.isSourceFile);
  if (!file) return new Set();
  const names = new Set(
    checker
      .getExportsOfModule(module)
      .filter(
        (symbol) =>
          symbol.flags & ts.SymbolFlags.Value && symbol.declarations?.some((d) => d.getSourceFile() === file),
      )
      .map((symbol) => symbol.name),
  );
  for (const statement of file.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    if (!statement.exportClause) {
      if (!statement.moduleSpecifier) continue;
      const target = checker.getSymbolAtLocation(statement.moduleSpecifier);
      if (target)
        for (const name of runtimeExportNames(checker, target, new Set(seen))) {
          if (name !== "default") names.add(name);
        }
    } else if (ts.isNamedExports(statement.exportClause)) {
      for (const item of statement.exportClause.elements) if (!item.isTypeOnly) names.add(item.name.text);
    } else names.add(statement.exportClause.name.text);
  }
  return names;
}

export function publicReferences(folder, entry) {
  const options = pluginCompilerOptions(folder, configuration(entry).options);
  const program = ts.createProgram([entry], options);
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(entry);
  const module = checker.getSymbolAtLocation(file);
  const original = (symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const targets = new Map();
  const backend = server(folder);
  for (const source of program.getSourceFiles()) {
    const local = relative(backend, source.fileName).split(sep).join("/");
    if (!isServerModule(backend, local)) continue;
    const symbol = checker.getSymbolAtLocation(source);
    for (const exported of symbol ? checker.getExportsOfModule(symbol) : []) {
      const target = original(exported);
      if (
        !checker
          .getTypeOfSymbolAtLocation(target, source)
          .getProperties()
          .some((p) => p.name.startsWith("__@definitionBrand@"))
      )
        continue;
      const moduleName = isServerRoot(backend) ? basename(local, ".ts") : local.slice(0, -3);
      if (!targets.has(target) || target.valueDeclaration?.getSourceFile() === source)
        targets.set(target, [moduleName, exported.name]);
    }
  }
  const runtime = module ? runtimeExportNames(checker, module) : new Set();
  const refs = (module ? checker.getExportsOfModule(module) : []).flatMap((exported) => {
    if (!runtime.has(exported.name)) return [];
    const target = targets.get(original(exported));
    return target ? [[exported.name, target]] : [];
  });
  return { refs };
}

export function pluginReferenceSource(root, id) {
  const [, dependency, side] = pluginImport(id);
  if (side === "client") throw new Error(`Use ${id} in a window bundle through the window registry`);
  const types = readFileSync(resolve(generated(root), dependency, "public.d.ts"), "utf8");
  const refs = JSON.parse(/^\/\/ References: (.*)$/m.exec(types)?.[1] ?? "[]");
  if (
    !Array.isArray(refs) ||
    refs.some(
      ([key, address]) =>
        !ts.isIdentifierText(key, ts.ScriptTarget.Latest) ||
        !Array.isArray(address) ||
        address.length !== 2 ||
        address.some((part) => typeof part !== "string"),
    )
  )
    throw new Error(`Invalid public reference metadata for ${dependency}`);
  return (
    'import { createApi } from "@tokamak/sdk";\n' +
    `const references = createApi(${JSON.stringify(dependency)});\n` +
    refs
      .map(
        ([name, [module, method]]) =>
          `export const ${name} = references[${JSON.stringify(module)}][${JSON.stringify(method)}];`,
      )
      .join("\n") +
    `\nexport const api = {${refs.map(([name]) => name).join(",")}};\n`
  );
}

function pluginImport(id) {
  const match = specifier.exec(id);
  if (!match || !/^[a-z0-9][a-z0-9._-]*$/.test(match[1])) throw new Error(`Invalid plugin specifier ${id}`);
  return match;
}

function neighbourTypes(root, id) {
  const parent = dirname(root);
  for (const name of readdirSync(parent).sort()) {
    const dist = resolve(parent, name, "dist");
    try {
      const manifest = JSON.parse(readFileSync(resolve(dist, "manifest.json"), "utf8"));
      if (manifest.plugin?.id === id && manifest.entries?.types === "public.d.ts") {
        const bytes = readFileSync(resolve(dist, "public.d.ts"));
        if (createHash("sha256").update(bytes).digest("hex") === manifest.hashes?.["public.d.ts"])
          return bytes.toString("utf8");
      }
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code) && !(error instanceof SyntaxError))
        throw error;
    }
  }
}

function localDirectory() {
  if (process.env.TOKAMAK_SERVER_DIR) return process.env.TOKAMAK_SERVER_DIR;
  const home = homedir();
  // Match directories::ProjectDirs::data_local_dir, used by the desktop app.
  if (process.platform === "darwin")
    return resolve(home, "Library/Application Support/com.pixelscortex.Tokamak");
  if (process.platform === "win32")
    return resolve(process.env.LOCALAPPDATA ?? resolve(home, "AppData/Local"), "pixelscortex/Tokamak/data");
  return resolve(process.env.XDG_DATA_HOME || resolve(home, ".local/share"), "tokamak");
}

async function localTypes(id) {
  const directory = localDirectory();
  try {
    const catalog = await fetchLocal(directory, "/plugins");
    if (!catalog?.ok) return;
    const { plugins, revision } = await catalog.json();
    const manifest = plugins.find((entry) => entry.plugin.id === id);
    if (manifest?.entries.types !== "public.d.ts" || !/^[0-9a-f]{64}$/.test(revision)) return;
    const resource = await fetchLocal(directory, `/plugins/${id}/${revision}/assets/public.d.ts`);
    if (resource?.ok) return resource.text();
  } catch {
    // Discovery can disappear between reading the identity and fetching the file.
  }
}

export function pluginSlots(root, id) {
  const file = resolve(generated(root), pluginImport(`plugin:${id}/client`)[1], "public.d.ts");
  if (!existsSync(file)) return {};
  return JSON.parse(/^\/\/ Slots: (.*)$/m.exec(readFileSync(file, "utf8"))?.[1] ?? "{}");
}

async function declarePlugin(root, id, loaded, requireSide = true) {
  const [, dependency, side = "server"] = pluginImport(id);
  const directory = resolve(generated(root), dependency);
  if (!loaded.has(dependency)) {
    const types = neighbourTypes(root, dependency) ?? (await localTypes(dependency));
    if (types === undefined) throw new Error(`Plugin import ${id}: build or install "${dependency}" first.`);
    loaded.set(dependency, types);
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "public.d.ts"), types);
    for (const imported of ts.preProcessFile(types, true, true).importedFiles) {
      if (imported.fileName.startsWith("plugin:") && pluginImport(imported.fileName)[1] !== dependency)
        await declarePlugin(root, imported.fileName, loaded);
    }
  }
  const types = loaded.get(dependency);
  if (!types.includes(`declare module "plugin:${dependency}/${side}"`)) {
    if (!requireSide) return;
    throw new Error(`Plugin import ${id}: "${dependency}" has no public ${side} API`);
  }
  const sections = types.split(/^\/\/ Tokamak public (server|client) declarations\r?\n/m);
  const index = sections.indexOf(side);
  if (index < 0) throw new Error(`Invalid public declarations for ${dependency}`);
  writeFileSync(resolve(directory, `${side}-types.d.ts`), sections[index + 1]);
  writeFileSync(
    resolve(directory, `${side}.d.ts`),
    `/// <reference path="./${side}-types.d.ts" />\nexport * from "plugin-types:${dependency}/${side}/public";\n`,
  );
}

/** Check even erased type imports and unused source modules; tests are separate. */
export async function checkPluginImports(root, warn = () => {}, dependencies = []) {
  root = resolve(root);
  const imports = new Set();
  const warned = new Set();
  function checkFile(path) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const options = configuration(path).options;
    function check(id) {
      checkTokamakImport(id, path);
      if (id.startsWith("@ui-sdk/") && !warned.has(id)) {
        warned.add(id);
        warn(`Warning: direct import ${JSON.stringify(id)} in ${path} is unstable. Prefer @tokamak/ui.`);
      }
      if (id.startsWith("plugin:")) {
        imports.add(id);
        return;
      }
      if (id.startsWith("@plugins/") || id.startsWith("plugin-types:")) throw diagnostic(path, id);
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
  const loaded = new Map();
  for (const id of imports) await declarePlugin(root, id, loaded);
  for (const id of dependencies) await declarePlugin(root, `plugin:${id}`, loaded, false);
}

export function bunPluginReferences(root) {
  return {
    name: "plugin-references",
    setup(build) {
      build.onResolve({ filter: /^@tokamak\/sdk$/ }, () => ({
        path: resolve(sdkRoot, "src/index.ts"),
      }));
      build.onResolve({ filter: /^plugin:/ }, ({ path }) => ({ path, namespace: "plugin-reference" }));
      build.onLoad({ filter: /.*/, namespace: "plugin-reference" }, ({ path }) => ({
        contents: pluginReferenceSource(root, path),
        loader: "js",
        resolveDir: root,
      }));
    },
  };
}

export function bunPluginBoundary(root) {
  return {
    name: "plugin-import-boundary",
    setup(build) {
      bunPluginReferences(root).setup(build);
      build.onResolve({ filter: /.*/, namespace: "file" }, ({ path, importer }) => {
        if (!importer || !isAbsolute(importer) || isBuiltin(path)) return;
        const target = Bun.resolveSync(path, dirname(importer));
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
