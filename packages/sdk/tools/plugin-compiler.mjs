import { Visibility } from "../src/visibility.ts";
import ts from "typescript";
import { resolve } from "node:path";

export const generated = (root) => resolve(root, ".tokamak/types");

export function pluginCompilerOptions(root, options) {
  // Resolve inherited paths at their declaring config, before adding our own.
  const base = options.baseUrl ?? options.pathsBasePath ?? root;
  const paths = Object.fromEntries(
    Object.entries(options.paths ?? {}).map(([key, values]) => [
      key,
      values.map((value) => resolve(base, value)),
    ]),
  );
  return {
    ...options,
    paths: {
      ...paths,
      "plugin:*/tables": [resolve(generated(root), "*/tables.d.ts")],
      "plugin:*/contracts": [resolve(generated(root), "*/contracts.d.ts")],
      "plugin:*/server": [resolve(generated(root), "*/server.d.ts")],
      "plugin:*/client": [resolve(generated(root), "*/client.d.ts")],
      "plugin:*": [resolve(generated(root), "*/server.d.ts")],
    },
  };
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

export function definitionInfo(checker, symbol, source) {
  return definitionTypeInfo(checker, checker.getTypeOfSymbolAtLocation(symbol, source), source);
}

export function definitionTypeInfo(checker, type, source) {
  if (!type.getProperties().some((property) => property.name.startsWith("__@definitionBrand@"))) return;
  const kind = type.getProperty("kind");
  const property = type.getProperty("visibility");
  const visibility = property && checker.getTypeOfSymbolAtLocation(property, source).value;
  return {
    kind: kind && checker.getTypeOfSymbolAtLocation(kind, source).value,
    visibility: Object.values(Visibility).includes(visibility) ? visibility : undefined,
  };
}
