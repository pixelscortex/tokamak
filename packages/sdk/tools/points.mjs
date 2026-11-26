import ts from "typescript";
import { includesUndefined, validatorFromType } from "./result-validator.mjs";

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

function legacyPointCall(checker, node) {
  if (!ts.isCallExpression(node)) return false;
  const access = node.expression;
  const member = ts.isPropertyAccessExpression(access)
    ? access.name
    : ts.isElementAccessExpression(access) && access.argumentExpression;
  if (!member || member.text !== "point" || checker.getSymbolAtLocation(member)) return false;

  const receiver = checker.getTypeAtLocation(access.expression);
  return (
    receiver.getProperty("call") || (ts.isIdentifier(access.expression) && access.expression.text === "ctx")
  );
}

function referencedDeclaration(checker, node) {
  if (!(ts.isIdentifier(node) || ts.isStringLiteralLike(node))) return;
  if (ts.isDeclarationName(node) && !ts.isShorthandPropertyAssignment(node.parent)) return;
  if (ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent)) return;
  return originalSymbol(
    checker,
    checker.getShorthandAssignmentValueSymbol(node.parent) ?? checker.getSymbolAtLocation(node),
  )?.valueDeclaration;
}

function callableBody(declaration) {
  if (!declaration) return;
  if (ts.isFunctionLike(declaration)) return declaration;
  if (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration))
    return declaration.initializer;
}

function sourceLocation(node) {
  const file = node.getSourceFile();
  const { line, character } = file.getLineAndCharacterOfPosition(node.getStart());
  return `${file.fileName}:${line + 1}:${character + 1}`;
}

function traceHandler(checker, declaration, file, follow) {
  const seen = new Set();
  function find(node) {
    if (!node || seen.has(node) || node.getSourceFile() !== file) return;
    seen.add(node);
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) find(property.expression);
        const name = property.name;
        if (!name || !(ts.isIdentifier(name) || ts.isStringLiteral(name)) || name.text !== "handler")
          continue;
        if (ts.isPropertyAssignment(property)) follow(property.initializer);
        else if (ts.isShorthandPropertyAssignment(property)) follow(property.name);
        else if (ts.isMethodDeclaration(property)) follow(property);
      }
      return;
    }
    const local = referencedDeclaration(checker, node);
    if (local && ts.isVariableDeclaration(local)) find(local.initializer);
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, find);
  }
  find(ts.isVariableDeclaration(declaration) ? declaration.initializer : declaration);
}

function traceOwner(checker, declaration) {
  const file = declaration.getSourceFile();
  const edges = new Map();
  function follow(node) {
    if (!node || edges.has(node) || node.getSourceFile() !== file) return;
    const children = [];
    edges.set(node, children);
    const add = (child) => {
      if (!child || child.getSourceFile() !== file) return;
      children.push(child);
      follow(child);
    };
    ts.forEachChild(node, add);
    // A static member reference follows that member, not its siblings.
    if (!staticReceiver(node)) add(callableBody(referencedDeclaration(checker, node)));
  }
  const handlers = new Set();
  traceHandler(checker, declaration, file, (node) => {
    const handler = callableBody(referencedDeclaration(checker, node)) ?? node;
    if (ts.isFunctionLike(handler)) handlers.add(handler);
    follow(node);
  });
  return { edges, handlers };
}

function staticReceiver(node) {
  const parent = node.parent;
  return (
    parent?.expression === node &&
    (ts.isPropertyAccessExpression(parent) ||
      (ts.isElementAccessExpression(parent) && ts.isStringLiteralLike(parent.argumentExpression)))
  );
}

