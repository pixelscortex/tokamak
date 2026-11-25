import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type MagicString from "magic-string";
import ts from "typescript";
import { brand, inSource, unalias, type Element, type ElementMount } from "./compiler.ts";
import { partProps } from "./part-props.ts";

type Part = { target: string; props: string; type: string };
type Tree = { part?: Part; children: Map<string, Tree>; names: Map<string, number> };
type Scope = { path: string; tree: Tree; props: string; type: () => string };
type Binding = { node: ts.ConciseBody; parameter: ts.ParameterDeclaration };

const branch = (): Tree => ({ children: new Map(), names: new Map() });
const voidTags = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));

function child(parent: Tree, name: string) {
  const count = (parent.names.get(name) ?? 0) + 1;
  parent.names.set(name, count);
  const key = count === 1 ? name : `${name}$${count}`;
  const tree = branch();
  parent.children.set(key, tree);
  return { tree, key };
}

function segment(name: string) {
  return name
    .replace(/[^\w]/g, (c) => `$${c.charCodeAt(0).toString(16)}$`)
    .replace(/^(target|__proto__|constructor|prototype)$/, (name) => "$" + name);
}

export function componentParts(entry: ts.SourceFile, program: ts.Program, plugin: string, root: string) {
  const files = new Map<ts.SourceFile, Map<Element, Part>>();
  const bindings = new Map<ts.SourceFile, Binding[]>();
  const paths = new Set<string>();
  const tree = branch();
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(entry);
  const exported = new Map(
    (module ? checker.getExportsOfModule(module) : []).map((symbol) => [
      unalias(checker, symbol),
      symbol.name,
    ]),
  );
  const entryImport = JSON.stringify(
    "../" + relative(dirname(entry.fileName), entry.fileName).replace(/\.tsx?$/, ""),
  );

  const sources = program
    .getSourceFiles()
    .filter((file) => !file.isDeclarationFile && inSource(root, file.fileName))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
  const { propsType, privateDeclarations } = partProps(entry, checker, root, sources);
  const aliases = new Map<string, string>();
  for (const source of sources) {
    const elements = new Map<Element, Part>();
    const pending: Binding[] = [];
    const base: Scope = { tree, path: plugin, props: "{}", type: () => "{}" };

    function visit(node: ts.Node, scope: Scope) {
      if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        const variable = ts.isVariableDeclaration(node.parent)
          ? node.parent
          : ts.isCallExpression(node.parent) && ts.isVariableDeclaration(node.parent.parent)
            ? node.parent.parent
            : undefined;
        const name = ts.isFunctionDeclaration(node) ? node.name : variable?.name;
        const isDefault =
          ts.isExportAssignment(node.parent) ||
          (ts.isFunctionDeclaration(node) &&
            node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
        if ((isDefault || (name && ts.isIdentifier(name))) && node.body) {
          // Named functions own their JSX; inline callbacks retain the enclosing element and props.
          const declared = name && checker.getSymbolAtLocation(name);
          const publicName = isDefault ? "default" : declared && exported.get(declared);
          const parameter = node.parameters[0];
          const props = parameter ? "__tokamakProps" : "{}";
          let group: ReturnType<typeof child>;
          const identity = () => (group ??= child(tree, segment(name?.getText(source) ?? "Default")));
          let type: string;
          scope = {
            get tree() {
              return identity().tree;
            },
            get path() {
              return `${plugin}.${identity().key}`;
            },
            props,
            type: () => {
              if (type) return type;
              if (!parameter) return "{}";
              pending.push({ node: node.body!, parameter });
              const callable = declared && checker.getTypeOfSymbolAtLocation(declared, node);
              const shape =
                publicName && callable && (!ts.isCallExpression(node.parent) || brand(callable, "viewBrand"))
                  ? `Parameters<typeof import(${entryImport})[${JSON.stringify(publicName)}]>[0]`
                  : propsType(parameter);
              if (shape === "{}") return (type = shape);
              type = aliases.get(shape) ?? `Props${aliases.size + 1}`;
              aliases.set(shape, type);
              return type;
            },
          };
          visit(node.body, scope);
          return;
        }
      }

      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = (ts.isJsxElement(node) ? node.openingElement : node).tagName;
        const { tree: group, key } = child(scope.tree, segment(tag.getText(source)));
        const target = `${scope.path}.${key}`;
        const part = { target, props: scope.props, type: scope.type() };
        group.part = part;
        paths.add(target);
        scope = { ...scope, tree: group, path: target };
        ts.forEachChild(node, (child) => visit(child, scope));
        elements.set(node, part);
      } else ts.forEachChild(node, (child) => visit(child, scope));
    }
    visit(source, base);
    if (elements.size) files.set(source, elements);
    if (pending.length) bindings.set(source, pending);
  }

  function describe(node: Tree, value: (part: Part) => string, indent = ""): string {
    const next = indent + "  ";
    const parts = [...node.children].flatMap(([name, child]) => {
      const children = describe(child, value, next);
      if (!child.part && !children) return [];
      return [
        `${next}readonly ${JSON.stringify(name)}: ${child.part ? value(child.part) + (children ? " & " : "") : ""}${children};`,
      ];
    });
    return parts.length ? `{\n${parts.join("\n")}\n${indent}}` : "";
  }

  function values(node: Tree): object {
    return Object.fromEntries([
      ...(node.part ? [["target", node.part.target]] : []),
      ...[...node.children].flatMap(([name, child]) =>
        child.part || child.children.size ? [[name, values(child)]] : [],
      ),
    ]);
  }

  return {
    has: (node: Element) => files.get(node.getSourceFile())?.has(node) ?? false,
    part: (names: string[]) => paths.has(`${plugin}.${names.join(".")}`),
    transform(
      source: ts.SourceFile,
      output: MagicString,
      mounts: ReadonlyMap<Element, ElementMount> | undefined,
      erased: (node: ts.Node) => boolean,
    ) {
      const elements = files.get(source);
      if (elements) {
        for (const { node, parameter } of bindings.get(source) ?? []) {
          if (erased(node)) continue;
          const name = "__tokamakProps";
          const binding = parameter.name.getText(source);
          const destructured = !ts.isIdentifier(parameter.name);
          if (destructured) output.overwrite(parameter.name.getStart(source), parameter.name.end, name);
          const capture = destructured ? `const ${binding} = ${name};` : `const ${name} = ${binding};`;
          if (ts.isBlock(node)) output.appendLeft(node.getStart(source) + 1, capture);
          else output.prependLeft(node.getStart(source), `{ ${capture} return (`);
        }
        for (const [node, part] of elements) {
          if (!erased(node)) transformElement(node, part, output, source, mounts?.get(node));
        }
        for (const { node } of bindings.get(source) ?? []) {
          if (!erased(node) && !ts.isBlock(node)) output.appendLeft(node.end, "); }");
        }
        output.prepend('import { __renderPart as __tokamakRenderPart } from "@tokamak/sdk/client";\n');
      }
      if (source === entry && paths.size)
        output.append(
          `\nconst __tokamakParts = ${JSON.stringify(values(tree))};\nexport { __tokamakParts as parts };\n`,
        );
      return !!elements || (source === entry && paths.size > 0);
    },
    publish(warn: (message: string) => void, catalog?: string) {
      const path = join(dirname(entry.fileName), "_generated/components.d.ts");
      const shape = describe(
        tree,
        ({ target, type }) =>
          `import("@tokamak/sdk/client").ComponentPart<${JSON.stringify(target)}, ${type}>`,
      );
      const previous = readOptional(path);
      if (!shape && !previous) return;
      const declarations =
        privateDeclarations() +
        [...aliases]
          .map(([shape, name]) => `type ${name} = Extract<NonNullable<${shape}>, object>;\n`)
          .join("");
      const next = `// Generated plugin screen paths. Commit this file.\nexport * from ${entryImport};\n${shape ? `${declarations}export declare const parts: ${shape};\n` : ""}`;
      const reported = new Set<string>();
      const catalogs = new Set([
        dirname(root),
        process.env.TOKAMAK_PLUGIN_DIR,
        catalog && resolve(root, catalog),
      ]);
      for (const directory of catalogs) {
        if (!directory || !ts.sys.directoryExists(directory)) continue;
        const folders = readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
          .map((entry) => resolve(directory, entry.name));
        for (const folder of [directory, ...folders]) {
          const manifest =
            readOptional(resolve(folder, "manifest.json")) ??
            readOptional(resolve(folder, "dist/manifest.json"));
          if (!manifest) continue;
          let installed;
          try {
            installed = JSON.parse(manifest).plugin;
          } catch {
            continue; // The catalog reports invalid artifacts.
          }
          for (const { target } of installed?.contributes?.["component-action"] ?? []) {
            if (typeof target !== "string" || !target.startsWith(plugin + ".") || paths.has(target)) continue;
            const message = `Plugin "${installed.id}" targets missing screen part ${target}; skipping this addition`;
            if (reported.has(message)) continue;
            reported.add(message);
            warn(message);
          }
        }
      }
      if (next !== previous) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, next);
      }
    },
  };
}

