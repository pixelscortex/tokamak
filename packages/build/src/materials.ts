/** Plates (render/SURFACES.md, "Plates"): the build marks every JSX element
 * whose `class` uses a `material-*` utility as a static string with a
 * `tk-plate` attribute, so the render host registers it as a plate without
 * scanning class strings at run time, and rejects material names that
 * `@tokamak/ui`'s materials.css does not define.
 *
 * Static means written in the source: a string attribute, and the string
 * literals inside a `class={...}` expression: template literal text,
 * both branches of `?:`, operands of `+`, `&&`, `||`, `??`, and the keys of
 * a `classList={{...}}` object. A token next to a substitution
 * (`material-${name}`) and classes from calls, variables or spreads are
 * dynamic: they are not checked here, and the host's class scan finds them
 * at run time. Only intrinsic elements (`<div>`, `<button>`) are marked;
 * a component's `class` prop is checked but not marked (the component
 * decides where it lands; the run-time scan covers it).
 *
 * Runs before Solid compiles JSX, on .tsx sources only. */
import ts from "typescript";
import MagicString from "magic-string";
import type { Plugin } from "vite";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

/** Material names (without `material-`) defined by `@utility material-<name>`
 * rules in a stylesheet. */
export function materialNames(css: string): Set<string> {
  const names = new Set<string>();
  for (const match of css.matchAll(/@utility\s+material-([A-Za-z0-9_-]+)\s*\{/g)) {
    names.add(match[1]!);
  }
  return names;
}

/** A piece of a class string known at build time. `open*`: the piece
 * touches dynamic text on that side, so its token there is incomplete. */
interface Piece {
  text: string;
  /** Source position of `text[0]`. */
  start: number;
  openStart: boolean;
  openEnd: boolean;
}

function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

/** Static pieces of a class expression. `open` marks the sides of the whole
 * expression that touch dynamic text in an enclosing template or `+`. */
function pieces(node: ts.Expression, source: ts.SourceFile, open: [boolean, boolean], out: Piece[]) {
  node = unwrap(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.push({ text: node.text, start: node.getStart(source) + 1, openStart: open[0], openEnd: open[1] });
  } else if (ts.isTemplateExpression(node)) {
    const parts = [node.head, ...node.templateSpans.map((s) => s.literal)];
    parts.forEach((part, i) => {
      out.push({
        // After the opening backtick, or the `}` closing a substitution.
        text: part.text,
        start: part.getStart(source) + 1,
        openStart: i === 0 ? open[0] : true,
        openEnd: i === parts.length - 1 ? open[1] : true,
      });
    });
    // Substitutions are whole expressions of their own, usually a choice
    // between whole class lists (`${on ? "material-key" : ""}`).
    for (const span of node.templateSpans) pieces(span.expression, source, [true, true], out);
  } else if (ts.isConditionalExpression(node)) {
    pieces(node.whenTrue, source, open, out);
    pieces(node.whenFalse, source, open, out);
  } else if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) {
      pieces(node.left, source, [open[0], true], out);
      pieces(node.right, source, [true, open[1]], out);
    } else if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      pieces(node.right, source, open, out);
    } else if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      pieces(node.left, source, open, out);
      pieces(node.right, source, open, out);
    }
  }
}

/** Whole class tokens of the pieces, with their source positions. A token
 * cut by dynamic text is left out. */
function tokens(list: Piece[]): { token: string; pos: number }[] {
  const out: { token: string; pos: number }[] = [];
  for (const piece of list) {
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(piece.text))) {
      const atStart = m.index === 0 && piece.openStart;
      const atEnd = m.index + m[0].length === piece.text.length && piece.openEnd;
      if (!atStart && !atEnd) out.push({ token: m[0], pos: piece.start + m.index });
    }
  }
  return out;
}

/** The utility of a class token: the part after the last variant `:` that is
 * not inside brackets (`[&:hover]:x`), without the important `!`. */
function utility(token: string): string {
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === ":" && depth === 0) cut = i + 1;
  }
  return token.slice(cut).replace(/^!|!$/g, "");
}

