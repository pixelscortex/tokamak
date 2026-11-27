import { dirname, isAbsolute, join, relative } from "node:path";
import ts from "typescript";
import { importModule, inSource, unalias } from "./compiler.ts";

export function partProps(
  entry: ts.SourceFile,
  checker: ts.TypeChecker,
  root: string,
  sources: ts.SourceFile[],
) {
  const typeNames = new Map<string, string>();
  const modules = new Set<ts.Symbol>();
  const modulePath = (file: string) => file.replace(/(?:\.d)?\.[cm]?tsx?$/, "");
  for (const source of sources) {
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (specifier.startsWith(".") || isAbsolute(specifier)) continue;
      const imported = checker.getSymbolAtLocation(statement.moduleSpecifier);
      if (!imported || modules.has(imported)) continue;
      modules.add(imported);
      for (const member of checker.getExportsOfModule(imported)) {
        const original = unalias(checker, member);
        for (const declaration of original.declarations ?? []) {
          const file = declaration.getSourceFile().fileName;
          typeNames.set(
            `${modulePath(file)}:${original.name}`,
            `import(${JSON.stringify(specifier)}).${member.name}`,
          );
        }
      }
    }
  }

  const privateTypes = new Map<ts.Declaration, string>();
  const privateShapes = new Map<string, string>();
  const localImport = (file: string) => {
    const path = relative(join(dirname(entry.fileName), "_generated"), modulePath(file)).replaceAll(
      "\\",
      "/",
    );
    return `import(${JSON.stringify(path.startsWith(".") ? path : "./" + path)})`;
  };

  function exportedType(symbol: ts.Symbol, declaration: ts.Declaration) {
    const file = declaration.getSourceFile();
    const imported = typeNames.get(`${modulePath(file.fileName)}:${symbol.name}`);
    if (imported) return imported;
    const module = checker.getSymbolAtLocation(file);
    const exported =
      module && checker.getExportsOfModule(module).find((member) => unalias(checker, member) === symbol);
    if (exported && inSource(root, file.fileName)) return `${localImport(file.fileName)}.${exported.name}`;
  }

  function annotation(node: ts.Node) {
    const source = node.getSourceFile();
    const offset = node.getStart(source);
    let text = node.getText(source);
    const edits: [number, number, string][] = [];
    function visit(child: ts.Node) {
      const name = ts.isTypeReferenceNode(child)
        ? child.typeName
        : ts.isTypeQueryNode(child)
          ? child.exprName
          : ts.isExpressionWithTypeArguments(child)
            ? child.expression
            : undefined;
      if (name) {
        // A type query may select a property of an imported value (typeof api.foo).
        let base = name;
        while (ts.isQualifiedName(base) || ts.isPropertyAccessExpression(base))
          base = ts.isQualifiedName(base) ? base.left : base.expression;
        const alias = checker.getSymbolAtLocation(base);
        const symbol = alias && unalias(checker, alias);
        const declaration = symbol?.declarations?.[0];
        if (symbol && declaration) {
          const namespace = alias?.declarations?.find(ts.isNamespaceImport);
          const specifier = importModule(namespace);
          let reference =
            specifier && !specifier.startsWith(".") && !isAbsolute(specifier)
              ? `import(${JSON.stringify(specifier)})`
              : exportedType(symbol, declaration);
          if (
            !reference &&
            (ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) &&
            inSource(root, declaration.getSourceFile().fileName)
          ) {
            reference = privateTypes.get(declaration);
            if (!reference) {
              reference = `Local${privateTypes.size + 1}`;
              privateTypes.set(declaration, reference);
              const params = declaration.typeParameters?.map(annotation).join(", ");
              const definition = ts.isTypeAliasDeclaration(declaration)
                ? annotation(declaration.type)
                : [
                    ...(declaration.heritageClauses?.flatMap((clause) => clause.types.map(annotation)) ?? []),
                    `{ ${declaration.members.map((member) => annotation(member).replace(/[;,]$/, "")).join("; ")} }`,
                  ].join(" & ");
              privateShapes.set(
                reference,
                `type ${reference}${params ? `<${params}>` : ""} = ${definition};\n`,
              );
            }
          }
          if (reference) edits.push([base.getStart(source) - offset, base.end - offset, reference]);
        }
      }
      ts.forEachChild(child, visit);
    }
    visit(node);
    for (const [start, end, replacement] of edits.sort(([a], [b]) => b - a))
      text = text.slice(0, start) + replacement + text.slice(end);
    return text;
  }

  function propsType(parameter: ts.ParameterDeclaration) {
    if (parameter.type) return annotation(parameter.type);
    return typeShape(checker.getTypeAtLocation(parameter));
  }

  function componentValue(tag: ts.JsxTagNameExpression): string | undefined {
    if (ts.isJsxNamespacedName(tag)) return;
    let base = tag;
    while (ts.isPropertyAccessExpression(base)) {
      if (!ts.isIdentifier(base.expression) && !ts.isPropertyAccessExpression(base.expression)) return;
      base = base.expression;
    }
    if (!ts.isIdentifier(base)) return;
    const binding = checker.getSymbolAtLocation(base);
    if (!binding) return;
    const declaration = binding.declarations?.[0];
    const module = importModule(declaration);
    if (module && !module.startsWith(".") && !isAbsolute(module)) {
      const from = `import(${JSON.stringify(module)})`;
      const name =
        declaration && ts.isImportSpecifier(declaration)
          ? (declaration.propertyName ?? declaration.name).text
          : declaration && ts.isImportClause(declaration)
            ? "default"
            : undefined;
      return (name ? `${from}.${name}` : from) + tag.getText().slice(base.getText().length);
    }
    const original = unalias(checker, binding);
    const value = original.valueDeclaration;
    const reference = value && exportedType(original, value);
    return reference && reference + tag.getText().slice(base.getText().length);
  }

  function typeShape(type: ts.Type) {
    const flags =
      ts.TypeFormatFlags.NoTruncation |
      ts.TypeFormatFlags.InTypeAlias |
      ts.TypeFormatFlags.UseFullyQualifiedType;
    return checker
      .typeToString(type, undefined, flags)
      .replace(/import\("([^"]+)"\)\.([\w$]+)/g, (reference, path: string, name: string) => {
        if (!isAbsolute(path)) return reference;
        const exported = typeNames.get(`${path}:${name}`);
        if (exported) return exported;
        if (inSource(root, path)) return `${localImport(path)}.${name}`;
        return "unknown";
      });
  }

  return {
    propsType,
    typeShape,
    componentValue,
    annotation,
    privateDeclarations: () => [...privateShapes.values()].join(""),
  };
}
