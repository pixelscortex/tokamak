import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type MagicString from "magic-string";
import ts from "typescript";
import { brand, importModule, inSource, unalias, type Element, type ElementMount } from "./compiler.ts";
import { partProps } from "./part-props.ts";

type Part = {
  target: string;
  props: string;
  type: string;
  fingerprint?: string;
  ambiguous?: boolean;
  row?: string;
};
type Tree = {
  part?: Part;
  opening?: ts.JsxOpeningLikeElement;
  children: Map<string, Tree>;
  entries: { name: string; node: ts.Node; fixed: boolean; tree: Tree }[];
};
type Row = { item: string; index: string; type: () => string; value: () => string };
type Scope = { tree: Tree; props: string; type: () => string; row?: Row };
type Binding = { node: ts.ConciseBody; parameter: ts.ParameterDeclaration };

const branch = (): Tree => ({ children: new Map(), entries: [] });
const voidTags = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));

function child(parent: Tree, name: string, node: ts.Node, fixed = false) {
  const tree = branch();
  parent.entries.push({ name, node, fixed, tree });
  return tree;
}

function tagIdentity(opening: ts.JsxOpeningLikeElement) {
  // Only what says which element this is; anything else is an ordinary edit.
  const attributes = opening.attributes.properties
    .flatMap((attribute) => {
      if (!ts.isJsxAttribute(attribute)) return [];
      const name = attribute.name.getText();
      const value = attribute.initializer;
      const expression = value && ts.isJsxExpression(value) ? value.expression : value;
      const text = expression && ts.isStringLiteralLike(expression) ? expression.text : null;
      if (/^(role|type|name|for|href)$/.test(name)) return [[name, text]];
      // A static ARIA value tells siblings apart; a computed one is state.
      return /^aria-/.test(name) && text !== null ? [[name, text]] : [];
    })
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  return [opening.tagName.getText(), attributes];
}

function assignParts(
  tree: Tree,
  prefix: string,
  paths: Map<string, Part>,
  inherited?: string,
  ambiguous = false,
) {
  const fixed = new Map<string, ts.Node>();
  const counts = new Map<string, number>();
  const identities = new Map<Tree, string>();
  const times = new Map<string, number>();
  for (const entry of tree.entries) {
    const { name, node } = entry;
    if (entry.fixed) {
      const previous = fixed.get(name);
      if (previous)
        throw problem(
          node,
          `Duplicate screen segment "${name}" (first declared in ${previous.getSourceFile().fileName})`,
        );
      fixed.set(name, node);
    } else {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      const identity = JSON.stringify(tagIdentity(entry.tree.opening!));
      identities.set(entry.tree, identity);
      const key = name + ":" + identity;
      times.set(key, (times.get(key) ?? 0) + 1);
    }
  }
  const positions = new Map<string, number>();
  for (const { name, fixed: named, tree: node } of tree.entries) {
    const position = (positions.get(name) ?? (fixed.has(name) ? 1 : 0)) + 1;
    if (!named) positions.set(name, position);
    const key = named || position === 1 ? name : `${name}$${position}`;
    const target = `${prefix}.${key}`;
    tree.children.set(key, node);
    const positional = !named && (fixed.has(name) || counts.get(name)! > 1);
    // A named segment adds nothing, but still carries its positional ancestors.
    let fingerprint = inherited;
    let uncertain = ambiguous;
    if (positional) {
      const identity = identities.get(node)!;
      fingerprint = createHash("sha256")
        .update(JSON.stringify([inherited, identity]))
        .digest("base64url")
        .slice(0, 12);
      uncertain ||= times.get(name + ":" + identity)! > 1;
    }
    if (node.part) {
      Object.assign(node.part, { target, fingerprint, ambiguous: uncertain });
      paths.set(target, node.part);
    }
    assignParts(node, target, paths, fingerprint, uncertain);
  }
}

