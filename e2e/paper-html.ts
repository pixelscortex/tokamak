// Turns a drawn tree from the screens spec (browser/screen-tree.ts) into HTML
// for Paper's write_html, so the "App 1:1" pages copy the running app's boxes,
// colours and type exactly. Every element is placed absolutely inside its
// parent at the size the browser gave it.
//
//   proto run bun -- e2e/paper-html.ts <screen.json> [layer path] [--children]
//   PAPER_DROP="Branch ,Layout" … leaves out layers whose name starts with one of these.
//
// The layer path picks a subtree by layer names, e.g. "Page header" or
// "Chat/Conversation"; --children prints each child of it as its own block
// (one write_html call each), separated by a line holding "<!-- next -->";
// --page keeps the subtree at its place in the window.
import { readFileSync } from "node:fs";
import type { ScreenNode } from "./browser/screen-tree";

const [file, path = "", flag] = process.argv.slice(2);
if (!file) throw new Error("usage: paper-html.ts <screen.json> [layer path] [--children]");
const tree = JSON.parse(readFileSync(file, "utf8")) as ScreenNode;

/** CSS Color 4 values as Chromium computes them (lab, oklab, oklch, rgb), as short hex. */
function hex(value: string): string {
  return value.replace(/(lab|oklab|oklch|rgba?)\(([^)]*)\)/g, (whole, space: string, body: string) => {
    const [channels, alphaPart] = body.includes("/") ? body.split("/") : [body, undefined];
    const parts = channels!
      .trim()
      .split(/[\s,]+/)
      .map(Number.parseFloat);
    let alpha = alphaPart === undefined ? 1 : Number.parseFloat(alphaPart);
    if (alphaPart?.trim().endsWith("%")) alpha /= 100;
    let rgb: number[];
    if (space.startsWith("rgb")) {
      if (parts.length === 4) alpha = parts[3]!;
      rgb = parts.slice(0, 3).map((part) => part / 255);
    } else {
      const [l, first, second] = parts as [number, number, number];
      // oklch's chroma and hue become oklab's a and b.
      const [a, b] =
        space === "oklch"
          ? [first * Math.cos((second * Math.PI) / 180), first * Math.sin((second * Math.PI) / 180)]
          : [first, second];
      let x: number, y: number, z: number;
      if (space === "lab") {
        // CIE Lab (D50) to XYZ, then Bradford to D65.
        const fy = (l + 16) / 116,
          fx = fy + a / 500,
          fz = fy - b / 200;
        const f = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (116 * t - 16) / 903.3);
        const [x50, y50, z50] = [0.96422 * f(fx), l > 8 ? fy ** 3 : l / 903.3, 0.82521 * f(fz)];
        x = 0.9554734527042182 * x50 - 0.023098536874261423 * y50 + 0.0632593086610217 * z50;
        y = -0.028369706963208136 * x50 + 1.0099954580058226 * y50 + 0.021041398966943008 * z50;
        z = 0.012314001688319899 * x50 - 0.020507696433477912 * y50 + 1.3303659366080753 * z50;
      } else {
        const L = l > 1 ? l / 100 : l;
        const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
        const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
        const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
        x = 1.2270138511 * l_ - 0.5577999807 * m_ + 0.281256149 * s_;
        y = -0.0405801784 * l_ + 1.1122568696 * m_ - 0.0716766787 * s_;
        z = -0.0763812845 * l_ - 0.4214819784 * m_ + 1.5861632204 * s_;
      }
      const lin = [
        3.2409699419 * x - 1.5373831776 * y - 0.4986107603 * z,
        -0.9692436363 * x + 1.8759675015 * y + 0.0415550574 * z,
        0.0556300797 * x - 0.2039769589 * y + 1.0569715142 * z,
      ];
      rgb = lin.map((c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
    }
    if (rgb.some(Number.isNaN)) return whole;
    const byte = (c: number) =>
      Math.round(Math.min(1, Math.max(0, c)) * 255)
        .toString(16)
        .padStart(2, "0");
    return `#${rgb.map(byte).join("")}${alpha < 1 ? byte(alpha) : ""}`;
  });
}

