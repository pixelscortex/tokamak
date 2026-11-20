import ts from "typescript";

export type Names = Set<string> | undefined; // undefined means all exports

const modifiers = (node: ts.Node) => (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []);
const has = (node: ts.Node, kind: ts.SyntaxKind) => modifiers(node).some((m) => m.kind === kind);

function bindings(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.flatMap((d) =>
      ts.isIdentifier(d.name) ? [d.name.text] : [],
    );
  if ("name" in statement && statement.name && ts.isIdentifier(statement.name as ts.Node))
    return [(statement.name as ts.Identifier).text];
  return [];
}

export function selectDeclarations(source: ts.SourceFile, requested: Names) {
  const locals = new Set<string>();
  const retained = new Set<ts.Statement>();
  const f = ts.factory;

  // TypeScript can emit multiple exports under one variable declaration list.
  // Keep them independently so an unrelated binding cannot pull in its types.
  const statements = source.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) && statement.declarationList.declarations.length > 1
      ? statement.declarationList.declarations.map((declaration) =>
          f.updateVariableStatement(
            statement,
            statement.modifiers,
            f.updateVariableDeclarationList(statement.declarationList, [declaration]),
          ),
        )
      : [statement],
  );

  function reference(node: ts.Node) {
    if (
      ts.isIdentifier(node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(ts.isQualifiedName(node.parent) && node.parent.right === node)
    )
      locals.add(node.text);
    ts.forEachChild(node, reference);
  }

  const replacements = new Map<ts.Statement, ts.Statement>();
  const requests = new Map<string, Names>();
  function need(module: string, names: Names) {
    if (!requests.has(module)) requests.set(module, names);
    else {
      const current = requests.get(module);
      requests.set(module, current && names ? new Set([...current, ...names]) : undefined);
    }
  }
  for (const statement of statements) {
    if (ts.isExportDeclaration(statement)) {
      const from = statement.moduleSpecifier;
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        const elements = clause.elements.filter((item) => !requested || requested.has(item.name.text));
        if (!elements.length) continue;
        replacements.set(
          statement,
          f.updateExportDeclaration(
            statement,
            statement.modifiers,
            statement.isTypeOnly,
            f.updateNamedExports(clause, elements),
            from,
            statement.attributes,
          ),
        );
        if (from && ts.isStringLiteral(from))
          need(from.text, new Set(elements.map((item) => (item.propertyName ?? item.name).text)));
        else for (const item of elements) locals.add((item.propertyName ?? item.name).text);
      } else {
        if (clause && requested && !requested.has(clause.name.text)) continue;
        if (from && ts.isStringLiteral(from)) need(from.text, clause ? undefined : requested);
      }
      retained.add(statement);
    } else if (
      ts.isExportAssignment(statement)
        ? !requested || requested.has("default")
        : has(statement, ts.SyntaxKind.ExportKeyword) &&
          (!requested ||
            (has(statement, ts.SyntaxKind.DefaultKeyword)
              ? requested.has("default")
              : bindings(statement).some((name) => requested.has(name))))
    ) {
      retained.add(statement);
      reference(statement);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of statements) {
      if (retained.has(statement) || !bindings(statement).some((name) => locals.has(name))) continue;
      retained.add(statement);
      reference(statement);
      changed = true;
    }
  }

  for (const statement of statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    const name = clause.name && locals.has(clause.name.text) ? clause.name : undefined;
    const named = clause.namedBindings;
    const selected =
      named &&
      (ts.isNamespaceImport(named)
        ? locals.has(named.name.text)
          ? named
          : undefined
        : f.updateNamedImports(
            named,
            named.elements.filter((item) => locals.has(item.name.text)),
          ));
    const bindings =
      selected && (ts.isNamespaceImport(selected) || selected.elements.length) ? selected : undefined;
    if (!name && !bindings) continue;
    const names =
      bindings && ts.isNamedImports(bindings)
        ? bindings.elements.map((item) => (item.propertyName ?? item.name).text)
        : [];
    need(
      statement.moduleSpecifier.text,
      bindings && ts.isNamespaceImport(bindings)
        ? undefined
        : new Set([...names, ...(name ? ["default"] : [])]),
    );
    retained.add(statement);
    replacements.set(
      statement,
      f.updateImportDeclaration(
        statement,
        statement.modifiers,
        f.updateImportClause(clause, clause.isTypeOnly, name, bindings),
        statement.moduleSpecifier,
        statement.attributes,
      ),
    );
  }
  const printer = ts.createPrinter({ removeComments: true });
  const text = statements
    .filter((node) => retained.has(node))
    .map((node) => printer.printNode(ts.EmitHint.Unspecified, replacements.get(node) ?? node, source))
    .join("\n");
  return { text, requests };
}
