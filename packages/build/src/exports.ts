import { isServerModule } from "../../sdk/tools/server-files.mjs";
import { serverDirectory, serverModule } from "./descriptor.ts";
/** Resolve public aliases with the compiler so re-exports never execute plugin code. */
import ts from "typescript";
import { relative, resolve, sep } from "node:path";

export function publicFunctions(root: string, entry: string | undefined): string[] {
  if (entry === undefined) return [];
  const path = resolve(root, entry);
  const fail = (message: string): never => {
    throw new Error(`Invalid plugin exports ${entry}: ${message}`);
  };
  if (!ts.sys.fileExists(path)) fail("file does not exist");
  const configPath = ts.findConfigFile(serverDirectory(root), ts.sys.fileExists);
  const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile) : { config: {} };
  if (config.error) fail(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    configPath ? resolve(configPath, "..") : root,
  );
  const program = ts.createProgram([path, resolve(serverDirectory(root), "_generated/api.ts")], {
    ...parsed.options,
    noEmit: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    fail(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(path)!;
  const module = checker.getSymbolAtLocation(source);
  if (!module) fail("expected a module re-exporting backend functions");
  const original = (symbol: ts.Symbol): ts.Symbol =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const names = backendFunctionNames(root, program, checker, original);
  function runtimeExports(module: ts.Symbol, seen = new Set<ts.Symbol>()): Set<string> {
    if (seen.has(module)) return new Set();
    seen.add(module);
    const file = module.declarations?.find(ts.isSourceFile);
    if (!file) return new Set();
    const names = localValueNames(checker, module, file);
    for (const statement of file.statements) {
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
      if (!statement.exportClause) {
        if (!statement.moduleSpecifier) continue;
        const target = checker.getSymbolAtLocation(statement.moduleSpecifier);
        if (!target) continue;
        for (const name of runtimeExports(target, new Set(seen))) {
          if (name !== "default") names.add(name);
        }
        continue;
      }
      addExportClause(statement.exportClause, names);
    }
    return names;
  }
  const runtime = runtimeExports(module!);
  const result = new Set<string>();
  for (const exported of checker.getExportsOfModule(module!)) {
    if (!runtime.has(exported.getName())) continue;
    const targets = names.get(original(exported));
    if (!targets) continue;
    for (const target of targets!) result.add(target);
  }
  return [...result].sort();
}

function backendFunctionNames(
  root: string,
  program: ts.Program,
  checker: ts.TypeChecker,
  original: (symbol: ts.Symbol) => ts.Symbol,
) {
  const names = new Map<ts.Symbol, string[]>();
  for (const file of program.getSourceFiles()) {
    const local = relative(serverDirectory(root), file.fileName).split(sep).join("/");
    if (!isServerModule(serverDirectory(root), local)) continue;
    const symbol = checker.getSymbolAtLocation(file);
    if (!symbol) continue;
    for (const exported of checker.getExportsOfModule(symbol)) {
      const target = original(exported);
      const type = checker.getTypeOfSymbolAtLocation(target, file);
      // Match the SDK's unique definition brand, rather than accepting helpers
      // that happen to have a query-like name or an invoke method.
      if (!type.getProperties().some((property) => property.getName().startsWith("__@definitionBrand@")))
        continue;
      const list = names.get(target) ?? [];
      list.push(`${serverModule(root, local.slice(0, -3))}:${exported.getName()}`);
      names.set(target, list);
    }
  }
  return names;
}

function localValueNames(checker: ts.TypeChecker, module: ts.Symbol, file: ts.SourceFile) {
  const names = new Set(
    checker
      .getExportsOfModule(module)
      .filter(
        (symbol) =>
          symbol.flags & ts.SymbolFlags.Value &&
          symbol.declarations?.some((declaration) => declaration.getSourceFile() === file),
      )
      .map((symbol) => symbol.getName()),
  );
  return names;
}

function addExportClause(clause: ts.NamedExportBindings, names: Set<string>) {
  if (!ts.isNamedExports(clause)) {
    names.add(clause.name.text);
    return;
  }
  for (const item of clause.elements) {
    if (!item.isTypeOnly) names.add(item.name.text);
  }
}
