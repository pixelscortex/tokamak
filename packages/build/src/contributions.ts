import { reservedAttribute } from "../../sdk/component-actions.ts";
import {
  flattenAttributes,
  isSearchAttribute,
  unnamedTargetWarning,
  type ScreenSearch,
} from "../../sdk/screen-search.ts";
import { parsePluginSpecifier } from "../../sdk/tools/plugin-boundary.mjs";
import { pluginCompilerOptions } from "../../sdk/tools/plugin-compiler.mjs";
import { componentParts, problem } from "./component-parts.ts";
import { brand, exportedInitializer, importModule, inSource, unalias, unwrap } from "./compiler.ts";
import { clientEntry } from "./descriptor.ts";
/** Use the compiler's export/alias graph, as backend exports do. Keep TS 5.9.3:
 * 6.0.3 is the newest JS API release; 7.x has no JS API. Upgrading belongs to
 * a separate tooling change, not the plugin wire-format implementation. */
import { resolve } from "node:path";
import ts from "typescript";

export function uiContributions(root: string, plugin: string, warn: (message: string) => void) {
  const entry = clientEntry(root);
  const configPath = ts.findConfigFile(root, ts.sys.fileExists);
  const configResult = configPath ? ts.readConfigFile(configPath, ts.sys.readFile) : { config: {} };
  if (configResult.error)
    throw new Error(ts.flattenDiagnosticMessageText(configResult.error.messageText, "\n"));
  const config = configResult.config;
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  const program = ts.createProgram([entry], {
    ...pluginCompilerOptions(root, {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      jsxImportSource: "@solidjs/web",
      ...parsed.options,
    }),
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
  const module = checker.getSymbolAtLocation(source);
  const contributes: Record<string, { id: string; [key: string]: string | number }[]> = {};
  const owners = new Map<string, ReturnType<typeof componentParts>>();
  const edits = new Map<string, [number, number, string][]>();
  function lookup(owner: string, search: ScreenSearch) {
    let parts = owners.get(owner);
    if (!parts) {
      const folder = resolve(root, "..", owner);
      const file = program.getSourceFile(clientEntry(folder));
      if (!file) return;
      owners.set(owner, (parts = componentParts(file, program, owner, folder)));
    }
    return parts.resolve(search);
  }
  const checked = new Map<ts.SourceFile, readonly ts.Diagnostic[]>();
  function checkAction(call: ts.CallExpression) {
    const file = call.getSourceFile();
    let diagnostics = checked.get(file);
    if (!diagnostics) checked.set(file, (diagnostics = program.getSemanticDiagnostics(file)));
    const diagnostic = diagnostics.find(
      (d) => d.start !== undefined && d.start >= call.getStart(file) && d.start < call.end,
    );
    if (diagnostic) throw problem(call, ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  }
  const unnamed = new Set<string>();
  const searches = new Map<ts.CallExpression, Record<string, string | number>>();
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !inSource(root, file.fileName)) continue;
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) || ts.isTypeNode(node)) return;
      if (ts.isCallExpression(node)) {
        const owner = findOwner(node.expression, checker);
        if (owner) {
          const search = searchArguments(node);
          const result = lookup(owner, search);
          if (!result) throw problem(node, `Cannot read screen elements for plugin "${owner}"`);
          if (!result.element) throw problem(node, result.reason);
          const { target, fingerprint } = result.element;
          searches.set(node, {
            name: search.name,
            ...(search.in !== undefined ? { in: search.in } : {}),
            ...(search.nth !== undefined ? { nth: search.nth } : {}),
            // Manifest options are scalar, so ARIA entries keep their JSX names.
            ...Object.fromEntries(flattenAttributes(search)),
            owner,
            target,
            ...(fingerprint ? { fingerprint } : {}),
          });
          const cuts = edits.get(file.fileName) ?? [];
          cuts.push([node.getStart(), node.end, `(${JSON.stringify({ target })})`]);
          edits.set(file.fileName, cuts);
          if (result.unnamed && !unnamed.has(target)) {
            unnamed.add(target);
            warn(unnamedTargetWarning(plugin, search, target));
          }
          // Only a search by position depends on telling the siblings apart.
          if (result.ambiguous && search.nth !== undefined)
            warn(
              `Plugin "${plugin}" targets ${target}: ambiguous positional target; ask the owner for a data-part or id`,
            );
          return;
        }
      }
      if (
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node) ||
          ts.isIdentifier(node)) &&
        findOwner(node, checker)
      )
        throw problem(
          node,
          "Call find directly from its public client import so its arguments can be checked",
        );
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  for (const exported of module ? checker.getExportsOfModule(module) : []) {
    if (!runtime.has(exported.name)) continue;
    const symbol = unalias(checker, exported);
    const declaration = symbol.valueDeclaration;
    if (!declaration || !inSource(root, declaration.getSourceFile().fileName)) continue;
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    if (brand(type, "viewBrand")) {
      (contributes.view ??= []).push({ id: exported.name, ...pageOptions(declaration, checker) });
      continue;
    }
    const action = brand(type, "componentActionBrand");
    if (action) {
      const kind = checker.getTypeOfSymbolAtLocation(action, declaration);
      if (!kind.isStringLiteral()) throw problem(declaration, "Declare a single component action");
      const values = componentActionOptions(declaration, kind.value, checker, plugin, searches, checkAction);
      (contributes["component-action"] ??= []).push({ id: exported.name, ...values });
      continue;
    }
  }
  return { contributes, edits };
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