const none = new Set([
  "",
  "none",
  "normal",
  "0px",
  "rgba(0, 0, 0, 0)",
  "0px none rgb(0, 0, 0)",
  "visible",
  "1",
]);

/** The styles that draw the element itself; layout is the absolute box. */
function look(style: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  const add = (key: string, value: string | undefined) => {
    if (value !== undefined && !none.has(value)) out.push(`${key}:${hex(value)}`);
  };
  if (hex(style["background-color"] ?? "") !== "#00000000")
    add("background-color", style["background-color"]);
  add("background-image", style["background-image"]);
  for (const side of ["top", "right", "bottom", "left"]) {
    const border = style[`border-${side}`];
    if (border && !border.startsWith("0px") && !/none/.test(border))
      out.push(`border-${side}:${hex(border)}`);
  }
  // A full pill comes back as a huge number of pixels.
  const radii = ["top-left", "top-right", "bottom-right", "bottom-left"].map((corner) => {
    const radius = style[`border-${corner}-radius`] ?? "0px";
    return Number.parseFloat(radius) > 9999 ? "9999px" : radius;
  });
  if (radii.some((radius) => radius !== "0px"))
    out.push(`border-radius:${radii.every((radius) => radius === radii[0]) ? radii[0] : radii.join(" ")}`);
  add("box-shadow", style["box-shadow"]);
  add("opacity", style.opacity);
  add("filter", style.filter);
  if (style.overflow === "hidden" || style.overflow === "clip") out.push("overflow:hidden");
  return out;
}

const family = (value: string | undefined) => (value?.includes("Mono") ? "Geist Mono" : "Geist");

function type(style: Readonly<Record<string, string>>): string[] {
  return [
    `font-family:'${family(style["font-family"])}'`,
    `font-size:${style["font-size"]}`,
    `font-weight:${style["font-weight"]}`,
    `line-height:${style["line-height"] === "normal" ? "normal" : style["line-height"]}`,
    `color:${hex(style.color ?? "")}`,
    ...(style["letter-spacing"] && style["letter-spacing"] !== "normal"
      ? [`letter-spacing:${style["letter-spacing"]}`]
      : []),
  ];
}

