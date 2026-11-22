import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type MagicString from "magic-string";
import ts from "typescript";
import { runtimeExportNames } from "../../sdk/tools/plugin-compiler.mjs";
import {
  brand,
  exportedInitializer,
  importModule,
  inSource,
  unalias,
  type Element,
  type ElementMount,
} from "./compiler.ts";

type Part = { name: string; target: string; locked: boolean };
type Definition = {
  call: ts.CallExpression;
  parts: Part[];
  elements: { node: Element; part?: Part; markers: ts.JsxAttribute[] }[];
};
const reserved = new Set(Object.getOwnPropertyNames(Function.prototype).concat("prototype", "__proto__"));
const voidTags = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const namePattern = /^[A-Za-z_$][\w$]*$/;
const solidModules = new Set(["solid-js", "solid-js/web", "@solidjs/web"]);
const solidBuiltins = new Set(
  "For Show Errored ErrorBoundary Switch Match Index Dynamic Portal Suspense SuspenseList Loading Repeat Reveal NoHydration Hydration".split(
    " ",
  ),
);

export function componentParts(entry: ts.SourceFile, checker: ts.TypeChecker, plugin: string, root: string) {
  const files = new Map<ts.SourceFile, Definition[]>();
  const published = new Map<string, Definition>();
  const definitions = new Map<ts.CallExpression, Definition>();
  const named = new Set<Element>();
  const byName = new Set<string>();
  const module = checker.getSymbolAtLocation(entry);
  const runtime: Set<string> = module ? runtimeExportNames(checker, module) : new Set();
  for (const exported of module ? checker.getExportsOfModule(module) : []) {
    if (!runtime.has(exported.name)) continue;
    const symbol = unalias(checker, exported);
    const declaration = symbol.valueDeclaration;
    if (!declaration || !inSource(root, declaration.getSourceFile().fileName)) continue;
    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    if (!brand(type, "componentBrand")) continue;
    const call = exportedInitializer(declaration);
    if (!call || !ts.isCallExpression(call))
      throw problem(declaration, "Export a component defined by component(name, options, render)");
    let definition = definitions.get(call);
    if (!definition) {
      const name = call.arguments[0];
      const render = call.arguments[2];
      if (!name || !ts.isStringLiteralLike(name) || !namePattern.test(name.text))
        throw problem(call, "component requires a literal identifier as its name");
      if (byName.has(name.text)) throw problem(call, `Duplicate component name "${name.text}"`);
      byName.add(name.text);
      if (!render || (!ts.isArrowFunction(render) && !ts.isFunctionExpression(render)))
        throw problem(call, "component requires an inline render function to discover its elements");
      definition = { call, parts: [], elements: [] };
      discover(render.body, `${plugin}.${name.text}`, definition, checker);
      for (const { node, part } of definition.elements) if (part) named.add(node);
      definitions.set(call, definition);
      const file = call.getSourceFile();
      const list = files.get(file) ?? [];
      list.push(definition);
      files.set(file, list);
    }
    published.set(exported.name, definition);
  }

  return {
    has: (node: Element) => named.has(node),
    part(exported: string, name: string) {
      return published.get(exported)?.parts.find((p) => p.name === name);
    },
    transform(source: ts.SourceFile, output: MagicString, mounts?: ReadonlyMap<Element, ElementMount>) {
      const list = files.get(source);
      if (!list) return false;
      for (const { call, parts, elements } of list) {
        output.overwrite(call.expression.getStart(source), call.expression.end, "__tokamakDefineComponent");
        output.appendLeft(
          call.arguments.at(-1)!.end,
          ", " +
            JSON.stringify(
              Object.fromEntries(parts.map(({ name, target, locked }) => [name, { target, locked }])),
            ),
        );
        for (const { node, part, markers } of elements) {
          for (const marker of markers) output.remove(marker.getStart(source), marker.end);
          if (part) transformElement(node, part, output, source, mounts?.get(node));
        }
      }
      output.prepend(
        'import { __defineComponent as __tokamakDefineComponent, __renderPart as __tokamakRenderPart } from "@tokamak/sdk/client";\n',
      );
      return true;
    },
    publish(warn: (message: string) => void) {
      const path = join(dirname(entry.fileName), "_generated/components.d.ts");
      let previous = "";
      try {
        previous = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!published.size && !previous) return;
      const module = JSON.stringify(
        "../" + relative(dirname(entry.fileName), entry.fileName).replace(/\.tsx?$/, ""),
      );
      const lines = [
        "// Generated plugin component paths. Commit this file.",
        `export * from ${module};`,
        // An explicit declaration takes precedence over the entry's unaugmented export.
        ...[...published]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, { parts }]) => {
            const type = `(typeof import(${module}))[${JSON.stringify(name)}]`;
            const properties = [...parts]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(
                (p) =>
                  `  readonly ${JSON.stringify(p.name)}: { readonly target: ${JSON.stringify(p.target)}; readonly locked: ${p.locked} };`,
              );
            return `declare const _part_${name}: import("@tokamak/sdk/client").ComponentParts<${type}, {\n${properties.join("\n")}\n}>;\nexport { _part_${name} as ${name} };`;
          }),
      ];
      const next = lines.join("\n") + "\n";
      const available = new Set([...definitions.values()].flatMap((d) => d.parts.map((p) => p.target)));
      for (const target of previousTargets(path, previous)) {
        if (!available.has(target)) warn(`Published component element no longer exists: ${target}`);
      }
      if (next !== previous) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, next);
      }
    },
  };
}

