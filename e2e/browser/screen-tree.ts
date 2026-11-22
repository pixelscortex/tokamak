import type { Page } from "@playwright/test";

/**
 * One drawn element of a screen, as the browser laid it out: its box in page
 * pixels, the computed styles that change how it looks, and its text or icon.
 * The screens spec writes these next to each screenshot so the Paper copy of
 * the app (e2e/paper-html.ts) can take its sizes, colours and type from the
 * running app instead of from a picture.
 */
export interface ScreenNode {
  readonly tag: string;
  /** A name for the Paper layer: the element's `part`, its label, or its slot. */
  readonly name?: string;
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly style: Readonly<Record<string, string>>;
  readonly text?: string;
  /** An icon: its viewBox and paths, painted in `style.color`. */
  readonly svg?: { readonly viewBox: string; readonly paths: readonly { d: string; rule?: string }[] };
  readonly children: readonly ScreenNode[];
}

/** Writes the page's drawn tree (from `body`) as JSON. */
export async function screenTree(page: Page): Promise<ScreenNode> {
  return page.evaluate(() => {
    const keep = [
      "display",
      "flex-direction",
      "flex-wrap",
      "align-items",
      "justify-content",
      "row-gap",
      "column-gap",
      "padding-top",
      "padding-right",
      "padding-bottom",
      "padding-left",
      "background-color",
      "background-image",
      "color",
      "font-family",
      "font-size",
      "font-weight",
      "line-height",
      "letter-spacing",
      "text-align",
      "white-space",
      "border-top-left-radius",
      "border-top-right-radius",
      "border-bottom-right-radius",
      "border-bottom-left-radius",
      "border-top",
      "border-right",
      "border-bottom",
      "border-left",
      "box-shadow",
      "opacity",
      "overflow",
      "text-overflow",
      "filter",
    ];
    const hidden = (element: Element, style: CSSStyleDeclaration) => {
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)
        return true;
      // Screen-reader text: a 1 px box clipped away.
      if (style.position === "absolute" && style.clip === "rect(0px, 0px, 0px, 0px)") return true;
      const rect = element.getBoundingClientRect();
      return rect.width === 0 && rect.height === 0 && element.children.length === 0;
    };
    const nameOf = (element: Element) =>
      element.getAttribute("part") ??
      element.getAttribute("data-part") ??
      element.getAttribute("aria-label") ??
      element.getAttribute("data-slot") ??
      undefined;
    const box = (rect: DOMRect) => ({
      x: Math.round(rect.x * 100) / 100,
      y: Math.round(rect.y * 100) / 100,
      w: Math.round(rect.width * 100) / 100,
      h: Math.round(rect.height * 100) / 100,
    });
    function walk(element: Element): unknown {
      const style = getComputedStyle(element);
      if (hidden(element, style)) return null;
      const picked: Record<string, string> = {};
      for (const key of keep) picked[key] = style.getPropertyValue(key);
      const node: Record<string, unknown> = {
        tag: element.localName,
        name: nameOf(element),
        box: box(element.getBoundingClientRect()),
        style: picked,
        children: [],
      };
      if (element.localName === "svg") {
        node.svg = {
          viewBox: element.getAttribute("viewBox") ?? "0 0 24 24",
          paths: [...element.querySelectorAll("path")].map((path) => ({
            d: path.getAttribute("d") ?? "",
            rule: path.getAttribute("fill-rule") ?? undefined,
          })),
        };
        return node;
      }
      // A field shows its value, or its placeholder in the placeholder's colour.
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
        const value = element.value;
        node.text = value || element.placeholder || "";
        if (!value) picked.color = getComputedStyle(element, "::placeholder").color;
        return node;
      }
      const children: unknown[] = [];
      for (const child of element.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent ?? "";
          if (!text.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(child);
          children.push({
            tag: "#text",
            box: box(range.getBoundingClientRect()),
            style: {},
            text: text.replace(/\s+/g, " "),
            children: [],
          });
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const walked = walk(child as Element);
          if (walked) children.push(walked);
        }
      }
      node.children = children;
      return node;
    }
    return walk(document.body) as never;
  });
}