function unsafeReference(call, edges, references) {
  const parents = new Map();
  for (const [node, children] of edges) {
    for (const child of children) {
      const incoming = parents.get(child) ?? [];
      incoming.push(node);
      parents.set(child, incoming);
    }
  }
  const reachesPoint = new Set([call]);
  for (const node of reachesPoint) {
    for (const parent of parents.get(node) ?? []) reachesPoint.add(parent);
  }
  for (const [outside, declaration] of references) {
    if (edges.has(outside)) continue;
    const body = callableBody(declaration);
    if (!body) continue;
    const escapesObject =
      ts.isObjectLiteralExpression(body) &&
      !staticReceiver(outside) &&
      body.properties.some((property) => reachesPoint.has(callableBody(property)));
    if (reachesPoint.has(body) || escapesObject) {
      const inside = references.find(([node, target]) => target === declaration && reachesPoint.has(node));
      return { outside, inside: inside?.[0] };
    }
  }
}

// A live context is only proof of *a* call. Follow the first argument back to
// this handler so a saved context from a different live call cannot be used.
function ownsContext(checker, argument, { edges, handlers }, references) {
  const seen = new Set();
  let fromHandler = false;
  function trace(node) {
    if (!node) return false;
    node = ts.skipOuterExpressions(node);
    if (!ts.isIdentifier(node)) return false;

    const declaration = referencedDeclaration(checker, node);
    if (!declaration) return false;
    if (seen.has(declaration)) return true;
    seen.add(declaration);

    if (ts.isVariableDeclaration(declaration))
      return !!(declaration.parent.flags & ts.NodeFlags.Const) && trace(declaration.initializer);
    if (!ts.isParameter(declaration)) return false;

    const owner = declaration.parent;
    const index = owner.parameters.indexOf(declaration);
    if (references.some(([ref, target]) => target === declaration && ts.isAssignmentTarget(ref)))
      return false;

    if (handlers.has(owner) && index === 0) {
      fromHandler = true;
      return true;
    }

    const outer = owner.parent;
    if (
      index === 1 &&
      ts.isCallExpression(outer) &&
      outer.arguments[0] === owner &&
      ts.isPropertyAccessExpression(outer.expression) &&
      outer.expression.name.text === "withPrograms"
    )
      return trace(outer.expression.expression);

    const sites = references.filter(([ref, target]) => edges.has(ref) && callableBody(target) === owner);
    return (
      sites.length > 0 &&
      sites.every(([ref]) => {
        const callee = staticReceiver(ref)
          ? undefined
          : ts.isPropertyAccessExpression(ref.parent) || ts.isElementAccessExpression(ref.parent)
            ? ref.parent
            : ref;
        const call = callee?.parent;
        return (
          call &&
          ts.isCallExpression(call) &&
          call.expression === callee &&
          !call.arguments.slice(0, index + 1).some(ts.isSpreadElement) &&
          trace(call.arguments[index])
        );
      })
    );
  }
  return trace(argument) && fromHandler;
}

export function discoverPoints(files, checker, definitions, warn = () => {}) {
  const owners = new Map();
  const calls = new Map();
  const references = [];
  function collect(node) {
    if (legacyPointCall(checker, node))
      throw new Error(`${sourceLocation(node)}: Import point from "@tokamak/sdk" and write point(ctx, ...).`);
    if (pointCall(checker, node)) calls.set(node, []);
    ts.forEachChild(node, collect);
  }
  for (const file of files) if (file) collect(file);
  if (!calls.size) return owners;

  function collectReferences(node) {
    const declaration = referencedDeclaration(checker, node);
    if (callableBody(declaration) || (declaration && ts.isParameter(declaration)))
      references.push([node, declaration]);
    ts.forEachChild(node, collectReferences);
  }
  for (const file of files) if (file) collectReferences(file);

  for (const symbol of new Set(definitions)) {
    if (!symbol?.valueDeclaration) continue;
    const trace = traceOwner(checker, symbol.valueDeclaration);
    for (const [call, matches] of calls) if (trace.edges.has(call)) matches.push({ symbol, ...trace });
  }
  for (const [call, matches] of calls) {
    const error = (message) => {
      throw new Error(`${sourceLocation(call)}: ${message}`);
    };
    const [, name] = call.arguments;
    if (!name || !ts.isStringLiteralLike(name))
      error("A point name must be a string literal; pass a literal name.");
    if (!name.text || name.text.includes("#")) error('A point name cannot be empty or contain "#".');
    const ambiguous = (sites) =>
      error(
        `Cannot attribute point "${name.text}" to exactly one exported query, mutation or action${sites}; call it in that function's handler or a helper in the same module used only by that handler.`,
      );
    if (matches.length !== 1)
      ambiguous(
        matches.length
          ? ` (${matches.map(({ symbol }) => sourceLocation(symbol.valueDeclaration)).join(", ")})`
          : "",
      );
    const [{ symbol: owner, edges }] = matches;
    const conflict = unsafeReference(call, edges, references);
    if (conflict)
      ambiguous(
        ` (owner at ${sourceLocation(conflict.inside ?? owner.valueDeclaration)}, other use at ${sourceLocation(conflict.outside)})`,
      );
    if (!ownsContext(checker, call.arguments[0], matches[0], references))
      error(`Point "${name.text}" must receive the context of its own handler as the first argument.`);

    const points = owners.get(owner) ?? new Map();
    if (points.has(name.text)) error(`Duplicate point name "${name.text}" in the same function.`);

    points.set(name.text, pointTypes(checker, call, name.text, error, warn));
    owners.set(owner, points);
  }
  return owners;
}