function previousTargets(path: string, text: string) {
  // The declaration is the published schema; read its type structure so changes
  // to indentation or quoting do not hide deleted paths.
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest);
  const targets = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const type = declaration.type;
      if (!type || !ts.isImportTypeNode(type) || type.qualifier?.getText(file) !== "ComponentParts") continue;
      const shape = type.typeArguments?.[1];
      if (!shape || !ts.isTypeLiteralNode(shape)) continue;
      for (const member of shape.members) {
        if (!ts.isPropertySignature(member) || !member.type) continue;
        const part = member.type;
        const target = ts.isTypeLiteralNode(part)
          ? part.members.find(
              (p): p is ts.PropertySignature =>
                ts.isPropertySignature(p) && ts.isIdentifier(p.name) && p.name.text === "target",
            )?.type
          : ts.isTypeOperatorNode(part) && ts.isTupleTypeNode(part.type)
            ? part.type.elements[0] // Read declarations from before the object format, too.
            : undefined;
        if (target && ts.isLiteralTypeNode(target) && ts.isStringLiteral(target.literal)) {
          targets.add(target.literal.text);
        }
      }
    }
  }
  return targets;
}

function isSolidBuiltin(tag: ts.JsxTagNameExpression, checker: ts.TypeChecker) {
  if (ts.isPropertyAccessExpression(tag)) {
    // Check the original tag name for a direct namespace import such as <Flow.Show>.
    const namespace = checker.getSymbolAtLocation(tag.expression)?.declarations?.find(ts.isNamespaceImport);
    if (solidBuiltins.has(tag.name.text) && solidModules.has(importModule(namespace) ?? "")) return true;
  } else {
    const binding = checker.getSymbolAtLocation(tag)?.declarations?.find(ts.isImportSpecifier);
    if (
      binding &&
      solidBuiltins.has((binding.propertyName ?? binding.name).text) &&
      solidModules.has(importModule(binding) ?? "")
    )
      return true;
  }
  // Follow a plugin's re-export (e.g. export { Show as Visible } from "solid-js").
  const symbol = checker.getSymbolAtLocation(tag);
  if (!symbol) return false;
  const original = unalias(checker, symbol);
  return (
    solidBuiltins.has(original.name) &&
    !!original.declarations?.some((d) =>
      /[/\\]node_modules[/\\](?:solid-js|@solidjs[/\\]web)[/\\]/.test(d.getSourceFile().fileName),
    )
  );
}

