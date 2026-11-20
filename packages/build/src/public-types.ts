import { existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import {
  pluginCompilerOptions,
  publicReferences,
  readPluginCompilerOptions,
} from "../../sdk/tools/plugin-boundary.mjs";
import { clientEntry, serverDirectory } from "./descriptor.ts";
import { selectDeclarations, type Names } from "./declaration-surface.ts";
import { preserveReturnNames } from "./declaration-names.ts";
import { sharedImports } from "./shared-libraries.mts";

const shared = new Set(sharedImports);
const quote = JSON.stringify;
const ambient = (name: string, body: string) => `declare module ${quote(name)} {\n${body}\n}\n`;

function validatePublished(root: string, id: string, text: string) {
  const options: ts.CompilerOptions = pluginCompilerOptions(root, {
    noEmit: true,
    strict: true,
    skipLibCheck: false,
    types: [],
    jsx: ts.JsxEmit.Preserve,
    jsxImportSource: "@solidjs/web",
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  });
  const file = resolve(root, ".tokamak/public.d.ts");
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, ...args) =>
    path === file ? ts.createSourceFile(file, text, args[0], true) : getSourceFile(path, ...args);
  host.resolveModuleNames = (names, importer) =>
    names.map((name) => {
      if (
        (importer === file || importer.startsWith(resolve(root, ".tokamak/types") + sep)) &&
        !shared.has(name) &&
        !name.startsWith("plugin:")
      )
        return undefined;
      return ts.resolveModuleName(name, importer, options, host).resolvedModule;
    });
  const program = ts.createProgram([file], options, host);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter(
      (d) => d.file?.fileName === file || d.file?.fileName.startsWith(resolve(root, ".tokamak/types") + sep),
    );
  if (diagnostics.length)
    throw new Error(
      `Cannot publish public types for ${id}: ${diagnostics
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))
        .join("; ")}`,
    );
}

