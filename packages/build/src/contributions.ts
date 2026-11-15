/** Use the compiler's export/alias graph, as backend exports do. Keep TS 5.9.3:
 * 6.0.3 is the newest JS API release; 7.x has no JS API. Upgrading belongs to
 * a separate tooling change, not the plugin wire-format implementation. */
import ts from "typescript";
import { resolve } from "node:path";

const fields = { view: "route", itemRenderer: "type", toolbar: "label", command: "title", entityCard: "table" } as const;
export function uiContributions(root: string) {
  const entry = resolve(root, "src/main.tsx");
  const configPath = ts.findConfigFile(root, ts.sys.fileExists);
  const configResult = configPath ? ts.readConfigFile(configPath, ts.sys.readFile) : { config: {} };
  if (configResult.error) throw new Error(ts.flattenDiagnosticMessageText(configResult.error.messageText, "\n"));
  const config = configResult.config;
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  const program = ts.createProgram([entry], { ...parsed.options, noEmit: false, noEmitOnError: false,
    declaration: false, emitDeclarationOnly: false, sourceMap: false, module: ts.ModuleKind.ESNext });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new Error(`Missing plugin UI entry ${entry}`);
  const runtimeNames = emittedExports(program, checker);
  const runtime = runtimeNames(source);
  const original = (s: ts.Symbol): ts.Symbol => s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
  const module = checker.getSymbolAtLocation(source);
  const contributes: Record<string, { id: string; [key: string]: string }[]> = {};
  for (const exported of module ? checker.getExportsOfModule(module) : []) {
    if (!runtime.has(exported.name)) continue;
    const symbol = original(exported);
    const declaration = symbol.valueDeclaration;
    if (!declaration) continue;
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    const brand = type.getProperties().find(p => p.name.startsWith("__@contributionBrand@"));
    if (!brand) continue;
    const kindType = checker.getTypeOfSymbolAtLocation(brand, declaration);
    const fail = (): never => { throw new Error(`Invalid UI contribution ${exported.name}: use a contribution helper with static literal options`); };
    if (!kindType.isStringLiteral() || !(kindType.value in fields)) fail();
    const kind = (kindType as ts.StringLiteralType).value as keyof typeof fields;
    const values = contributionOptions(declaration, fields[kind], fail);
    if (kind === "view") validateRoute(values.route!, fail);
    (contributes[kind] ??= []).push({ id: exported.name, ...values });
  }
  return { contributes };
}

function emittedExports(program: ts.Program, checker: ts.TypeChecker) {
  // Inspect TS's emitted module syntax before bundler dead-code elimination.
  // This excludes type-only stars/aliases throughout re-export chains while
  // preserving declared exports after a top-level throw (never execute code).
  const emittedNames = new Map<ts.SourceFile, Set<string>>();
  function runtimeNames(file: ts.SourceFile): Set<string> {
    const cached = emittedNames.get(file);
    if (cached) return cached;
    const names = new Set<string>();
    emittedNames.set(file, names);
    let js = "";
    program.emit(file, (name, text) => { if (/\.[cm]?jsx?$/.test(name)) js = text; });
    const emitted = ts.createSourceFile(file.fileName, js, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function binding(name: ts.BindingName) {
      if (ts.isIdentifier(name)) names.add(name.text);
      else for (const element of name.elements) if (ts.isBindingElement(element)) binding(element.name);
    }
    for (const statement of emitted.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (statement.exportClause) {
          if (ts.isNamedExports(statement.exportClause)) for (const item of statement.exportClause.elements) names.add(item.name.text);
          else names.add(statement.exportClause.name.text);
        } else if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          const specifier = statement.moduleSpecifier.text;
          const original = file.statements.find((node): node is ts.ExportDeclaration => ts.isExportDeclaration(node)
            && !!node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === specifier);
          const target = original?.moduleSpecifier && checker.getSymbolAtLocation(original.moduleSpecifier);
          const source = target?.declarations?.find(ts.isSourceFile);
          if (source) for (const name of runtimeNames(source)) if (name !== "default") names.add(name);
        }
      } else if (ts.isExportAssignment(statement)) names.add("default");
      else if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        if (ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) names.add("default");
        else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) binding(declaration.name);
        else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.add(statement.name.text);
      }
    }
    return names;
  }
  return runtimeNames;
}

function contributionOptions(declaration: ts.Declaration, field: string, fail: () => never): Record<string, string> {
  let initializer = ts.isVariableDeclaration(declaration) ? declaration.initializer
    : ts.isExportAssignment(declaration) ? declaration.expression : undefined;
  while (initializer && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) || ts.isParenthesizedExpression(initializer))) initializer = initializer.expression;
  if (!initializer || !ts.isCallExpression(initializer)) fail();
  const call = initializer as ts.CallExpression;
  let options = call.arguments[0];
  while (options && (ts.isAsExpression(options) || ts.isSatisfiesExpression(options) || ts.isParenthesizedExpression(options))) options = options.expression;
  if (!options || !ts.isObjectLiteralExpression(options)) fail();
  const values: Record<string, string> = {};
  for (const property of (options as ts.ObjectLiteralExpression).properties) {
    if (!ts.isPropertyAssignment(property) || !property.name || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
      || !ts.isStringLiteralLike(property.initializer)) fail();
    const p = property as ts.PropertyAssignment;
    const key = (p.name as ts.Identifier).text;
    if (key !== field || key in values) fail();
    values[key] = (p.initializer as ts.StringLiteral).text;
  }
  if (!values[field]) fail();
  return values;
}

function validateRoute(route: string, fail: () => never): void {
  if (!route.startsWith("/") || route.startsWith("//") || /[\\\x00-\x20\x7f?#]/.test(route)) fail();
  const names = new Set<string>();
  const segments = route.slice(1).split("/");
  for (const [index, part] of segments.entries()) {
    if (!part.startsWith(":") && !part.startsWith("*")) continue;
    const name = part.slice(1);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || names.has(name)
      || (part.startsWith("*") && index !== segments.length - 1)) fail();
    names.add(name);
  }
}
