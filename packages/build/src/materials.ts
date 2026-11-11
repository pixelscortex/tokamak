/** Plates (render/SURFACES.md, "Plates"): the build marks every JSX element
 * whose `class` makes it a plate, as a static string, with a `tk-plate`
 * attribute, so the render host registers it without scanning class strings
 * at run time; and it fails on plate classes Tailwind does not know.
 *
 * A class token makes its element a plate when the project's Tailwind
 * design system (its `src/styles.css`, else `@tokamak/ui/styles.css`)
 * compiles it to a solid `background-color` (see fills.ts: `bg-blue-600`,
 * `bg-[#3a2420]`, `bg-white/50`, `hover:bg-chip`, ...) or to a `--tk-fill`.
 * The `material-*` utilities do both. Tailwind decides, so every colour
 * form and variant it accepts is covered exactly, and `bg-cover`,
 * `bg-linear-to-r`, `bg-[url(...)]`, `bg-transparent`, `bg-current` and
 * `bg-inherit` are not plates (Blitz paints them as before).
 *
 * Checked, and fatal when Tailwind generates nothing for them: every
 * `material-*`, `bg-*` and `bevel-*` token, and `raised` / `recessed`, with
 * their variants (the message names the file, line and column, the token
 * and the closest known name). A `bg-[#...]` with a malformed hex colour
 * fails too.
 *
 * Static means written in the source: a string attribute, and the string
 * literals inside a `class={...}` expression: template literal text,
 * both branches of `?:`, operands of `+`, `&&`, `||`, `??`, and the keys of
 * a `classList={{...}}` object. A token next to a substitution
 * (`bg-${name}`) and classes from calls, variables or spreads are dynamic:
 * they are not checked here, and the host's class scan finds them at run
 * time. Only intrinsic elements (`<div>`, `<button>`) are marked; a
 * component's `class` prop is checked but not marked (the component decides
 * where it lands; the run-time scan covers it).
 *
 * Runs before Solid compiles JSX, on .tsx sources only. */
import ts from "typescript";
import MagicString from "magic-string";
import type { Plugin } from "vite";
import { __unstable__loadDesignSystem } from "@tailwindcss/node";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { solidColour } from "./fills.ts";

/** What the build asks Tailwind about class names. */
export interface ClassInfo {
  /** The CSS Tailwind generates for one class token (variants included),
   * or null when it generates nothing. */
  css(token: string): string | null;
  /** Every utility name Tailwind lists (for "did you mean" hints). */
  names: readonly string[];
  /** The stylesheet, as shown in messages. */
  sheet: string;
}

/** The Tailwind design system of `stylesheet` (its theme, utilities and
 * `@utility` rules, imports resolved from its directory). `shown` is the
 * name used in messages. */
export async function loadClasses(stylesheet: string, shown = stylesheet): Promise<ClassInfo> {
  const system = await __unstable__loadDesignSystem(readFileSync(stylesheet, "utf8"), { base: dirname(stylesheet) });
  const cache = new Map<string, string | null>();
  return {
    css(token) {
      let css = cache.get(token);
      if (css === undefined) cache.set(token, (css = system.candidatesToCss([token])[0] ?? null));
      return css;
    },
    names: system.getClassList().map(([name]) => name),
    sheet: shown,
  };
}

/** Prefixes of the class tokens the build checks (see the header). */
const CHECKED = /^(?:material-|bg-|bevel-|elevation-)|^(?:raised|recessed|pressed)$/;

/** True if the CSS of one token makes its element a plate. */
function isPlate(css: string): boolean {
  if (/--tk-fill\s*:/.test(css)) return true;
  for (const m of css.matchAll(/(?<![\w-])background-color\s*:\s*([^;{}]+?)\s*;/g)) {
    if (solidColour(m[1]!)) return true;
  }
  return false;
}

