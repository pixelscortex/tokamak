import ts from "typescript";
import { validatorFromType } from "./result-validator.mjs";

export function originalSymbol(checker, symbol) {
  return symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function pointCall(checker, node) {
  return (
    ts.isCallExpression(node) &&
    checker
      .getTypeAtLocation(node.expression)
      .getProperties()
      .some((property) => property.name.startsWith("__@pointBrand@"))
  );
}

export function discoverPoints(files, checker, definitions) {
  const owners = new Map();
  const calls = new Map();
  function collect(node) {
    if (pointCall(checker, node)) calls.set(node, []);
    ts.forEachChild(node, collect);
  }
  for (const file of files) if (file) collect(file);
  if (!calls.size) return owners;

  for (const symbol of new Set(definitions)) {
    const declaration = symbol?.valueDeclaration;
    if (!declaration) continue;
    const file = declaration.getSourceFile();
    const visited = new Set();
    function declarationOf(node) {
      if (!ts.isIdentifier(node) || ts.isDeclarationName(node)) return;
      return (checker.getShorthandAssignmentValueSymbol(node.parent) ?? checker.getSymbolAtLocation(node))
        ?.valueDeclaration;
    }
    function follow(node) {
      if (!node || visited.has(node) || node.getSourceFile() !== file) return;
      visited.add(node);
      if (calls.has(node)) calls.get(node).push(symbol);
      const local = declarationOf(node);
      if (local && (ts.isFunctionLike(local) || ts.isVariableDeclaration(local)))
        follow(ts.isVariableDeclaration(local) ? local.initializer : local);
      ts.forEachChild(node, follow);
    }
    const definitionsSeen = new Set();
    function findHandler(node) {
      if (!node || definitionsSeen.has(node) || node.getSourceFile() !== file) return;
      definitionsSeen.add(node);
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (ts.isSpreadAssignment(property)) findHandler(property.expression);
          const name = property.name;
          if (!name || !(ts.isIdentifier(name) || ts.isStringLiteral(name)) || name.text !== "handler")
            continue;
          if (ts.isPropertyAssignment(property)) follow(property.initializer);
          else if (ts.isShorthandPropertyAssignment(property)) {
            const local = checker.getShorthandAssignmentValueSymbol(property)?.valueDeclaration;
            follow(local && ts.isVariableDeclaration(local) ? local.initializer : local);
          } else if (ts.isMethodDeclaration(property)) follow(property);
        }
        return;
      }
      const local = declarationOf(node);
      if (local && ts.isVariableDeclaration(local)) findHandler(local.initializer);
      if (!ts.isFunctionLike(node)) ts.forEachChild(node, findHandler);
    }
    findHandler(ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration);
  }
  for (const [call, symbols] of calls) {
    const file = call.getSourceFile();
    const location = file.getLineAndCharacterOfPosition(call.getStart());
    const error = (message) => {
      throw new Error(`${file.fileName}:${location.line + 1}:${location.character + 1}: ${message}`);
    };
    const [name] = call.arguments;
    if (!name || !ts.isStringLiteralLike(name))
      error("A point name must be a string literal; pass a literal name.");
    if (!name.text || name.text.includes("#")) error('A point name cannot be empty or contain "#".');
    if (symbols.length !== 1)
      error(
        "Cannot attribute point to exactly one exported query, mutation or action; call it in that function's handler or a helper used only by that handler.",
      );
    const [owner] = symbols;
    const points = owners.get(owner) ?? new Map();
    if (points.has(name.text)) error(`Duplicate point name "${name.text}" in the same function.`);

    const signature = checker.getResolvedSignature(call);
    if (![2, 3].includes(call.arguments.length) || !signature?.parameters[1])
      error("A point takes a name, data, and an optional callback.");
    const input = checker.getTypeOfSymbolAtLocation(signature.parameters[1], call);
    const result =
      call.arguments.length === 3
        ? checker.getAwaitedType(checker.getReturnTypeOfSignature(signature))
        : undefined;
    const invalid = () =>
      error(`Point "${name.text}" requires plain data; describe it as data, or use \`after\`.`);
    points.set(name.text, {
      input: dataType(checker, input, call, invalid),
      result: result && dataType(checker, result, call, invalid),
      validators: {
        args: validatorFromType(checker, input, call),
        result: result && validatorFromType(checker, result, call),
      },
    });
    owners.set(owner, points);
  }
  return owners;
}

