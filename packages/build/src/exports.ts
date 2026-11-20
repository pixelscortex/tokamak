import { readPluginCompilerOptions, runtimeExportNames } from "../../sdk/tools/plugin-boundary.mjs";
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
  const program = ts.createProgram([path, resolve(serverDirectory(root), "_generated/api.ts")], {
    ...readPluginCompilerOptions(root, serverDirectory(root)),
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
  const runtime = runtimeExportNames(checker, module!);
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