export function publicTypes(root: string, id: string, targets: { backend?: false; ui?: false }) {
  let output = "";
  for (const side of ["server", "client"] as const) {
    if (side === "server" ? targets.backend === false : targets.ui === false) continue;
    const entry =
      side === "server"
        ? [resolve(serverDirectory(root), "api.ts"), resolve(root, "api.ts")].find(existsSync)
        : clientEntry(root);
    if (
      !entry ||
      (side === "client" &&
        !["api.ts", "api.tsx"].some((file) => entry === resolve(root, "src/client", file)))
    )
      continue;
    output += `// Tokamak public ${side} declarations\n`;
    const options: ts.CompilerOptions = {
      ...readPluginCompilerOptions(root, dirname(entry), side === "client"),
      noEmit: false,
      declaration: true,
      declarationMap: false,
      removeComments: true,
      emitDeclarationOnly: true,
      noEmitOnError: false,
      incremental: false,
      composite: false,
    };
    const entries = [entry, ...(options.paths?.["@tokamak/sdk"] ?? [])];
    const program = preserveReturnNames(ts.createProgram(entries, options), entries, root + sep);
    const checker = program.getTypeChecker();
    function sharedExport(file: string, exported: string) {
      for (const specifier of shared) {
        const path = options.paths?.[specifier]?.[0];
        const source = path ? program.getSourceFile(path) : undefined;
        const module = source && checker.getSymbolAtLocation(source);
        const symbol = module && checker.getExportsOfModule(module).find((item) => item.name === exported);
        const original =
          symbol && (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
        if (original?.declarations?.some((item) => item.getSourceFile().fileName === file)) return specifier;
      }
    }
    const prefix = `plugin-types:${id}/${side}/`;
    const name = (file: string) => prefix + relative(root, file).split(sep).join("/");
    const visited = new Map<string, Names>();
    const rendered = new Map<string, string>();
    function emit(file: string, requested?: Names) {
      if (visited.has(file)) {
        const previous = visited.get(file);
        if (!previous || (requested && [...requested].every((key) => previous.has(key)))) return;
        if (requested) requested = new Set([...previous, ...requested]);
      }
      visited.set(file, requested);
      const original = program.getSourceFile(file);
      if (!original) throw new Error(`Missing declaration source for ${file}`);
      let text = original.isDeclarationFile ? original.text : undefined;
      const result = original.isDeclarationFile
        ? undefined
        : program.emit(original, (_path, source) => (text = source), undefined, true);
      const diagnostic = result?.diagnostics[0];
      if (text === undefined || diagnostic)
        throw new Error(
          `Cannot publish public types for ${id}: ${diagnostic ? ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n") + " Write the export's return type explicitly." : file}`,
        );
      const parsed = ts.createSourceFile(file + ".d.ts", text, ts.ScriptTarget.Latest, true);
      const selected = selectDeclarations(parsed, requested);
      text = selected.text;
      const source = ts.createSourceFile(parsed.fileName, text, ts.ScriptTarget.Latest, true);
      const edits: [number, number, string][] = [];
      function rewrite(node: ts.Node) {
        if (
          ts.isStringLiteralLike(node) &&
          (((ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) &&
            node.parent.moduleSpecifier === node) ||
            (ts.isExternalModuleReference(node.parent) && node.parent.expression === node) ||
            (ts.isLiteralTypeNode(node.parent) &&
              ts.isImportTypeNode(node.parent.parent) &&
              node.parent.parent.argument === node.parent))
        ) {
          const specifier = node.text;
          if (
            shared.has(specifier) ||
            /^plugin:[a-z0-9][a-z0-9._-]*(?:\/(?:server|client))?$/.test(specifier)
          )
            return;
          const target = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule;
          const imported = ts.isLiteralTypeNode(node.parent) ? node.parent.parent : undefined;
          if (
            target &&
            imported &&
            ts.isImportTypeNode(imported) &&
            imported.qualifier &&
            ts.isIdentifier(imported.qualifier)
          ) {
            const publicPath = sharedExport(target.resolvedFileName, imported.qualifier.text);
            if (publicPath) {
              edits.push([node.getStart(source), node.end, quote(publicPath)]);
              return;
            }
          }
          if (!target || target.isExternalLibraryImport || !target.resolvedFileName.startsWith(root + sep)) {
            const statement = imported ?? node.parent;
            throw new Error(
              `Cannot publish public types for ${id}: ${statement.getText(source)} refers to non-shared library ${specifier}`,
            );
          }
          const selectedNames =
            imported &&
            ts.isImportTypeNode(imported) &&
            imported.qualifier &&
            ts.isIdentifier(imported.qualifier)
              ? new Set([imported.qualifier.text])
              : undefined;
          emit(
            target.resolvedFileName,
            selected.requests.has(specifier) ? selected.requests.get(specifier) : selectedNames,
          );
          edits.push([node.getStart(source), node.end, quote(name(target.resolvedFileName))]);
        }
        ts.forEachChild(node, rewrite);
      }
      rewrite(source);
      for (const statement of source.statements) {
        for (const modifier of ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : []) {
          if (modifier.kind === ts.SyntaxKind.DeclareKeyword)
            edits.push([modifier.getStart(source), modifier.end, ""]);
        }
      }
      for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0]))
        text = text.slice(0, start) + replacement + text.slice(end);
      if (visited.get(file) === requested) rendered.set(file, ambient(name(file), text));
    }
    emit(entry);
    output += [...rendered.values()].join("");
    const entryModule = quote(name(entry));
    const surface = prefix + "public";
    if (side === "client") {
      const source = program.getSourceFile(entry)!;
      const module = checker.getSymbolAtLocation(source);
      const slots = Object.fromEntries(
        (module ? checker.getExportsOfModule(module) : []).flatMap((exported) => {
          const symbol =
            exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
          const declaration = symbol.valueDeclaration;
          const init = declaration && ts.isVariableDeclaration(declaration) && declaration.initializer;
          const name = init && ts.isCallExpression(init) && init.arguments[0];
          if (
            !name ||
            !ts.isStringLiteralLike(name) ||
            !checker.getTypeOfSymbolAtLocation(symbol, declaration!).getProperty("props")
          )
            return [];
          return [[exported.name, name.text]];
        }),
      );
      output += `// Slots: ${JSON.stringify(slots)}\n`;
      output += ambient(surface, `export * from ${entryModule};`);
    } else {
      const { refs } = publicReferences(root, entry);
      output += `// References: ${JSON.stringify(refs)}\n`;
      output += ambient(
        surface,
        `export type * from ${entryModule};\n` +
          `type PublicApi = import("@tokamak/sdk").ApiFromModule<typeof import(${entryModule})>;\n` +
          "export const api: PublicApi;\n" +
          refs.map(([key]) => `export const ${key}: PublicApi[${quote(key)}];\n`).join(""),
      );
      output += ambient(`plugin:${id}`, `export * from "plugin:${id}/server";`);
    }
    output += ambient(`plugin:${id}/${side}`, `export * from ${quote(surface)};`);
  }
  validatePublished(root, id, output);
  return output;
}
