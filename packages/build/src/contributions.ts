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
  const replacements = new Map<string, string>();
  const owners = new Map<string, ReturnType<typeof componentParts>>();
  const edits = new Map<string, [number, number, string][]>();
  function lookup(owner: string, names: string[]) {
    let parts = owners.get(owner);
    if (!parts) {
      const folder = resolve(root, "..", owner);
      const file = program.getSourceFile(clientEntry(folder));
      if (!file) return;
      owners.set(owner, (parts = componentParts(file, program, owner, folder)));
    }
    return parts.part(names);
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
      const values = componentActionOptions(
        declaration,
        kind.value,
        checker,
        plugin,
        lookup,
        checkAction,
        (node, replacement) => {
          const file = node.getSourceFile().fileName;
          const cuts = edits.get(file) ?? [];
          cuts.push([node.getStart(), node.end, replacement]);
          edits.set(file, cuts);
        },
        warn,
      );
      if (!values) continue;
      if (kind.value === "replace") {
        const target = String(values.target);
        const first = replacements.get(target);
        if (first) throw problem(declaration, `${first} and ${exported.name} both replace ${target}`);
        replacements.set(target, exported.name);
      }
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
  lookup: (
    owner: string,
    names: string[],
  ) => { fingerprint?: string; ambiguous?: boolean } | false | undefined,
  checkAction: (call: ts.CallExpression) => void,
  edit: (node: ts.Node, replacement: string) => void,
  warn: (message: string) => void,
): Record<string, string | number> | undefined {
  const init = exportedInitializer(declaration);
  if (!init || !ts.isCallExpression(init) || !init.arguments[0])
    throw problem(declaration, "Export a component action declared with an action helper");
  const path = init.arguments[0];
  const type = checker.getTypeAtLocation(path);
  const reference = importedPart(path, checker);
  if (!reference || reference.owner === plugin)
    throw problem(path, "Use a screen part from another plugin's client import");
  const target = [reference.owner, ...reference.names].join(".");
  const exists = lookup(reference.owner, reference.names);
  if (exists === false) {
    warn(`Plugin "${plugin}" targets missing screen part ${target}; skipping this addition`);
    edit(init, "undefined");
    return;
  }
  if (!exists || !brand(type, "componentPartBrand"))
    throw problem(path, `Screen element is not a typed path: ${path.getText()}; build its owner first`);
  const options = unwrap(init.arguments[action === "hide" ? 1 : 2]);
  const values: Record<string, string | number> = { action, target };
  if (exists.fingerprint) values.fingerprint = exists.fingerprint;
  if (exists.ambiguous)
    warn(
      `Plugin "${plugin}" targets ${target}: ambiguous positional target; ask the owner for a data-part or id`,
    );
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
  checkAction(init);
  // Existing artifacts keep loading when an owner removes the runtime path.
  edit(path, JSON.stringify({ target }));
  return values;
}

/** Only paths rooted in public client imports can contribute placements. */
function importedPart(path: ts.Expression, checker: ts.TypeChecker) {
  while (ts.isParenthesizedExpression(path)) path = path.expression;
  const names: string[] = [];
  while (true) {
    if (ts.isPropertyAccessExpression(path) && !path.questionDotToken) names.unshift(path.name.text);
    else if (
      ts.isElementAccessExpression(path) &&
      !path.questionDotToken &&
      ts.isStringLiteralLike(path.argumentExpression)
    )
      names.unshift(path.argumentExpression.text);
    else break;
    path = path.expression;
  }
  if (!ts.isIdentifier(path)) return;
  const binding = checker
    .getSymbolAtLocation(path)
    ?.declarations?.find((node) => ts.isImportSpecifier(node) || ts.isNamespaceImport(node));
  if (binding && ts.isImportSpecifier(binding)) names.unshift((binding.propertyName ?? binding.name).text);
  if (names.shift() !== "parts" || !names.length) return;
  const specifier = importModule(binding);
  const reference = specifier && parsePluginSpecifier(specifier);
  if (reference && reference.side === "client") return { owner: reference.id, names };
}