/** Edit distance where swapping two neighbouring letters is one edit
 * (optimal string alignment), so `crad` is closest to `card`. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

/** The defined material closest to `name` (edit distance). */
export function closestMaterial(name: string, names: Iterable<string>): string | undefined {
  let best: string | undefined;
  let score = Infinity;
  for (const candidate of names) {
    const d = distance(name, candidate);
    if (d < score) [best, score] = [candidate, d];
  }
  return best;
}

/** Static class tokens of an attribute: `class` / `className` strings and
 * expressions, and `classList` object keys. */
function classTokens(attribute: ts.JsxAttribute, source: ts.SourceFile) {
  const name = attribute.name.getText(source);
  const init = attribute.initializer;
  if (!init) return [];
  const list: Piece[] = [];
  if (name === "class" || name === "className") {
    if (ts.isStringLiteral(init)) pieces(init, source, [false, false], list);
    else if (ts.isJsxExpression(init) && init.expression) pieces(init.expression, source, [false, false], list);
  } else if (name === "classList" && ts.isJsxExpression(init) && init.expression) {
    const object = unwrap(init.expression);
    if (ts.isObjectLiteralExpression(object)) {
      for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
        const key = property.name;
        if (ts.isStringLiteral(key)) pieces(key, source, [false, false], list);
        else if (ts.isIdentifier(key)) list.push({ text: key.text, start: key.getStart(source), openStart: false, openEnd: false });
      }
    }
  }
  return tokens(list);
}

/** Mark plates in one TSX module (see the header). Returns null when
 * nothing changes; throws on an unknown material name. `names` is null when
 * no materials stylesheet was found, which makes any material an error. */
export function markPlates(code: string, id: string, names: ReadonlySet<string> | null, sheet = "@tokamak/ui/materials.css") {
  if (!code.includes("material-")) return null;
  const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const output = new MagicString(code);
  let changed = false;
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      let plate = false;
      let marked = false;
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        if (attribute.name.getText(source) === "tk-plate") marked = true;
        for (const { token, pos } of classTokens(attribute, source)) {
          const util = utility(token);
          if (!util.startsWith("material-")) continue;
          const name = util.slice("material-".length);
          if (!names?.has(name)) {
            const { line, character } = source.getLineAndCharacterOfPosition(pos);
            const near = names ? closestMaterial(name, names) : undefined;
            const hint = near
              ? `; did you mean "material-${near}"?`
              : names
                ? `; ${sheet} defines no materials`
                : `; no materials stylesheet (${sheet}) was found`;
            throw new Error(`${id}:${line + 1}:${character + 1}: unknown material "material-${name}"${hint}`);
          }
          plate = true;
        }
      }
      // Intrinsic elements only (lowercase tag, or a custom element name).
      const tag = node.tagName;
      if (plate && !marked && ts.isIdentifier(tag) && /^[a-z]/.test(tag.text)) {
        output.appendLeft(tag.end, " tk-plate");
        changed = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!changed) return null;
  return { code: output.toString(), map: output.generateMap({ source: id, includeContent: true, hires: true }) };
}

/** The Vite plugin: reads the material names from `css` (default:
 * `@tokamak/ui/materials.css` resolved from the project root) and marks
 * plates in every .tsx module before Solid compiles it. */
export function materialPlates(options: { css?: string } = {}): Plugin {
  let names: Set<string> | null = null;
  let path: string | undefined;
  let root = process.cwd();
  return {
    name: "tokamak-material-plates",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
    },
    buildStart() {
      path = options.css;
      if (!path) {
        try {
          path = createRequire(resolve(root, "package.json")).resolve("@tokamak/ui/materials.css");
        } catch {
          path = undefined;
        }
      }
      names = path ? materialNames(readFileSync(path, "utf8")) : null;
      if (path) this.addWatchFile(path);
    },
    transform(code, id) {
      if (!/\.tsx(?:\?|$)/.test(id)) return;
      const file = id.replace(/\?.*$/, "");
      const shown = relative(root, file) || file;
      return markPlates(code, shown, names, path ? relative(root, path) : undefined) ?? undefined;
    },
  };
}