const px = (value: number) => `${Math.round(value * 2) / 2}px`;
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Layer names come from labels, and a folder's label holds its full path: keep only its name.
const attr = (text: string) =>
  escape(text.replace(/(^|\s)\/\S*\/(?=[^/\s]+$)/, "$1/example/")).replace(/"/g, "&quot;");

/** True when the element draws nothing and has no name: its children are placed in its parent. */
function invisible(node: ScreenNode): boolean {
  return (
    !node.name &&
    look(node.style).length === 0 &&
    !node.svg &&
    node.tag !== "textarea" &&
    node.tag !== "input"
  );
}

function render(node: ScreenNode, origin: { x: number; y: number }, inherited: ScreenNode): string {
  const at = `position:absolute;left:${px(node.box.x - origin.x)};top:${px(node.box.y - origin.y)}`;
  const size = `width:${px(node.box.w)};height:${px(node.box.h)}`;
  if (node.tag === "#text") {
    const lineHeight =
      Number.parseFloat(inherited.style["line-height"] ?? "") ||
      Number.parseFloat(inherited.style["font-size"] ?? "16") * 1.25;
    const wraps = node.box.h > lineHeight * 1.5;
    // The range's box is the glyphs' box; centre whole line boxes on it.
    const lines = Math.max(1, Math.round(node.box.h / lineHeight));
    const top = node.box.y - origin.y - (lines * lineHeight - node.box.h) / 2;
    const textAt = `position:absolute;left:${px(node.box.x - origin.x)};top:${px(top)}`;
    const style = [
      textAt,
      wraps ? `width:${px(node.box.w + 1)}` : "",
      `white-space:${wraps ? "pre-wrap" : "pre"}`,
      ...type(inherited.style),
    ];
    // A div per text: Paper merges sibling spans into one text node, which loses their places.
    return `<div style="${style.filter(Boolean).join(";")}">${escape(node.text ?? "")}</div>`;
  }
  if (node.svg) {
    const paths = node.svg.paths
      .map(
        (path) =>
          `<path d="${path.d}" fill="${hex(node.style.color ?? "")}"${path.rule ? ` fill-rule="${path.rule}"` : ""}/>`,
      )
      .join("");
    return `<svg layer-name="${attr(node.name ?? "icon")}" viewBox="${node.svg.viewBox}" style="${at};${size}">${paths}</svg>`;
  }
  if (node.tag === "textarea" || node.tag === "input") {
    const padLeft = Number.parseFloat(node.style["padding-left"] ?? "0");
    const lineHeight =
      Number.parseFloat(node.style["line-height"] ?? "") ||
      Number.parseFloat(node.style["font-size"] ?? "16") * 1.25;
    // A textarea starts its text at its top padding; an input centres its one line.
    const top =
      node.tag === "textarea"
        ? Number.parseFloat(node.style["padding-top"] ?? "0")
        : (node.box.h - lineHeight) / 2;
    const text = `<div style="position:absolute;left:${px(padLeft)};top:${px(top)};white-space:pre;${type(node.style).join(";")}">${escape(node.text ?? "")}</div>`;
    return `<div layer-name="${attr(node.name ?? node.tag)}" style="${[at, size, ...look(node.style)].join(";")}">${text}</div>`;
  }
  const inner = children(node, node.box, node);
  return `<div${node.name ? ` layer-name="${attr(node.name)}"` : ""} style="${[at, size, ...look(node.style)].join(";")}">${inner}</div>`;
}

/**
 * What only the test app draws: the fixture plugins' rail marks and the fake
 * agent's footer line. The Paper pages copy the app a person installs.
 */
const testOnly = new Set(["FixtureView", "PanelView", "ThrowingView", "WindowStateView", "OtherDraftView"]);
/** Layers to leave out, by name prefix (PAPER_DROP="Branch ,Layout"): one plugin's parts, say. */
const dropped = (process.env.PAPER_DROP ?? "").split(",").filter(Boolean);
const isTestOnly = (node: ScreenNode) =>
  testOnly.has(node.name ?? "") ||
  dropped.some((prefix) => node.name?.startsWith(prefix)) ||
  node.children.some((child) => child.text === "Replayed by the fake agent");

function children(node: ScreenNode, origin: { x: number; y: number }, styled: ScreenNode): string {
  return node.children
    .filter((child) => !isTestOnly(child))
    .map((child) =>
      child.tag !== "#text" && invisible(child)
        ? children(child, origin, child)
        : render(child, origin, child.tag === "#text" ? styled : child),
    )
    .join("");
}

function find(node: ScreenNode, names: string[]): ScreenNode | undefined {
  if (!names.length) return node;
  for (const child of node.children) {
    if (child.name === names[0]) {
      const found = find(child, names.slice(1));
      if (found) return found;
    }
    const deeper = find(child, names);
    if (deeper) return deeper;
  }
  return undefined;
}

const root = find(tree, path ? path.split("/") : []);
if (!root) throw new Error(`no layer at ${path}`);
if (flag === "--children") {
  const blocks = root.children.map((child) => render(child, root.box, child.tag === "#text" ? root : child));
  process.stdout.write(`${blocks.join("\n<!-- next -->\n")}\n`);
} else if (flag === "--page") {
  // In page coordinates, to drop straight into a full-window artboard.
  process.stdout.write(`${render(root, { x: 0, y: 0 }, root)}\n`);
} else process.stdout.write(`${render(root, { x: root.box.x, y: root.box.y }, root)}\n`);
