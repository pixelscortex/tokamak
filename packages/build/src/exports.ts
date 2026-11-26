import { Visibility } from "../../sdk/src/visibility";
import {
  definitionInfo,
  pluginCompilerOptions,
  runtimeExportNames,
  serverConfigPath,
} from "../../sdk/tools/plugin-compiler.mjs";
import { isServerModule, serverDirectory } from "../../sdk/tools/server-files.mjs";
import { serverModule } from "./descriptor.ts";
/** Resolve public aliases with the compiler so re-exports never execute plugin code. */
import ts from "typescript";
import { relative, resolve, sep } from "node:path";

export function exportedFunctions(root: string, entry: string | undefined) {
  const empty = { publicFunctions: [] as string[], pluginFunctions: [] as string[] };
  if (entry === undefined) return empty;
  const path = resolve(root, entry);
  const fail = (message: string): never => {
    throw new Error(`Invalid plugin exports ${entry}: ${message}`);
  };
  if (!ts.sys.fileExists(path)) fail("file does not exist");
  const configPath = serverConfigPath(serverDirectory(root), root);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) fail(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(configPath, ".."));
  const program = ts.createProgram([path, resolve(serverDirectory(root), "_generated/api.ts")], {
    ...pluginCompilerOptions(root, parsed.options),
    noEmit: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    fail(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(path)!;
  const module = checker.getSymbolAtLocation(source);
  if (!module) fail("expected a module re-exporting server functions");
  const original = (symbol: ts.Symbol): ts.Symbol =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const names = serverFunctionNames(root, program, checker, original);
  const runtime = runtimeExportNames(checker, module!);
  const result = new Set<string>();
  const pluginOnly = new Set<string>();
  for (const exported of checker.getExportsOfModule(module!)) {
    if (!runtime.has(exported.getName())) continue;
    const target = original(exported);
    const targets = names.get(target);
    if (!targets) continue;
    const info = definitionInfo(checker, target, source);
    if (!info?.visibility || info.visibility === Visibility.Internal)
      fail(`internal function ${exported.getName()} cannot be exported`);
    for (const name of targets!) (info?.visibility === Visibility.PluginOnly ? pluginOnly : result).add(name);
  }
  return { publicFunctions: [...result].sort(), pluginFunctions: [...pluginOnly].sort() };
}

function serverFunctionNames(
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
      const definition = definitionInfo(checker, target, file);
      if (!definition || definition.kind === "httpAction") continue;
      const list = names.get(target) ?? [];
      list.push(`${serverModule(root, local.slice(0, -3))}:${exported.getName()}`);
      names.set(target, list);
    }
  }
  return names;
}