function readOptional(path: string) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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
  const target = JSON.stringify(part.target);
  const prefix = `${child ? "{" : ""}__tokamakRenderPart(${target}, ${part.props} ?? {}, (__tokamakContents) => `;
  const suffix = `)${child ? "}" : ""}`;
  output.appendLeft(node.getStart(source), prefix + (mount?.prefix ?? ""));
  const endMount = mount?.suffix ?? "";

  if (ts.isJsxSelfClosingElement(node)) {
    const tag = node.tagName.getText(source);
    if (voidTags.has(tag)) {
      // <input /> → renderPart(…, () => <input />): a void tag
      // stays self-closing so outside actions do not create invalid children.
      output.appendLeft(node.end, endMount + suffix);
      return;
    }
    const attribute = childrenAttribute(node);
    const spread = node.attributes.properties.filter(ts.isJsxSpreadAttribute).at(-1);
    if (!attribute && spread) {
      // A caller can supply children through forwarded attributes, such as a render prop.
      output.prependLeft(spread.expression.getStart(source), "__tokamakContents.spread(");
      output.appendLeft(spread.expression.end, ")");
      output.appendLeft(node.end, endMount + suffix);
      return;
    }
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
    const contents = callback && authored ? renderProp(callback, authored) : "__tokamakContents()";
    const original = authored && !callback ? `, () => (${authored})` : "";
    output.overwrite(node.end - 2, node.end, `>{${contents}}</${tag}>${endMount}${original}${suffix}`);
    return;
  }

  const opening = node.openingElement;
  const close = node.closingElement;
  const tag = opening.tagName.getText(source);
  const callback = childCallback(node);
  if (callback) {
    const { prefix, suffix: end } = renderPropCall(callback);
    output.overwrite(opening.end, callback.getStart(source), `{${prefix}`);
    output.overwrite(callback.end, close.end, `${end}}</${tag}>${endMount}${suffix}`);
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
  // Solid uses Function.length to distinguish render props and provide a list index.
  const optional = callback.parameters.findIndex(
    (parameter) => parameter.initializer || parameter.dotDotDotToken,
  );
  const required = optional === -1 ? callback.parameters.length : optional;
  const args = Array.from({ length: required }, (_, i) => `__tokamakArg${i}`);
  const params = [...args, "...__tokamakRest"].join(", ");
  return {
    prefix: `(${params}) => __tokamakContents(() => (`,
    suffix: `)(${params}))`,
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