function segment(name: string) {
  return name
    .replace(/[^\w]/g, (c) => `$${c.charCodeAt(0).toString(16)}$`)
    .replace(/^(target|fingerprint|__proto__|constructor|prototype)$/, (name) => "$" + name);
}

export function componentParts(entry: ts.SourceFile, program: ts.Program, plugin: string, root: string) {
  const files = new Map<ts.SourceFile, Map<Element, Part>>();
  const bindings = new Map<ts.SourceFile, (Binding & { name: string })[]>();
  const rows = new Map<
    ts.SourceFile,
    { node: ts.ArrowFunction | ts.FunctionExpression; item: string; index: string }[]
  >();
  const paths = new Map<string, Part>();
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
  let captures = 0;
  const solidBuiltins = new Set([
    "Show",
    "For",
    "Index",
    "Switch",
    "Match",
    "Suspense",
    "ErrorBoundary",
    "Dynamic",
    "Portal",
    "Errored",
  ]);

  function solidTag(tag: ts.JsxTagNameExpression) {
    const name = ts.isPropertyAccessExpression(tag) ? tag.name : tag;
    const binding = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(tag) ? tag.expression : tag);
    const declaration = binding?.declarations?.find(
      (node) => ts.isImportSpecifier(node) || ts.isNamespaceImport(node),
    );
    const module = importModule(declaration);
    if (module !== "solid-js" && module !== "@solidjs/web" && module !== "solid-js/web") return;
    return declaration && ts.isImportSpecifier(declaration)
      ? (declaration.propertyName ?? declaration.name).text
      : name.getText();
  }

  function alias(shape: string) {
    if (shape === "{}") return shape;
    const name = aliases.get(shape) ?? `Props${aliases.size + 1}`;
    aliases.set(shape, name);
    return name;
  }

  for (const source of sources) {
    const elements = new Map<Element, Part>();
    const pending: (Binding & { name: string })[] = [];
    const rowBindings: { node: ts.ArrowFunction | ts.FunctionExpression; item: string; index: string }[] = [];
    const base: Scope = { tree, props: "{}", type: () => "{}" };

    function visit(node: ts.Node, scope: Scope) {
      if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        const variable = ts.isVariableDeclaration(node.parent)
          ? node.parent
          : ts.isCallExpression(node.parent) &&
              ts.isVariableDeclaration(node.parent.parent) &&
              brand(checker.getTypeAtLocation(node.parent), "viewBrand")
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
          const props = parameter ? `__tokamakProps${++captures}` : scope.props;
          const outer = scope;
          let group: ReturnType<typeof child>;
          const identity = () =>
            (group ??= child(outer.tree, segment(name?.getText(source) ?? "Default"), node, true));
          let type: string;
          scope = {
            get tree() {
              return identity();
            },
            props,
            row: outer.row,
            type: () => {
              if (type) return type;
              if (!parameter) return outer.type();
              pending.push({ node: node.body!, parameter, name: props });
              const callable = declared && checker.getTypeOfSymbolAtLocation(declared, node);
              const shape =
                publicName && callable && (!ts.isCallExpression(node.parent) || brand(callable, "viewBrand"))
                  ? `Parameters<typeof import(${entryImport})[${JSON.stringify(publicName)}]>[0]`
                  : propsType(parameter);
              return (type = alias(shape));
            },
          };
          visit(node.body, scope);
          return;
        }
      }

      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const tag = opening.tagName;
        const builtin = solidTag(tag);
        if (builtin && solidBuiltins.has(builtin)) {
          const callback = builtin === "For" || builtin === "Index" ? childCallback(node) : undefined;
          if (callback && !callback.parameters.some((p) => p.dotDotDotToken)) {
            const item = `__tokamakItem${++captures}`;
            const index = `__tokamakIndex${captures}`;
            let rowType: string | undefined;
            const parent = scope.row;
            const row: Row = {
              item,
              index,
              value: () => `{ item: ${item}, index: ${index}${parent ? `, parent: ${parent.value()}` : ""} }`,
              type: () => {
                if (rowType) return rowType;
                rowBindings.push({ node: callback, item, index });
                const [first, second] = callback.parameters;
                const contextual = checker.getContextualType(callback);
                const signature = contextual?.getCallSignatures()[0];
                const contextualItem = signature?.parameters[0];
                const itemType = first
                  ? propsType(first)
                  : contextualItem
                    ? checker.typeToString(checker.getTypeOfSymbolAtLocation(contextualItem, callback))
                    : "unknown";
                const keyed = opening.attributes.properties.find(
                  (attr): attr is ts.JsxAttribute =>
                    ts.isJsxAttribute(attr) && attr.name.getText() === "keyed",
                )?.initializer;
                const positional =
                  keyed && ts.isJsxExpression(keyed) && keyed.expression?.kind === ts.SyntaxKind.FalseKeyword;
                const indexType = second
                  ? propsType(second)
                  : positional || builtin === "Index"
                    ? "number"
                    : "() => number";
                return (rowType = `{ readonly item: ${itemType}; readonly index: ${indexType}${parent ? `; readonly parent: ${parent.type()}` : ""} }`);
              },
            };
            function visitRow(child: ts.Node) {
              if (child === callback) visit(callback.body, { ...scope, row });
              else if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) visit(child, scope);
              else ts.forEachChild(child, visitRow);
            }
            ts.forEachChild(node, visitRow);
          } else ts.forEachChild(node, (child) => visit(child, scope));
          return;
        }
        const tagName = tag.getText(source);
        const named = staticName(opening, "data-part") ?? staticName(opening, "id");
        const group = child(scope.tree, segment(named ?? tagName), node, named !== undefined);
        const type = scope.type();
        const part: Part = {
          target: "",
          props: scope.props,
          type: scope.row ? alias(`${type} & { readonly $row: ${scope.row.type()} }`) : type,
          row: scope.row?.value(),
        };
        group.part = part;
        group.opening = opening;
        scope = { ...scope, tree: group };
        ts.forEachChild(node, (child) => visit(child, scope));
        elements.set(node, part);
      } else ts.forEachChild(node, (child) => visit(child, scope));
    }
    visit(source, base);
    if (elements.size) files.set(source, elements);
    if (pending.length) bindings.set(source, pending);
    if (rowBindings.length) rows.set(source, rowBindings);
  }

  assignParts(tree, plugin, paths);

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

  function compactParts(node: Tree): object {
    return Object.fromEntries([
      ...(node.part ? [["", node.part.fingerprint ?? null]] : []),
      ...[...node.children].map(([name, child]) => [name, compactParts(child)]),
    ]);
  }

  return {
    has: (node: Element) => files.get(node.getSourceFile())?.has(node) ?? false,
    part: (names: string[]) => paths.get(`${plugin}.${names.join(".")}`) ?? false,
    transform(
      source: ts.SourceFile,
      output: MagicString,
      mounts: ReadonlyMap<Element, ElementMount> | undefined,
      erased: (node: ts.Node) => boolean,
    ) {
      const elements = files.get(source);
      if (elements) {
        for (const { node, parameter, name } of bindings.get(source) ?? []) {
          if (erased(node)) continue;
          const binding = parameter.name.getText(source);
          const destructured = !ts.isIdentifier(parameter.name);
          if (destructured) output.overwrite(parameter.name.getStart(source), parameter.name.end, name);
          const capture = destructured ? `const ${binding} = ${name};` : `const ${name} = ${binding};`;
          if (ts.isBlock(node)) output.appendLeft(node.getStart(source) + 1, capture);
          else output.prependLeft(node.getStart(source), `{ ${capture} return (`);
        }
        for (const { node, item, index } of rows.get(source) ?? []) {
          if (erased(node)) continue;
          output.prependLeft(node.getStart(source), `(${item}, ${index}) => (`);
        }
        type Site = { node: Element; part: Part; children: Site[]; holes: Element[] };
        const native = new Set<Element>();
        const nativeRoots = new Map<Element, string>();
        const holes = new Map<Element, number>();
        const addresses = new Map<string, { variable: string; suffixes: string[] }>();
        function address({ target }: Part) {
          const segments = target.split(".");
          const prefix = segments.slice(0, 2).join(".");
          let group = addresses.get(prefix);
          if (!group) {
            group = { variable: `__tokamakAddresses${addresses.size + 1}`, suffixes: [] };
            addresses.set(prefix, group);
          }
          const index = group.suffixes.push(segments.slice(2).join(".")) - 1;
          return `${group.variable}[${index}]`;
        }
        const tables: string[] = [];
        function collect(node: Element): Site | undefined {
          const opening = ts.isJsxElement(node) ? node.openingElement : node;
          const part = elements!.get(node);
          const tag = opening.tagName.getText(source);
          if (!part || !/^[a-z][\w-]*$/.test(tag) || mounts?.has(node)) return;
          if (
            opening.attributes.properties.some(
              (attr) =>
                !ts.isJsxAttribute(attr) ||
                /^(children|innerHTML|outerHTML|textContent)$/.test(attr.name.getText(source)),
            )
          )
            return;
          const children: Site[] = [];
          const holes: Element[] = [];
          if (ts.isJsxElement(node))
            for (const child of node.children) {
              if (ts.isJsxText(child)) continue;
              if (ts.isJsxExpression(child)) {
                if (!child.expression) continue;
                const type = checker.getTypeAtLocation(child.expression);
                if (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike)) continue;
                return;
              }
              if (!ts.isJsxElement(child) && !ts.isJsxSelfClosingElement(child)) return;
              const site = collect(child);
              if (site) children.push(site);
              else {
                const tag = (ts.isJsxElement(child) ? child.openingElement : child).tagName.getText(source);
                if (!elements!.has(child) || /^[a-z][\w-]*$/.test(tag)) return;
                holes.push(child);
              }
            }
          // A mixed child list uses compiler refs to avoid inferring DOM positions
          // from a child component's variable number of rendered elements.
          if (
            holes.length &&
            children.some(
              ({ node }) =>
                holes.some((hole) => hole.end <= node.pos) &&
                (ts.isJsxElement(node) ? node.openingElement : node).attributes.properties.some(
                  (attr) => ts.isJsxAttribute(attr) && attr.name.getText(source) === "ref",
                ),
            )
          )
            return;
          return { node, part, children, holes };
        }
        for (const node of [...elements.keys()].reverse()) {
          if (erased(node) || native.has(node)) continue;
          const site = collect(node);
          if (
            !site ||
            (!site.children.length &&
              (site.holes.length || !(ts.isJsxElement(node) && node.children.some(ts.isJsxExpression))))
          )
            continue;
          let nextRef = 0;
          let nextHole = 0;
          function serialize(site: Site, ref: number | null = null, root = false): string {
            native.add(site.node);
            const grouped = site.holes.length ? nextHole++ : null;
            for (const hole of site.holes) holes.set(hole, grouped!);
            const children = site.children.map((child) => {
              let ref: number | null = null;
              if (site.holes.some((hole) => hole.end <= child.node.pos)) {
                ref = nextRef++;
                const opening = ts.isJsxElement(child.node) ? child.node.openingElement : child.node;
                output.appendLeft(
                  opening.attributes.end,
                  ` ref={(__el) => { __tokamakRefs[${ref}] = __el; }}`,
                );
              }
              return serialize(child, ref);
            });
            if (root) return `[${children.join(",")}]`;
            return `[${address(site.part)},${JSON.stringify(site.part.fingerprint ?? null)},[${children.join(",")}]${ref !== null || grouped !== null ? `,${ref},${grouped}` : ""}]`;
          }
          const name = `__tokamakIsland${nativeRoots.size + 1}`;
          const data = serialize(site, null, true);
          tables.push(`const ${name} = ${data};`);
          nativeRoots.set(node, name);
        }
        // Edit in JSX postorder so adjacent boundaries at the same offset
        // close the previous sibling before opening the next one.
        for (const [node, part] of elements) {
          if (erased(node)) continue;
          const island = nativeRoots.get(node);
          if (!island) {
            if (!native.has(node))
              transformElement(node, part, address(part), output, source, mounts?.get(node), holes.get(node));
            continue;
          }
          const container = ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent);
          output.appendLeft(
            node.getStart(source),
            `${container ? "{" : ""}__tokamakRenderNativePart(${partArguments(part, address(part))}, (__tokamakRefs, __tokamakHole) => `,
          );
          output.appendLeft(node.end, `, ${island})${container ? "}" : ""}`);
        }
        if (tables.length) output.prepend(tables.join("\n") + "\n");
        output.prepend(
          [...addresses]
            .map(
              ([prefix, { variable, suffixes }]) =>
                `const ${variable} = __tokamakPartPaths(${JSON.stringify(prefix)}, ${JSON.stringify(suffixes)});\n`,
            )
            .join(""),
        );
        for (const { node } of bindings.get(source) ?? []) {
          if (!erased(node) && !ts.isBlock(node)) output.appendLeft(node.end, "); }");
        }
        for (const { node, item, index } of rows.get(source) ?? []) {
          if (!erased(node)) output.appendLeft(node.end, `)(${item}, ${index})`);
        }
        output.prepend(
          'import { __renderPart as __tokamakRenderPart, __renderNativePart as __tokamakRenderNativePart, __partPaths as __tokamakPartPaths } from "@tokamak/sdk/client";\n',
        );
      }
      if (source === entry && paths.size)
        output.append(
          `\nimport { __defineScreenParts } from "@tokamak/sdk/client";\nconst __tokamakParts = __defineScreenParts(${JSON.stringify(plugin)}, ${JSON.stringify(compactParts(tree))});\nexport { __tokamakParts as parts };\n`,
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
          for (const { target, fingerprint } of installed?.contributes?.["component-action"] ?? []) {
            if (typeof target !== "string" || !target.startsWith(plugin + ".")) continue;
            const current = paths.get(target);
            const reason = !current
              ? `targets missing screen part ${target}`
              : fingerprint && current.fingerprint && current.fingerprint !== fingerprint
                ? `targets a changed screen part: path ${target} now names a different element`
                : "";
            if (!reason) continue;
            const message = `Plugin "${installed.id}" ${reason}; skipping this addition`;
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

function staticName(opening: ts.JsxOpeningLikeElement, key: string) {
  for (const attribute of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attribute) || attribute.name.getText() !== key) continue;
    const value = attribute.initializer;
    const expression = value && ts.isJsxExpression(value) ? value.expression : value;
    if (expression && ts.isStringLiteralLike(expression) && expression.text) return expression.text;
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

function partArguments(part: Part, target: string) {
  const row = part.row ? `() => (${part.row})` : "undefined";
  return `${target}, ${JSON.stringify(part.fingerprint)}, ${part.props} ?? {}, ${row}`;
}

function transformElement(
  node: Element,
  part: Part,
  target: string,
  output: MagicString,
  source: ts.SourceFile,
  mount?: ElementMount,
  hole?: number,
) {
  const parent = node.parent;
  // <div><Send /></div> → <div>{renderPart(…, () => <Send />)}</div>;
  // () => <Send /> → () => renderPart(…, () => <Send />).
  const child = ts.isJsxElement(parent) || ts.isJsxFragment(parent);
  const prefix = `${child ? "{" : ""}${hole === undefined ? "" : `__tokamakHole(${hole}, () => `}__tokamakRenderPart(${partArguments(part, target)}, (__tokamakContents) => `;
  const suffix = `)${hole === undefined ? "" : ")"}${child ? "}" : ""}`;
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