function discover(root: ts.Node, path: string, definition: Definition, checker: ts.TypeChecker) {
  const names = new Set<string>();
  function visit(node: ts.Node) {
    ts.forEachChild(node, visit);
    if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    const opening = ts.isJsxElement(node) ? node.openingElement : node;
    const markers = opening.attributes.properties.filter(
      (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && ["part", "locked"].includes(p.name.getText()),
    );
    const explicit = markers.find((p) => p.name.getText() === "part");
    const tag = opening.tagName.getText().split(".").at(-1)!;
    let name: string | undefined;
    if (explicit) {
      // <Show part="results"> → public results; <button part="send"> → public send.
      const value = explicit.initializer;
      const literal = value && ts.isJsxExpression(value) ? value.expression : value;
      if (!literal || !ts.isStringLiteralLike(literal) || !namePattern.test(literal.text))
        throw problem(explicit, "part requires a literal identifier");
      name = literal.text;
    } else if (
      (/^[A-Z]/.test(tag) || ts.isPropertyAccessExpression(opening.tagName)) &&
      !isSolidBuiltin(opening.tagName, checker)
    ) {
      // <SendButton> → public sendButton. Lowercase the initial acronym as a
      // word (<URLField> → urlField, <URL> → url), leaving the next capital intact.
      name = tag.replace(/^[A-Z]+(?=[A-Z][a-z]|$)|^[A-Z]/, (prefix) => prefix.toLowerCase());
    }
    // <Show> and <button> without part stay private. Strip any compiler-only
    // marker before Solid sees it, e.g. <button locked> → <button>.
    const lock = markers.find((p) => p.name.getText() === "locked");
    const value = lock?.initializer;
    if (value && (!ts.isJsxExpression(value) || value.expression?.kind !== ts.SyntaxKind.TrueKeyword))
      throw problem(lock!, "Use locked or locked={true} to protect an element");
    // <Send locked /> → a typed send path with locked: true; actions fail at build time.
    let part: Part | undefined;
    if (name) {
      if (reserved.has(name))
        throw problem(node, `Element name "${name}" is reserved; use part to rename it`);
      if (names.has(name))
        throw problem(node, `Element "${name}" is named twice in ${path}; use part to give it a unique name`);
      names.add(name);
      // <SendButton>{(added) => …}</SendButton> looks like a render prop to Solid.
      // Put the placement callback in <div part="send">{(added) => …}</div> instead.
      if (!isNative(opening.tagName)) {
        const callback = childCallback(node);
        const param = callback?.parameters[0];
        if (
          callback &&
          param &&
          ((ts.isIdentifier(param.name) && param.name.text === "added") ||
            (param.type && checker.getTypeAtLocation(param.type).getSymbol()?.name === "PartAdditions"))
        ) {
          throw problem(
            callback,
            "PartAdditions placement callbacks require a named native element; use a render prop for the component's own data",
          );
        }
      }
      part = { name, target: `${path}.${name}`, locked: !!lock };
      definition.parts.push(part);
    }
    if (part || markers.length) definition.elements.push({ node, part, markers });
  }
  visit(root);
}

function isNative(tag: ts.JsxTagNameExpression) {
  return ts.isIdentifier(tag) && /^[a-z]/.test(tag.text);
}

function childrenAttribute(opening: ts.JsxOpeningLikeElement) {
  return opening.attributes.properties.find(
    (attribute): attribute is ts.JsxAttribute =>
      ts.isJsxAttribute(attribute) && attribute.name.getText() === "children",
  );
}

function childExpression(children: readonly ts.JsxChild[]) {
  const [only, ...rest] = children.filter((n) => !ts.isJsxText(n) || !!n.getText().trim());
  return !rest.length && only && ts.isJsxExpression(only) ? only.expression : undefined;
}

function childCallback(node: Element) {
  const value = ts.isJsxElement(node) ? undefined : childrenAttribute(node)?.initializer;
  return inlineCallback(
    ts.isJsxElement(node)
      ? childExpression(node.children)
      : value && ts.isJsxExpression(value)
        ? value.expression
        : undefined,
  );
}

function transformElement(
  node: Element,
  part: Part,
  output: MagicString,
  source: ts.SourceFile,
  mount?: ElementMount,
) {
  const parent = node.parent;
  // <div><Send /></div> → <div>{renderPart(…, () => <Send />)}</div>;
  // () => <Send /> → () => renderPart(…, () => <Send />).
  const child = ts.isJsxElement(parent) || ts.isJsxFragment(parent);
  const target = part.locked ? "null" : JSON.stringify(part.target);
  const prefix = `${child ? "{" : ""}__tokamakRenderPart(${target}, (__tokamakContents) => `;
  const suffix = `)${child ? "}" : ""}`;
  output.appendLeft(node.getStart(source), prefix + (mount?.prefix ?? ""));
  const endMount = mount?.suffix ?? "";

  if (ts.isJsxSelfClosingElement(node)) {
    const tag = node.tagName.getText(source);
    if (voidTags.has(tag)) {
      // <input part="search" /> → renderPart(…, () => <input />): a void tag
      // stays self-closing so outside actions do not create invalid children.
      output.appendLeft(node.end, endMount + suffix);
      return;
    }
    const attribute = childrenAttribute(node);
    const value = attribute?.initializer;
    const expression = value && ts.isJsxExpression(value) ? value : undefined;
    // Include the braces when slicing so inserts at the start of a nested
    // JSX expression move with it.
    const authored = expression?.expression
      ? output.slice(expression.getStart(source), expression.end).slice(1, -1)
      : value && ts.isStringLiteral(value)
        ? JSON.stringify(value.text)
        : undefined;
    if (attribute) output.remove(attribute.getStart(source), attribute.end);
    // <Region /> → <Region>{contents()}</Region> to allow inside additions.
    // <For children={row => …} /> → <For>{row => contents(() => renderRow(row))}</For>.
    const callback = childCallback(node);
    const place = callback && authored && isNative(node.tagName);
    const contents = callback && authored && !place ? renderProp(callback, authored) : "__tokamakContents()";
    // <div children={added => …} /> puts that callback in renderPart's placement
    // argument; <div children={<b />} /> goes through the lazy default () => <b />.
    const original = place
      ? `, undefined, ${authored}`
      : authored && !callback
        ? `, () => (${authored})`
        : "";
    output.overwrite(node.end - 2, node.end, `>{${contents}}</${tag}>${endMount}${original}${suffix}`);
    return;
  }

  const opening = node.openingElement;
  const close = node.closingElement;
  const tag = opening.tagName.getText(source);
  const callback = childCallback(node);
  if (callback) {
    if (isNative(opening.tagName)) {
      // <div>{added => <b>{added.append}</b>}</div> →
      // renderPart(…, contents => <div>{contents()}</div>, undefined, added => <b>…</b>).
      output.overwrite(
        opening.end,
        callback.getStart(source),
        `{__tokamakContents()}</${tag}>${endMount}, undefined, `,
      );
      output.overwrite(callback.end, close.end, suffix);
    } else {
      // <For>{row => <b>{row}</b>}</For> →
      // <For>{row => contents(() => renderRow(row))}</For>.
      const { prefix, suffix: end } = renderPropCall(callback);
      output.overwrite(opening.end, callback.getStart(source), `{${prefix}`);
      output.overwrite(callback.end, close.end, `${end}}</${tag}>${endMount}${suffix}`);
    }
  } else {
    // <div><b>Text</b></div> → renderPart(…, contents => <div>{contents()}</div>,
    // () => <><b>Text</b></>): hide and replace can now skip the original children.
    output.prependLeft(opening.end, `{__tokamakContents()}</${tag}>${endMount}, () => <>`);
    output.overwrite(close.getStart(source), close.end, `</>${suffix}`);
  }
}

function inlineCallback(node: ts.Expression | undefined) {
  return node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) ? node : undefined;
}

function renderPropCall(callback: ts.ArrowFunction | ts.FunctionExpression) {
  // <Show>{value => …}</Show> needs value => contents(() => render(value));
  // <Show>{() => …}</Show> needs () => contents(() => render()). Solid uses
  // Function.length to distinguish a render prop from a child accessor.
  return {
    prefix: callback.parameters.length
      ? "(__tokamakValue, ...__tokamakArgs) => __tokamakContents(() => ("
      : "() => __tokamakContents(() => (",
    suffix: callback.parameters.length ? ")(__tokamakValue, ...__tokamakArgs))" : ")())",
  };
}

function renderProp(callback: ts.ArrowFunction | ts.FunctionExpression, source: string) {
  const { prefix, suffix } = renderPropCall(callback);
  return prefix + source + suffix;
}

export function problem(node: ts.Node, message: string) {
  const source = node.getSourceFile();
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return new Error(`${source.fileName}:${line + 1}:${character + 1}: ${message}`);
}
