import { dirname } from "node:path";
import { readPluginCompilerOptions } from "../../sdk/tools/plugin-boundary.mjs";
import { clientEntry } from "./descriptor.ts";
/** Use the compiler's export/alias graph, as backend exports do. Keep TS 5.9.3:
 * 6.0.3 is the newest JS API release; 7.x has no JS API. Upgrading belongs to
 * a separate tooling change, not the plugin wire-format implementation. */
import ts from "typescript";

const fields = {
  fill: "target",
  wrap: "target",
  replace: "target",
  view: "route",
  itemRenderer: "type",
  toolbar: "label",
  command: "title",
  entityCard: "table",
} as const;
/** Options a kind may also carry; each must be a string the compiler can read statically. */
const optional: Partial<Record<keyof typeof fields, readonly string[]>> = { view: ["icon"] };
export function uiContributions(root: string) {
  const entry = clientEntry(root);
  const program = ts.createProgram([entry], {
    ...readPluginCompilerOptions(root, dirname(entry), true),
    noEmit: false,
    noEmitOnError: false,
    declaration: false,
    emitDeclarationOnly: false,
    sourceMap: false,
    module: ts.ModuleKind.ESNext,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new Error(`Missing plugin UI entry ${entry}`);
  const runtimeNames = emittedExports(program, checker);
  const runtime = runtimeNames(source);
  const original = (s: ts.Symbol): ts.Symbol =>
    s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
  const module = checker.getSymbolAtLocation(source);
  const contributes: Record<string, { id: string; [key: string]: string | number }[]> = {};
  for (const exported of module ? checker.getExportsOfModule(module) : []) {
    if (!runtime.has(exported.name)) continue;
    const symbol = original(exported);
    const declaration = symbol.valueDeclaration;
    if (!declaration) continue;
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    const brand = type.getProperties().find((p) => p.name.startsWith("__@contributionBrand@"));
    if (!brand) continue;
    const kindType = checker.getTypeOfSymbolAtLocation(brand, declaration);
    const fail = (): never => {
      throw new Error(
        `Invalid UI contribution ${exported.name}: use a contribution helper with static literal options`,
      );
    };
    if (!kindType.isStringLiteral() || !(kindType.value in fields)) fail();
    const kind = (kindType as ts.StringLiteralType).value as keyof typeof fields;
    const values = ["fill", "wrap", "replace"].includes(kind)
      ? extensionOptions(declaration, kind, checker, fail)
      : contributionOptions(declaration, fields[kind], optional[kind] ?? [], checker, fail);
    if (kind === "view") validateRoute(String(values.route!), fail);
    if (values.icon !== undefined) validateIcon(String(values.icon), fail);
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
    program.emit(file, (name, text) => {
      if (/\.[cm]?jsx?$/.test(name)) js = text;
    });
    const emitted = ts.createSourceFile(file.fileName, js, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function binding(name: ts.BindingName) {
      if (ts.isIdentifier(name)) names.add(name.text);
      else for (const element of name.elements) if (ts.isBindingElement(element)) binding(element.name);
    }
    for (const statement of emitted.statements) {
      if (ts.isExportDeclaration(statement)) addReexports(statement, file, names, runtimeNames, checker);
      else addDeclaration(statement, names, binding);
    }
    return names;
  }
  return runtimeNames;
}

function contributionOptions(
  declaration: ts.Declaration,
  field: string,
  extra: readonly string[],
  checker: ts.TypeChecker,
  fail: () => never,
): Record<string, string> {
  let initializer = ts.isVariableDeclaration(declaration)
    ? declaration.initializer
    : ts.isExportAssignment(declaration)
      ? declaration.expression
      : undefined;
  initializer = unwrap(initializer);
  if (!initializer || !ts.isCallExpression(initializer)) fail();
  const call = initializer as ts.CallExpression;
  let options: ts.Expression | undefined = call.arguments[0];
  options = unwrap(options);
  if (!options || !ts.isObjectLiteralExpression(options)) fail();
  const values: Record<string, string> = {};
  for (const property of (options as ts.ObjectLiteralExpression).properties) {
    if (!ts.isPropertyAssignment(property) || !property.name) fail();
    const name = (property as ts.PropertyAssignment).name;
    const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : fail();
    if ((key !== field && !extra.includes(key)) || key in values) fail();
    // The required field stays a literal; extras may also name a const string.
    values[key] =
      key === field
        ? (literalProperty(property, fail).initializer as ts.StringLiteral).text
        : constantString((property as ts.PropertyAssignment).initializer, checker, fail);
  }
  if (!values[field]) fail();
  return values;
}

function constantString(expression: ts.Expression, checker: ts.TypeChecker, fail: () => never): string {
  const value = unwrap(expression)!;
  if (ts.isStringLiteralLike(value)) return value.text;
  const type = checker.getTypeAtLocation(value);
  return type.isStringLiteral() ? type.value : fail();
}

function validateIcon(icon: string, fail: () => never): void {
  if (!icon || icon.length > 8192 || !/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/.test(icon)) fail();
}

function validateRoute(route: string, fail: () => never): void {
  if (!route.startsWith("/") || route.startsWith("//") || /[\\\x00-\x20\x7f?#]/.test(route)) fail();
  const names = new Set<string>();
  const segments = route.slice(1).split("/");
  for (const [index, part] of segments.entries()) {
    if (!part.startsWith(":") && !part.startsWith("*")) continue;
    const name = part.slice(1);
    if (
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(name) ||
      names.has(name) ||
      (part.startsWith("*") && index !== segments.length - 1)
    )
      fail();
    names.add(name);
  }
}

function addReexports(
  statement: ts.ExportDeclaration,
  file: ts.SourceFile,
  names: Set<string>,
  runtimeNames: (file: ts.SourceFile) => Set<string>,
  checker: ts.TypeChecker,
) {
  if (statement.exportClause) {
    if (ts.isNamedExports(statement.exportClause))
      for (const item of statement.exportClause.elements) names.add(item.name.text);
    else names.add(statement.exportClause.name.text);
  } else if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
    const specifier = statement.moduleSpecifier.text;
    const original = file.statements.find(
      (node): node is ts.ExportDeclaration =>
        ts.isExportDeclaration(node) &&
        !!node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === specifier,
    );
    const target = original?.moduleSpecifier && checker.getSymbolAtLocation(original.moduleSpecifier);
    const source = target?.declarations?.find(ts.isSourceFile);
    if (source) for (const name of runtimeNames(source)) if (name !== "default") names.add(name);
  }
}

function addDeclaration(
  statement: ts.Statement,
  names: Set<string>,
  binding: (name: ts.BindingName) => void,
) {
  if (ts.isExportAssignment(statement)) names.add("default");
  else if (
    ts.canHaveModifiers(statement) &&
    ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    if (ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
      names.add("default");
    else if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) binding(declaration.name);
    else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name)
      names.add(statement.name.text);
  }
}

function unwrap(expression: ts.Expression | undefined): ts.Expression | undefined {
  while (
    expression &&
    (ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isParenthesizedExpression(expression))
  )
    expression = expression.expression;
  return expression;
}

function literalProperty(property: ts.ObjectLiteralElementLike, fail: () => never): ts.PropertyAssignment {
  if (
    !ts.isPropertyAssignment(property) ||
    !property.name ||
    (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name)) ||
    !ts.isStringLiteralLike(property.initializer)
  )
    fail();
  return property as ts.PropertyAssignment;
}

function extensionOptions(
  declaration: ts.Declaration,
  kind: string,
  checker: ts.TypeChecker,
  fail: () => never,
): Record<string, string | number> {
  const init = unwrap(ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined);
  if (!init || !ts.isCallExpression(init)) return fail();
  const target = init.arguments[0];
  if (!target) return fail();
  let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(target) ? target.name : target);
  if (!symbol) return fail();
  // The importing module identifies the owner; follow aliases for slot names.
  let owner: string | undefined;
  let exported = symbol.name;
  for (const d of symbol.declarations ?? []) {
    let n: ts.Node | undefined = d;
    if (ts.isImportSpecifier(d)) exported = (d.propertyName ?? d.name).text;
    while (n && !ts.isImportDeclaration(n)) n = n.parent;
    if (n && ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier))
      owner = (
        /^@plugins\/([^/]+)(?:\/ui)?$/.exec(n.moduleSpecifier.text) ??
        /^plugin:([^/]+)\/client$/.exec(n.moduleSpecifier.text)
      )?.[1];
  }
  if (ts.isPropertyAccessExpression(target)) {
    const ns = checker.getSymbolAtLocation(target.expression);
    for (const d of ns?.declarations ?? []) {
      let n: ts.Node | undefined = d;
      while (n && !ts.isImportDeclaration(n)) n = n.parent;
      if (n && ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier))
        owner = (
          /^@plugins\/([^/]+)(?:\/ui)?$/.exec(n.moduleSpecifier.text) ??
          /^plugin:([^/]+)\/client$/.exec(n.moduleSpecifier.text)
        )?.[1];
    }
  }
  if (!owner) return fail();
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const values: Record<string, string | number> = { target: `${owner}.${exported}` };
  if (kind === "fill") {
    const d = symbol.valueDeclaration;
    const slot = d && ts.isVariableDeclaration(d) && d.initializer;
    if (
      !slot ||
      !ts.isCallExpression(slot) ||
      !slot.arguments[0] ||
      !ts.isStringLiteralLike(slot.arguments[0])
    )
      return fail();
    values.target = `${owner}.${slot.arguments[0].text}`;
    const options = unwrap(init.arguments[1]);
    if (!options || !ts.isObjectLiteralExpression(options)) return fail();
    for (const p of options.properties) {
      if (!ts.isPropertyAssignment(p) || (!ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name)))
        return fail();
      const key = p.name.text;
      if (key === "id" && ts.isStringLiteralLike(p.initializer)) values.fillId = p.initializer.text;
      else if (key === "order" && ts.isNumericLiteral(p.initializer))
        values.order = Number(p.initializer.text);
      else if (
        key === "order" &&
        ts.isPrefixUnaryExpression(p.initializer) &&
        p.initializer.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(p.initializer.operand)
      )
        values.order = -Number(p.initializer.operand.text);
      else return fail();
    }
  }
  return values;
}
