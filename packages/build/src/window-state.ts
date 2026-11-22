import { relative } from "node:path";
import ts from "typescript";
import { normalizePath } from "vite";
import type MagicString from "magic-string";
import { windowStateModule } from "../../sdk/src/window-state-protocol.ts";
import { runtimeExportNames } from "../../sdk/tools/plugin-compiler.mjs";
import { inSource, type Element, type ElementMount } from "./compiler.ts";

type Render = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
type ComponentScope = { render: Render; name: string; symbol?: ts.Symbol };
type Lift = { call: ts.CallExpression; name: string; kind: "state" | "signal"; component?: ComponentScope };
type Mount = { node: Element; target: ts.Symbol; site: string };
type ResolveSymbol = (node: ts.Node) => ts.Symbol | undefined;
type Helper = "createSignal" | "state" | "view" | "component";
type CallHelper = (call: ts.CallExpression) => Helper | undefined;

const scope = "__tokamakWindowState";
const instance = "__tokamakStateInstance";

export function windowStateTransform(
  root: string,
  entry: string,
  program: ts.Program,
  erasedNodes: (file: ts.SourceFile) => (node: ts.Node) => boolean,
) {
  const checker = program.getTypeChecker();
  const original = (symbol?: ts.Symbol) =>
    symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const symbolAt: ResolveSymbol = (node) => original(checker.getSymbolAtLocation(node));
  const files = program
    .getSourceFiles()
    .filter((file) => !file.isDeclarationFile && inSource(root, file.fileName));
  const helpers = collectHelpers(files, checker, symbolAt, original);
  const callHelper: CallHelper = ({ expression }) =>
    helpers.get(symbolAt(ts.isPropertyAccessExpression(expression) ? expression.name : expression)!);

  const publicModule = program.getSourceFile(entry);
  const exports = publicModule && checker.getSymbolAtLocation(publicModule);
  if (exports) rejectPublicState(checker, exports, original);

  const compiled = new Map(
    files.map((file) => [
      file,
      collectWindowFile(
        file,
        normalizePath(relative(root, file.fileName)),
        symbolAt,
        callHelper,
        erasedNodes(file),
      ),
    ]),
  );
  const mounted = new Set<ts.Symbol>();
  for (const { lifts } of compiled.values())
    for (const { component } of lifts) if (component?.symbol) mounted.add(component.symbol);

  return (file: ts.SourceFile, output: MagicString, isPart: (node: Element) => boolean) => {
    const source = compiled.get(file);
    if (!source) return;
    const sites = source.mounts.filter(({ target }) => mounted.has(target));
    if (!source.lifts.length && !sites.length) return;
    emitState(file, output, source.path, source.lifts);
    const partMounts = new Map<Element, ElementMount>();
    for (const { node, site } of sites) {
      const mount = { prefix: `${scope}.at(${JSON.stringify(site)}, () => `, suffix: ")" };
      if (isPart(node)) {
        partMounts.set(node, mount);
        continue;
      }
      const child = ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent);
      output.prependLeft(node.getStart(file), `${child ? "{" : ""}${mount.prefix}`);
      output.appendLeft(node.end, `${mount.suffix}${child ? "}" : ""}`);
    }
    return { partMounts };
  };
}

function collectHelpers(
  files: ts.SourceFile[],
  checker: ts.TypeChecker,
  symbolAt: ResolveSymbol,
  original: (symbol: ts.Symbol) => ts.Symbol | undefined,
) {
  const imports = new Map<string, readonly Helper[]>([
    ["solid-js", ["createSignal"]],
    ["@tokamak/sdk/client", ["state", "view", "component"]],
  ]);
  const helpers = new Map<ts.Symbol, Helper>();
  for (const file of files) {
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier;
      const names = imports.get(specifier.text);
      const module = names && symbolAt(specifier);
      if (!module) continue;
      for (const exported of checker.getExportsOfModule(module)) {
        const name = names.find((candidate) => candidate === exported.name);
        if (name) helpers.set(original(exported)!, name);
      }
    }
  }
  return helpers;
}

function rejectPublicState(
  checker: ts.TypeChecker,
  exports: ts.Symbol,
  original: (symbol: ts.Symbol) => ts.Symbol | undefined,
) {
  const publicNames = runtimeExportNames(checker, exports);
  for (const exported of checker.getExportsOfModule(exports)) {
    if (!publicNames.has(exported.name)) continue;
    const symbol = original(exported);
    const declaration = symbol?.valueDeclaration;
    if (!declaration || !(symbol.flags & ts.SymbolFlags.Value)) continue;
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    if (type.getProperties().some((property) => property.name.startsWith("__@windowStateBrand@")))
      throw new Error(`Window state is private: do not export ${exported.name} from the plugin UI entry`);
  }
}