/** A malformed hex colour in the CSS of a token (`bg-[#zz]`), if any. */
function badHex(css: string): string | undefined {
  for (const m of css.matchAll(/(?<![\w-])background-color\s*:\s*(#[^\s;]*)/g)) {
    if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(m[1]!)) return m[1];
  }
  return undefined;
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

/** The name closest to `name` (edit distance). */
export function closest(name: string, names: Iterable<string>): string | undefined {
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

/** Why a checked token is wrong, or null if Tailwind knows it. */
function problem(token: string, classes: ClassInfo | null, sheet: string): string | null {
  const util = utility(token);
  const css = classes?.css(token) ?? null;
  if (css !== null) {
    const hex = badHex(css);
    return hex ? `invalid colour "${hex}" in "${token}"` : null;
  }
  if (!classes) {
    // No stylesheet: nothing can draw a material; other classes are inert.
    return util.startsWith("material-") ? `unknown material "${util}"; no materials stylesheet (${sheet}) was found` : null;
  }
  if (util !== token && classes.css(util) !== null) return `unknown variant in "${token}"`;
  if (util.startsWith("bevel-")) return `unknown bevel "${util}"; use bevel, bevel-<number>, bevel-[<number>], bevel-soft, bevel-sharp or bevel-tilt-<degrees>`;
  const prefix = util.startsWith("material-") ? "material-" : util.startsWith("bg-") ? "bg-" : "";
  const kind = prefix === "material-" ? "material" : prefix === "bg-" ? "background" : "class";
  const near = prefix ? closest(util, classes.names.filter((n) => n.startsWith(prefix))) : undefined;
  const hint = near ? `; did you mean "${near}"?` : prefix === "material-" ? `; ${classes.sheet} defines no materials` : "";
  return `unknown ${kind} "${util}"${hint}`;
}

/** Mark plates in one TSX module (see the header). Returns null when
 * nothing changes; throws on an unknown plate class. `classes` is null when
 * no stylesheet was found, which makes any material an error. */
export function markPlates(code: string, id: string, classes: ClassInfo | null, sheet = "@tokamak/ui/styles.css") {
  if (!/material-|bg-|bevel-|elevation-|raised|recessed|pressed/.test(code)) return null;
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
          if (!CHECKED.test(utility(token))) continue;
          const wrong = problem(token, classes, sheet);
          if (wrong) {
            const { line, character } = source.getLineAndCharacterOfPosition(pos);
            throw new Error(`${id}:${line + 1}:${character + 1}: ${wrong}`);
          }
          if (classes && isPlate(classes.css(token)!)) plate = true;
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

/** The stylesheet whose classes a project uses: `css`, else the project's
 * `src/styles.css` (the one the build compiles), else `@tokamak/ui/styles.css`
 * resolved from the project root; undefined if none exists. */
export function projectStylesheet(root: string, css?: string): string | undefined {
  if (css) return css;
  const own = resolve(root, "src/styles.css");
  if (existsSync(own)) return own;
  try {
    return createRequire(resolve(root, "package.json")).resolve("@tokamak/ui/styles.css");
  } catch {
    return undefined;
  }
}

/** The Vite plugin: loads the project's Tailwind design system (see
 * `projectStylesheet`) and marks plates in every .tsx module before Solid
 * compiles it. */
export function materialPlates(options: { css?: string } = {}): Plugin {
  let classes: ClassInfo | null = null;
  let path: string | undefined;
  let root = process.cwd();
  return {
    name: "tokamak-material-plates",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
    },
    async buildStart() {
      path = projectStylesheet(root, options.css);
      classes = path ? await loadClasses(path, relative(root, path) || path) : null;
      if (path) this.addWatchFile(path);
    },
    transform(code, id) {
      if (!/\.tsx(?:\?|$)/.test(id)) return;
      const file = id.replace(/\?.*$/, "");
      const shown = relative(root, file) || file;
      return markPlates(code, shown, classes) ?? undefined;
    },
  };
}