function pageOptions(declaration: ts.Declaration, checker: ts.TypeChecker): Record<string, string> {
  const init = exportedInitializer(declaration);
  const options = init && ts.isCallExpression(init) ? unwrap(init.arguments[0]) : undefined;
  const fail = (): never => {
    throw problem(options ?? declaration, "Use a literal view route and optional title and icon");
  };
  if (!options || !ts.isObjectLiteralExpression(options)) return fail();
  const values: Record<string, string> = {};
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return fail();
    const name = property.name;
    const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : fail();
    if (!["route", "title", "icon"].includes(key) || key in values) return fail();
    values[key] = pageOptionValue(property, key, checker, fail);
  }
  if (values.route === undefined) return fail();
  validateRoute(values.route, fail);
  if (values.icon !== undefined) validateIcon(values.icon, fail);
  return values;
}

function pageOptionValue(
  property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  key: string,
  checker: ts.TypeChecker,
  fail: () => never,
): string {
  if (key === "route") {
    if (ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer))
      return property.initializer.text;
    return fail();
  }
  if (ts.isPropertyAssignment(property)) return constantString(property.initializer, checker, fail);
  const value = checker.getShorthandAssignmentValueSymbol(property);
  const type = value && checker.getTypeOfSymbolAtLocation(value, property.name);
  return type?.isStringLiteral() ? type.value : fail();
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

function componentActionOptions(
  declaration: ts.Declaration,
  action: string,
  checker: ts.TypeChecker,
  plugin: string,
  searches: ReadonlyMap<ts.CallExpression, Record<string, string | number>>,
  checkAction: (call: ts.CallExpression) => void,
): Record<string, string | number> {
  const init = exportedInitializer(declaration);
  if (!init || !ts.isCallExpression(init) || !init.arguments[0])
    throw problem(declaration, "Export a component action declared with an action helper");
  const reference = unwrap(init.arguments[0])!;
  const call = targetSearch(reference, checker);
  const found = call && searches.get(call);
  if (!found || findOwner(call.expression, checker) === plugin)
    throw problem(reference, "Use find from another plugin's public client import");
  if (!brand(checker.getTypeAtLocation(reference), "componentPartBrand"))
    throw problem(reference, "Build the owning plugin first to generate its find types");
  const options = unwrap(init.arguments[action === "hide" ? 1 : 2]);
  const values: Record<string, string | number> = { action, ...found };
  if (options) {
    if (!ts.isObjectLiteralExpression(options))
      throw problem(options, "Use literal component action options");
    for (const prop of options.properties) {
      if (!(ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)))
        throw problem(prop, "Use a literal order or a live when accessor");
      if (prop.name.getText() === "when") continue;
      const value = ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
      if (prop.name.getText() === "order" && value && /^-?\d+(?:\.\d+)?$/.test(value.getText())) {
        values.order = Number(value.getText());
      } else throw problem(prop, "Use a literal order or a live when accessor");
    }
  }
  if (action === "attrs" || action === "layer") {
    const excluded = callableAttributes(reference, checker);
    checkAttributeLiterals(init.arguments[1], action, checker, excluded);
    if (excluded.size) values.callableAttributes = JSON.stringify([...excluded]);
  }
  checkAction(init);
  return values;
}

function callableAttributes(reference: ts.Expression, checker: ts.TypeChecker) {
  const property = brand(checker.getTypeAtLocation(reference), "elementAttributesBrand");
  const excluded = new Set<string>();
  if (!property) return excluded;
  const type = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, reference));
  for (const member of type.isUnion() ? type.types : [type])
    for (const prop of member.getProperties()) {
      const value = checker.getTypeOfSymbolAtLocation(prop, reference);
      if ((value.isUnion() ? value.types : [value]).some((part) => part.getCallSignatures().length))
        if (!reservedAttribute(prop.name)) excluded.add(prop.name);
    }
  return excluded;
}