function collectWindowFile(
  file: ts.SourceFile,
  path: string,
  symbolAt: ResolveSymbol,
  helper: CallHelper,
  erased: (node: ts.Node) => boolean,
) {
  const lifts: Lift[] = [];
  const mounts: Mount[] = [];
  const ordinals = new Map<string, number>();

  function visit(node: ts.Node, component?: ComponentScope, enclosing = "<module>") {
    if (erased(node)) return;
    if (ts.isFunctionLike(node)) {
      component = componentScope(node, symbolAt, helper);
      if (component) enclosing = component.name;
    }
    if (ts.isCallExpression(node)) {
      const kind = helper(node);
      const name = bindingName(node, file);
      // Keep ordinary signals in helpers and callbacks on their usual Solid lifecycle.
      // Render-local signals need lifting because unmounting would otherwise discard them.
      if (kind === "state" || (kind === "createSignal" && component && name)) {
        lifts.push({
          call: node,
          name: name ?? String(node.getStart(file)),
          kind: kind === "state" ? "state" : "signal",
          component,
        });
      }
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
      const target = symbolAt(tag);
      if (target) {
        // Use a per-tag ordinal within the render so sibling sites differ and
        // unrelated edits or line shifts don't change their identity.
        const name = `${enclosing}:${tag.getText(file)}`;
        const n = (ordinals.get(name) ?? 0) + 1;
        ordinals.set(name, n);
        mounts.push({ node, target, site: `${path}:${name}:${n}` });
      }
    }
    ts.forEachChild(node, (child) => visit(child, component, enclosing));
  }
  visit(file);
  return { path, lifts, mounts };
}

function componentScope(
  render: ts.SignatureDeclaration,
  symbolAt: ResolveSymbol,
  helper: CallHelper,
): ComponentScope | undefined {
  if (!(ts.isFunctionDeclaration(render) || ts.isArrowFunction(render) || ts.isFunctionExpression(render)))
    return;
  if (!render.body || !ts.isBlock(render.body)) return;
  const parent = render.parent;
  const declared =
    ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name : render.name;
  // Solid's JSX treats capitalized names as components. Use the same convention
  // to recognize plain renders without requiring them to use an SDK wrapper.
  if (declared && /^[A-Z]/.test(declared.text))
    return { render, name: declared.text, symbol: symbolAt(declared) };
  if (!ts.isCallExpression(parent)) return;
  // TKM-210's component render uses the same mount identity as a plain Solid render.
  const kind = helper(parent);
  const outer = parent.parent;
  if (
    (kind === "view" || kind === "component") &&
    ts.isVariableDeclaration(outer) &&
    ts.isIdentifier(outer.name)
  )
    return { render, name: outer.name.text, symbol: symbolAt(outer.name) };
}

function bindingName(call: ts.CallExpression, file: ts.SourceFile): string | undefined {
  if (!ts.isVariableDeclaration(call.parent)) return;
  const binding = call.parent.name;
  if (ts.isIdentifier(binding)) return binding.text;
  if (ts.isArrayBindingPattern(binding))
    return binding.elements.find(ts.isBindingElement)?.name.getText(file);
}

function emitState(file: ts.SourceFile, output: MagicString, path: string, lifts: Lift[]) {
  const initialized = new Set<ComponentScope>();
  for (const { call, name, kind, component } of lifts) {
    if (component && !initialized.has(component)) {
      initialized.add(component);
      const { render } = component;
      const props = render.parameters[0]?.name;
      const key = props && ts.isIdentifier(props) ? `, ${props.text}?.key` : "";
      output.appendLeft(
        render.body!.getStart(file) + 1,
        `\nconst ${instance} = ${scope}.instance(${JSON.stringify(`${path}:${component.name}`)}${key});\n`,
      );
    }
    const key = component ? `${instance} + ${JSON.stringify(":" + name)}` : JSON.stringify(`${path}:${name}`);
    if (kind === "signal") {
      output.prependLeft(call.getStart(file), `${scope}.signal(${key}, () => `);
      output.appendLeft(call.end, ")");
      continue;
    }
    const initial = call.arguments[0];
    if (!initial) throw new Error(`state requires an initial value: ${file.fileName}`);
    output.overwrite(call.expression.getStart(file), call.expression.end, `${scope}.state`);
    output.appendLeft(initial.getStart(file), `${key}, `);
  }
  output.prepend(`import ${scope} from ${JSON.stringify(windowStateModule)};\n`);
}
