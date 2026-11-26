import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type MagicString from "magic-string";
import ts from "typescript";
import { brand, importModule, inSource, unalias, type Element, type ElementMount } from "./compiler.ts";
import { partProps } from "./part-props.ts";
import {
  attributeFilters,
  isAriaAttribute,
  isSearchAttribute,
  resolveScreenSearch,
  screenElements,
  screenTarget,
  unnamedTargetWarning,
  type ScreenSearch,
  type ScreenTree,
} from "../../sdk/screen-search.ts";

type Part = {
  target: string;
  props: string;
  type: string;
  elementType: () => string;
  fingerprint?: string;
  ambiguous?: boolean;
  row?: string;
  unnamed?: boolean;
  attributes?: string[];
  computed?: string[];
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

function tagIdentity(opening: ts.JsxOpeningLikeElement, part: Part) {
  // Only what says which element this is; anything else is an ordinary edit.
  const properties = opening.attributes.properties;
  const lastSpread = properties.map(ts.isJsxSpreadAttribute).lastIndexOf(true);
  const attributes = properties
    .flatMap((attribute, index) => {
      if (!ts.isJsxAttribute(attribute)) return [];
      const name = attribute.name.getText();
      const value = attribute.initializer;
      const expression = value && ts.isJsxExpression(value) ? value.expression : value;
      const text = expression && ts.isStringLiteralLike(expression) ? expression.text : null;
      if (isSearchAttribute(name) || isAriaAttribute(name)) {
        // A later spread can replace the value when the screen runs, so only
        // a literal that nothing can override is safe to search by.
        if (text !== null && index > lastSpread) (part.attributes ??= []).push(name, text);
        else (part.computed ??= []).push(name);
      }
      if (isSearchAttribute(name) || name === "name" || name === "for") return [[name, text]];
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
  const scopes = new Map<string, ts.Node>();
  const fixedCounts = new Map<string, number>();
  const counts = new Map<string, number>();
  const identities = new Map<Tree, string>();
  const times = new Map<string, number>();
  for (const { name, node, fixed: named, tree: child } of tree.entries) {
    if (named) {
      if (!fixed.has(name)) fixed.set(name, node);
      fixedCounts.set(name, (fixedCounts.get(name) ?? 0) + 1);
    }
    if (!child.part) {
      const previous = scopes.get(name);
      if (previous)
        throw problem(
          node,
          `Duplicate screen segment "${name}" (first declared in ${previous.getSourceFile().fileName})`,
        );
      scopes.set(name, node);
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (child.opening) {
      const identity = JSON.stringify(tagIdentity(child.opening, child.part!));
      identities.set(child, identity);
      const key = name + ":" + identity;
      times.set(key, (times.get(key) ?? 0) + 1);
    }
  }
  const positions = new Map<string, number>();
  for (const { name, node, fixed: named, tree: child } of tree.entries) {
    const first = named && fixed.get(name) === node;
    const position = first ? 1 : (positions.get(name) ?? (fixed.has(name) ? 1 : 0)) + 1;
    if (!first) positions.set(name, position);
    const key = position === 1 ? name : `${name}$${position}`;
    const target = `${prefix}.${key}`;
    tree.children.set(key, child);
    const positional = child.opening && counts.get(name)! > 1 && (!first || fixedCounts.get(name)! > 1);
    // A unique explicit name still carries any positional ancestors.
    let fingerprint = inherited;
    let uncertain = ambiguous;
    if (positional) {
      const identity = identities.get(child)!;
      // Siblings their attributes cannot tell apart: a swap goes unnoticed, so
      // the add-on's build asks for a name. Their contents stay out of the
      // fingerprint, or every edit inside would read as a move.
      uncertain ||= times.get(name + ":" + identity)! > 1;
      fingerprint = createHash("sha256")
        .update(JSON.stringify([inherited, identity]))
        .digest("base64url")
        .slice(0, 12);
    }
    if (child.part) {
      Object.assign(child.part, { target, fingerprint, ambiguous: uncertain });
      paths.set(target, child.part);
    }
    assignParts(child, target, paths, fingerprint, uncertain);
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
  const exports = module ? checker.getExportsOfModule(module) : [];
  const find = exports.find((symbol) => symbol.name === "find");
  if (find)
    throw problem(
      find.declarations?.[0] ?? entry,
      "The plugin builder generates the public find export; use a different name",
    );
  const exported = new Map(exports.map((symbol) => [unalias(checker, symbol), symbol.name]));
  const entryImport = JSON.stringify(
    "../" + relative(dirname(entry.fileName), entry.fileName).replace(/\.tsx?$/, ""),
  );

  const sources = program
    .getSourceFiles()
    .filter((file) => !file.isDeclarationFile && inSource(root, file.fileName))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
  const { propsType, typeShape, componentValue, annotation, privateDeclarations } = partProps(
    entry,
    checker,
    root,
    sources,
  );
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
    const name = aliases.get(shape) ?? `P${aliases.size + 1}`;
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
        if (
          opening.attributes.properties.some(
            (attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText() === "data-part-ignore",
          )
        )
          return;
        const tag = opening.tagName;
        const original =
          ts.isPropertyAccessExpression(tag) && tag.name.text === "Children" ? tag.expression : tag;
        if (brand(checker.getTypeAtLocation(original), "originalElementBrand")) {
          ts.forEachChild(node, (child) => visit(child, scope));
          return;
        }
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
          unnamed: named === undefined && /^[a-z][\w-]*$/.test(tagName),
          props: scope.props,
          elementType: () => {
            if (/^[a-z][\w-]*$/.test(tagName)) return JSON.stringify(tagName);
            const signature = checker.getResolvedSignature(opening);
            const parameter = signature?.parameters[0];
            if (!parameter) return "{}";
            const declaration = parameter.valueDeclaration;
            const type = checker.getTypeOfSymbolAtLocation(parameter, opening);
            if (
              declaration &&
              ts.isParameter(declaration) &&
              inSource(root, declaration.getSourceFile().fileName) &&
              checker.getTypeAtLocation(declaration) === type
            )
              return propsType(declaration);
            const value = componentValue(tag);
            if (value) {
              const args = opening.typeArguments?.map(annotation).join(", ");
              return `C<typeof ${value}${args ? `<${args}>` : ""}>`;
            }
            return typeShape(type);
          },
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

  function compactParts(node: Tree): ScreenTree {
    const fingerprint = node.part?.fingerprint ?? null;
    return [
      ...(node.part ? ["", node.part.attributes ? [fingerprint, ...node.part.attributes] : fingerprint] : []),
      ...[...node.children].flatMap(([key, child]) => [
        key,
        child.part && !child.children.size && !child.part.attributes
          ? (child.part.fingerprint ?? null)
          : compactParts(child),
      ]),
    ];
  }
  const compact = compactParts(tree);
  const elements = screenElements(plugin, compact).map((element) => {
    const computed = paths.get(element.target)?.computed;
    return computed ? { ...element, computed } : element;
  });
  // Pack the shape into a string so the bundle keeps its compact layout.
  const packed = JSON.stringify(compact);

  return {
    has: (node: Element) => files.get(node.getSourceFile())?.has(node) ?? false,
    resolve(search: ScreenSearch) {
      const result = resolveScreenSearch(elements, search);
      const part = result.element && paths.get(result.element.target);
      return { ...result, ambiguous: part?.ambiguous, unnamed: part?.unnamed };
    },
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
        type Site = {
          node: Element;
          part: Part;
          children: Site[];
          holes: Element[];
          text: ts.JsxExpression[];
        };
        const native = new Set<Element>();
        const nativeRoots = new Map<Element, { table: string; rootHole: boolean }>();
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
          const text: ts.JsxExpression[] = [];
          if (ts.isJsxElement(node))
            for (const child of node.children) {
              if (ts.isJsxText(child)) continue;
              if (ts.isJsxExpression(child)) {
                if (!child.expression) continue;
                const type = checker.getTypeAtLocation(child.expression);
                if (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike)) {
                  text.push(child);
                  continue;
                }
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
          return { node, part, children, holes, text };
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
            const node = site.node;
            if (
              site.text.length === 1 &&
              ts.isJsxElement(node) &&
              node.children.every(
                (child) =>
                  ts.isJsxExpression(child) ||
                  (ts.isJsxText(child) && /^\s*[\r\n]\s*$/.test(child.getFullText(source))),
              )
            ) {
              const tag = node.openingElement.tagName.getText(source);
              const value = site.text[0]!.expression!;
              // Let Solid keep special native element semantics, such as
              // resynchronizing a select when its option's text changes.
              const special = /^(option|textarea|script|style|title)$/.test(tag);
              output.prependLeft(value.getStart(source), special ? "[" : "__tokamakScalarText(");
              output.appendLeft(value.end, special ? "]" : ")");
            }
            if (ref !== null) {
              const opening = ts.isJsxElement(node) ? node.openingElement : node;
              output.appendLeft(opening.attributes.end, ` ref={(__el) => { __tokamakRefs[${ref}] = __el; }}`);
            }
            for (const hole of site.holes) holes.set(hole, grouped!);
            const children = site.children.map((child) =>
              serialize(child, site.holes.some((hole) => hole.end <= child.node.pos) ? nextRef++ : null),
            );
            if (root) return `[${children.join(",")}]`;
            return `[${address(site.part)},${JSON.stringify(site.part.fingerprint ?? null)},[${children.join(",")}]${ref !== null || grouped !== null ? `,${ref},${grouped}` : ""}]`;
          }
          const name = `__tokamakIsland${nativeRoots.size + 1}`;
          const data = serialize(site, null, true);
          tables.push(`const ${name} = ${data};`);
          nativeRoots.set(node, { table: name, rootHole: !!site.holes.length });
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
          output.appendLeft(
            node.end,
            `, ${island.table}${island.rootHole ? ", 0" : ""})${container ? "}" : ""}`,
          );
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
          'import { __renderComponentPart as __tokamakRenderComponentPart, __renderPlainPart as __tokamakRenderPlainPart, __renderNativePart as __tokamakRenderNativePart, __partPaths as __tokamakPartPaths } from "@tokamak/sdk/client";\n',
        );
      }
      if (source === entry)
        output.append(
          `\nimport { __defineScreenFind } from "@tokamak/sdk/client";\nconst __tokamakFind = __defineScreenFind(${JSON.stringify(plugin)}, ${JSON.stringify(packed)});\nexport { __tokamakFind as find };\n`,
        );
      return !!elements || source === entry;
    },
    publish(warn: (message: string) => void, catalog?: string) {
      const path = join(dirname(entry.fileName), "_generated/components.d.ts");
      const names = new Map<string, typeof elements>();
      for (const element of elements) {
        const matches = names.get(element.name);
        if (matches) matches.push(element);
        else names.set(element.name, [element]);
      }
      const attributeTypes = new Map<string, string>();
      const modules = new Map<string, string[]>();
      const compactType = (type: string) =>
        type.startsWith('"') || type === "{}" || type.startsWith("C<") ? type : alias(type);
      const shape = [...names]
        .map(([name, matches]) => {
          const types = matches.map((element) => paths.get(element.target)!.elementType());
          const type = types[0]!;
          const shared = types.every((entry) => entry === type);
          if (shared && type !== JSON.stringify(name)) {
            const imported = /^C<typeof (import\("[^"]+"\))\.([\w$.]+)>$/.exec(type);
            if (imported && imported[2] === name) {
              const module = imported[1]!;
              const names = modules.get(module);
              if (names) names.push(name);
              else modules.set(module, [name]);
            } else attributeTypes.set(name, compactType(type));
          }
          const only = matches[0]!;
          if (matches.length === 1 && !only.attributes)
            return `  ${JSON.stringify(name)}: ${paths.get(only.target)!.type};\n`;
          const entries = matches.map((element, index) => {
            const part = paths.get(element.target)!;
            const scopes = [...new Set(element.ancestors)].map((name) => JSON.stringify(name));
            const filters = element.attributes && JSON.stringify(attributeFilters(element.attributes));
            const attrs = !shared && types[index] !== JSON.stringify(name) ? compactType(types[index]!) : "";
            return `[${scopes.join(" | ") || "never"}, ${part.type}${attrs ? `, ${filters ?? "undefined"}, ${attrs}` : filters ? `, ${filters}` : ""}]`;
          });
          return `  ${JSON.stringify(name)}: [${entries.join(", ")}];\n`;
        })
        .join("");
      const attributes =
        [
          ...(attributeTypes.size
            ? [
                `{ ${[...attributeTypes].map(([name, type]) => `${JSON.stringify(name)}:${type}`).join("; ")} }`,
              ]
            : []),
          ...[...modules].map(
            ([module, names]) =>
              `A<typeof ${module}, ${names.map((name) => JSON.stringify(name)).join("|")}>`,
          ),
        ].join(" & ") || "{}";
      const types =
        shape.includes("C<typeof ") || attributes.includes("C<typeof ")
          ? 'import type { ComponentProps as C } from "@solidjs/web";\n'
          : "";
      const helpers = modules.size
        ? 'import type { ComponentAttributes as A } from "@tokamak/sdk/client";\n'
        : "";
      const previous = readOptional(path);
      const declarations =
        privateDeclarations() +
        [...aliases]
          .map(([shape, name]) => `type ${name} = Extract<NonNullable<${shape}>, object>;\n`)
          .join("");
      const next = `// Generated plugin screen search types. Commit this file.\nexport * from ${entryImport};\n${types}${helpers}${declarations}export declare const find: import("@tokamak/sdk/client").ScreenFind<{\n${shape}}, ${attributes}>;\n`;
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
          for (const options of installed?.contributes?.["component-action"] ?? []) {
            const previous = screenTarget(options);
            if (
              typeof options.owner === "string"
                ? options.owner !== plugin
                : !previous.target.startsWith(plugin + ".")
            )
              continue;
            const { reason, element } = resolveScreenSearch(elements, previous.search, previous);
            if (reason) {
              const message = `Plugin "${installed.id}": ${reason}; skipping this addition`;
              if (reported.has(message)) continue;
              reported.add(message);
              warn(message);
            } else if (previous.search && element && paths.get(element.target)?.unnamed) {
              const key = JSON.stringify([installed.id, element.target]);
              if (reported.has(key)) continue;
              reported.add(key);
              warn(unnamedTargetWarning(installed.id, previous.search, element.target));
            }
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
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const component = !/^[a-z][\w-]*$/.test(opening.tagName.getText(source));
  const entry = component ? "__tokamakRenderComponentPart" : "__tokamakRenderPlainPart";
  const prefix = `${child ? "{" : ""}${hole === undefined ? "" : `__tokamakHole(${hole}, () => `}${entry}(${partArguments(part, target)}, (__tokamakContents) => `;
  const suffix = `)${hole === undefined ? "" : ")"}${child ? "}" : ""}`;
  output.appendLeft(
    node.getStart(source),
    prefix + (mount?.prefix ?? "") + (component ? "__tokamakComponent(" : ""),
  );
  const endMount = (component ? ")" : "") + (mount?.suffix ?? "");

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
