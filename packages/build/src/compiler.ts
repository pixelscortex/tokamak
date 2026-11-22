import { isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

export function inSource(root: string, file: string) {
  const local = relative(resolve(root, "src"), file);
  return (
    isAbsolute(file) && local !== "" && local !== ".." && !isAbsolute(local) && !local.startsWith(".." + sep)
  );
}

export type Element = ts.JsxElement | ts.JsxSelfClosingElement;
export type ElementMount = { prefix: string; suffix: string };

export function unalias(checker: ts.TypeChecker, symbol: ts.Symbol) {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

export function brand(type: ts.Type, name: string) {
  return type.getProperties().find((p) => p.name.startsWith(`__@${name}@`));
}

export function unwrap(expression: ts.Expression | undefined): ts.Expression | undefined {
  while (
    expression &&
    (ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isParenthesizedExpression(expression))
  )
    expression = expression.expression;
  return expression;
}

export function exportedInitializer(declaration: ts.Declaration) {
  return unwrap(
    ts.isVariableDeclaration(declaration)
      ? declaration.initializer
      : ts.isExportAssignment(declaration)
        ? declaration.expression
        : undefined,
  );
}

export function importModule(node: ts.Node | undefined) {
  while (node && !ts.isImportDeclaration(node)) node = node.parent;
  const specifier = node?.moduleSpecifier;
  return specifier && ts.isStringLiteral(specifier) ? specifier.text : undefined;
}
