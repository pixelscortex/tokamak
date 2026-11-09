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
  const program = ts.createProgram([entry], { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new Error(`Missing plugin UI entry ${entry}`);
  const original = (s: ts.Symbol): ts.Symbol => s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
  const module = checker.getSymbolAtLocation(source);
  const contributes: Record<string, { id: string; [key: string]: string }[]> = {};
  for (const exported of module ? checker.getExportsOfModule(module) : []) {
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
      if (key !== fields[kind] || key in values) fail();
      values[key] = (p.initializer as ts.StringLiteral).text;
    }
    if (!values[fields[kind]]) fail();
    if (kind === "view") {
      const route = values.route!;
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
    (contributes[kind] ??= []).push({ id: exported.name, ...values });
  }
  const depends = new Set<string>();
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || program.isSourceFileFromExternalLibrary(file)) continue;
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.isTypeOnly || (clause && !clause.name && clause.namedBindings
          && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.every(e => e.isTypeOnly))) return;
      }
      if (ts.isExportDeclaration(node) && (node.isTypeOnly || (node.exportClause
        && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every(e => e.isTypeOnly)))) return;
      const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
      if (specifier && ts.isStringLiteral(specifier)) {
        const match = /^@plugins\/([^/]+)(?:\/ui)?$/.exec(specifier.text);
        if (match) depends.add(match[1]!);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  return { contributes, depends: [...depends].sort() };
}