// A consumer cannot name the owner's private type aliases. Spell out the
// data shape and use local aliases only for cycles in the type graph.
function dataType(checker, root, location, invalid) {
  const active = new Map();
  const recursive = [];
  const reference = (index) => `\x00${index}\x00`;
  const list = (value) => `(${value})[]`;
  function visit(type, optional = false) {
    const existing = active.get(type);
    if (existing) {
      if (existing.index === undefined) {
        existing.index = recursive.length;
        recursive.push(existing);
      }
      return reference(existing.index);
    }
    if (active.size >= 64) invalid();
    const node = {};
    active.set(type, node);
    node.body = render(type, optional);
    active.delete(type);
    return node.index === undefined ? node.body : reference(node.index);
  }

  function render(type, optional) {
    const flags = type.flags;
    if (flags & ts.TypeFlags.Undefined && optional) return "undefined";
    if (type.isLiteral() && !(flags & ts.TypeFlags.BigIntLiteral)) return JSON.stringify(type.value);
    if (
      flags &
      (ts.TypeFlags.Any |
        ts.TypeFlags.Unknown |
        ts.TypeFlags.Never |
        ts.TypeFlags.StringLike |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.Null)
    )
      return checker.typeToString(type);
    if (type.isUnionOrIntersection()) {
      const operator = type.isUnion() ? " | " : " & ";
      return `(${type.types.map((member) => visit(member, optional)).join(operator)})`;
    }
    if (checker.isTupleType(type)) {
      const items = checker.getTypeArguments(type).map((item, i) => {
        const flag = type.target.elementFlags[i];
        const optional = Boolean(flag & ts.ElementFlags.Optional);
        const value = visit(item, optional);
        if (flag & ts.ElementFlags.Rest) return `...${list(value)}`;
        return optional ? `(${value})?` : value;
      });
      return `${type.target.readonly ? "readonly " : ""}[${items.join(", ")}]`;
    }
    if (checker.isArrayType(type)) {
      return `${type.target.symbol?.name === "ReadonlyArray" ? "readonly " : ""}${list(visit(checker.getTypeArguments(type)[0]))}`;
    }
    if (
      !(flags & ts.TypeFlags.Object) ||
      type.getCallSignatures().length ||
      type.getConstructSignatures().length ||
      type.getSymbol()?.declarations?.some(ts.isClassLike)
    )
      invalid();

    const fields = checker.getIndexInfosOfType(type).map((index) => {
      if (index.keyType.flags & ts.TypeFlags.ESSymbolLike) invalid();
      return `${index.isReadonly ? "readonly " : ""}[key: ${visit(index.keyType)}]: ${visit(index.type)};`;
    });
    for (const field of type.getProperties()) {
      if (field.name.startsWith("__@") || field.declarations?.some(ts.isAccessor)) invalid();
      const name = ts.isIdentifierText(field.name, ts.ScriptTarget.Latest)
        ? field.name
        : JSON.stringify(field.name);
      const optional = Boolean(field.flags & ts.SymbolFlags.Optional);
      const readonly =
        Boolean(ts.getCheckFlags(field) & ts.CheckFlags.Readonly) ||
        field.declarations?.some((node) => ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Readonly);
      const value = visit(checker.getTypeOfSymbolAtLocation(field, location), optional);
      fields.push(`${readonly ? "readonly " : ""}${name}${optional ? "?" : ""}: ${value};`);
    }
    return `{ ${fields.join(" ")} }`;
  }

  const body = visit(root);
  return { body, recursive: recursive.map(({ body }) => body) };
}

export function pointReferenceTypes(points, kind, namespace, qualified, aliases) {
  if (!points?.size) return "";
  const render = ({ body, recursive }) => {
    const offset = aliases.length;
    const qualify = (source) =>
      source.replaceAll(/\x00(\d+)\x00/g, (_, index) => `PointData${offset + Number(index)}`);
    recursive.forEach((type, index) =>
      aliases.push(`type PointData${offset + index} = ${qualify(type)};
`),
    );
    return qualify(body);
  };
  return ` & { readonly points: {${[...points]
    .map(([name, { input, result }]) => {
      const argsType = render(input);
      const resultType = result ? render(result) : argsType;
      return `readonly ${JSON.stringify(name)}: import("@tokamak/sdk").PointReference<${JSON.stringify(kind)}, ${argsType}, ${resultType}, ${JSON.stringify(namespace) ?? "string"}, ${JSON.stringify(`${qualified}#${name}`)}, ${!result}>;`;
    })
    .join("")}} }`;
}