function checkAttributeLiterals(
  expression: ts.Expression | undefined,
  action: "attrs" | "layer",
  checker: ts.TypeChecker,
  callable: ReadonlySet<string>,
) {
  let read: ts.Node | undefined = unwrap(expression);
  if (read && ts.isIdentifier(read)) {
    const declaration = checker.getSymbolAtLocation(read)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration)) read = unwrap(declaration.initializer);
    else if (declaration && ts.isFunctionDeclaration(declaration)) read = declaration;
  }
  if (!read) return;
  function check(name: ts.Node, original = false) {
    if (ts.isComputedPropertyName(name)) {
      const literal = unwrap(name.expression);
      if (!literal || !ts.isStringLiteralLike(literal)) return;
      name = literal;
    }
    const key = ts.isStringLiteralLike(name) || ts.isIdentifier(name) ? name.text : name.getText();
    if (original && key === "children") return;
    if (reservedAttribute(key) || callable.has(key))
      throw problem(name, `Cannot change attribute "${key}" with ${original ? "Original" : "attrs"}`);
  }
  function returned(expression: ts.Expression | undefined) {
    const value = unwrap(expression);
    if (!value) return;
    if (ts.isObjectLiteralExpression(value)) {
      for (const prop of value.properties) {
        if (ts.isSpreadAssignment(prop)) returned(prop.expression);
        else if (prop.name) check(prop.name);
      }
    } else if (ts.isConditionalExpression(value)) {
      returned(value.whenTrue);
      returned(value.whenFalse);
    } else if (
      ts.isBinaryExpression(value) &&
      (value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      returned(value.left);
      returned(value.right);
    }
  }
  if (action === "attrs") {
    if (!(ts.isArrowFunction(read) || ts.isFunctionExpression(read) || ts.isFunctionDeclaration(read)))
      return;
    const body = read.body;
    if (!body) return;
    const visit = (node: ts.Node) => {
      if (ts.isReturnStatement(node)) returned(node.expression);
      else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
    };
    if (ts.isBlock(body)) visit(body);
    else returned(body);
  } else {
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        !/^[a-z][\w-]*$/.test(node.tagName.getText()) &&
        brand(checker.getTypeAtLocation(node.tagName), "originalElementBrand")
      ) {
        for (const prop of node.attributes.properties) if (ts.isJsxAttribute(prop)) check(prop.name, true);
      }
      ts.forEachChild(node, visit);
    };
    visit(read);
  }
}

function targetSearch(target: ts.Expression, checker: ts.TypeChecker) {
  if (ts.isCallExpression(target)) return target;
  const declaration = ts.isIdentifier(target) && checker.getSymbolAtLocation(target)?.valueDeclaration;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !(declaration.parent.flags & ts.NodeFlags.Const)
  )
    return;
  const value = unwrap(declaration.initializer);
  if (value && ts.isCallExpression(value)) return value;
}

function findOwner(expression: ts.Expression, checker: ts.TypeChecker) {
  let path = unwrap(expression)!;
  let member: string | undefined;
  if (ts.isPropertyAccessExpression(path)) {
    member = path.name.text;
    path = path.expression;
  } else if (ts.isElementAccessExpression(path) && ts.isStringLiteralLike(path.argumentExpression)) {
    member = path.argumentExpression.text;
    path = path.expression;
  }
  if (!ts.isIdentifier(path) || (member !== undefined && member !== "find")) return;
  const binding = checker
    .getSymbolAtLocation(path)
    ?.declarations?.find((node) => ts.isImportSpecifier(node) || ts.isNamespaceImport(node));
  if (!binding) return;
  if (ts.isImportSpecifier(binding)) {
    if (member !== undefined || (binding.propertyName ?? binding.name).text !== "find") return;
  } else if (member !== "find") return;
  const specifier = importModule(binding);
  const reference = specifier && parsePluginSpecifier(specifier);
  if (reference && reference.side === "client") return reference.id;
}

function searchArguments(call: ts.CallExpression): ScreenSearch {
  const name = unwrap(call.arguments[0]);
  const options = unwrap(call.arguments[1]);
  const fail = (node: ts.Node = call): never => {
    throw problem(
      node,
      "Use a literal screen element name and literal in, type, href, role or aria filters, or a positive integer nth",
    );
  };
  if (!name || !ts.isStringLiteralLike(name) || call.arguments.length > 2) return fail();
  const search: ScreenSearch = { name: name.text };
  if (options) {
    if (!ts.isObjectLiteralExpression(options)) return fail(options);
    function literalProperty(property: ts.ObjectLiteralElementLike) {
      if (!ts.isPropertyAssignment(property)) return fail(property);
      const { name } = property;
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) return fail(name);
      return [name.text, unwrap(property.initializer)!] as const;
    }

    const seen = new Set<string>();
    for (const property of options.properties) {
      const [key, initializer] = literalProperty(property);
      if (seen.has(key)) return fail(property);
      seen.add(key);
      if (key === "in" && ts.isStringLiteralLike(initializer)) search.in = initializer.text;
      else if (
        key === "nth" &&
        ts.isNumericLiteral(initializer) &&
        Number.isSafeInteger(Number(initializer.text)) &&
        Number(initializer.text) > 0
      )
        search.nth = Number(initializer.text);
      else if (isSearchAttribute(key) && ts.isStringLiteralLike(initializer)) search[key] = initializer.text;
      else if (key === "aria" && ts.isObjectLiteralExpression(initializer)) {
        const values = new Map<string, string>();
        for (const entry of initializer.properties) {
          const [name, value] = literalProperty(entry);
          if (!name || values.has(name) || !ts.isStringLiteralLike(value)) return fail(entry);
          values.set(name, value.text);
        }
        search.aria = Object.fromEntries(values);
      } else return fail(property);
    }
  }
  return search;
}