function pointTypes(checker, call, name, error, warn) {
  const signature = checker.getResolvedSignature(call);
  if (![3, 4].includes(call.arguments.length) || !signature?.parameters[2])
    error("A point takes a context, name, data, and an optional callback or { collect: true }.");
  const input = checker.getTypeOfSymbolAtLocation(signature.parameters[2], call);
  const invalid = () => error(`Point "${name}" requires plain data; describe it as data, or use \`after\`.`);
  let result;
  if (call.arguments.length === 4) {
    const option =
      signature.parameters[3] && checker.getTypeOfSymbolAtLocation(signature.parameters[3], call);
    const run = option?.getCallSignatures()[0];
    if (run) {
      result = checker.getAwaitedType(checker.getReturnTypeOfSignature(run));
      if (!result) invalid();
    } else if (!option?.getProperty("collect")) {
      invalid();
    }
  }
  let empty = false;
  const emptyLiteral = () => {
    empty = true;
  };
  const types = {
    input: dataType(checker, input, call, invalid, emptyLiteral),
    result: result && dataType(checker, result, call, invalid, emptyLiteral, true),
    validators: {
      args: validatorFromType(checker, input, call, true),
      result: result && validatorFromType(checker, result, call, true),
    },
  };
  if (empty)
    warn(
      `${sourceLocation(call)}: Point "${name}" infers an empty object or never[]; annotate empty literals with the types hooks may return (e.g. Record<string, string> or string[]).`,
    );
  return types;
}

// A consumer cannot name the owner's private type aliases. Spell out the
// data shape and use local aliases only for cycles in the type graph.
function dataType(checker, root, location, invalid, emptyLiteral, result = false) {
  const active = new Map();
  const recursive = [];
  const reference = (index) => `\x00${index}\x00`;
  const list = (value) => `(${value})[]`;
  function visit(type, optional = false, normalize = false) {
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
    node.body = render(type, optional, normalize);
    active.delete(type);
    return node.index === undefined ? node.body : reference(node.index);
  }

  function render(type, optional, normalize) {
    const flags = type.flags;
    if (normalize && flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return "null";
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
      return `(${type.types.map((member) => visit(member, optional, normalize)).join(operator)})`;
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
      if (checker.getTypeArguments(type)[0].flags & ts.TypeFlags.Never) emptyLiteral();
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
      const fieldType = checker.getTypeOfSymbolAtLocation(field, location);
      const optional = Boolean(field.flags & ts.SymbolFlags.Optional) || includesUndefined(fieldType);
      const readonly =
        Boolean(ts.getCheckFlags(field) & ts.CheckFlags.Readonly) ||
        field.declarations?.some((node) => ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Readonly);
      const value = visit(fieldType, optional);
      fields.push(`${readonly ? "readonly " : ""}${name}${optional ? "?" : ""}: ${value};`);
    }
    if (!fields.length) emptyLiteral();
    return `{ ${fields.join(" ")} }`;
  }

  const body = visit(root, false, result);
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
