/** Background colours as plate fills (render/SURFACES.md, "Plates").
 *
 * Every `background-color` declaration in the compiled stylesheet whose
 * value is a solid colour gets a `--tk-fill` twin with the same value and
 * importance, in the same rule (and the same `@media` / `@supports` block):
 *
 *   .bg-blue-600 { background-color: var(--color-blue-600); }
 *   becomes
 *   .bg-blue-600 { background-color: var(--color-blue-600); --tk-fill: var(--color-blue-600); }
 *
 * `--tk-fill` is a registered `<color>` (materials.css), so Stylo resolves
 * theme variables, `oklch()`, `color-mix()` (the `/50` opacity forms) and
 * hex alike, and the render host reads one computed colour. On an element
 * that is a plate inside a region, materials.css then sets the
 * `background-color` itself to transparent, so Blitz paints nothing under
 * the plate. Elsewhere (no region, not a plate) the twin is inert and Blitz
 * paints the background as before.
 *
 * Applied to the whole output, so every way of reaching `background-color`
 * is covered alike: `bg-*` utilities with any variant (`hover:`, `active:`,
 * `aria-pressed:`, `dark:`), `@apply`, `@utility` bodies (`material-*`)
 * and hand-written rules. Values that are not one solid colour of their own
 * are left alone (see `solidColour`). */

/** CSS-wide keywords and colours that are not a colour of the element's
 * own: `transparent` (nothing to draw), `currentcolor` (follows the text
 * colour; drawn by Blitz), `inherit` and the other CSS-wide keywords. */
const NOT_SOLID = /^(?:transparent|currentcolor|inherit|initial|unset|revert|revert-layer|none)$/i;

/** True if a `background-color` value is translated into a plate fill: a
 * solid colour, not a keyword above and not built from `currentcolor`
 * (`bg-current/50` mixes it). Variables are trusted to hold colours; one
 * that does not leaves `--tk-fill` at its initial value (transparent). */
export function solidColour(value: string): boolean {
  const v = value.trim().replace(/\s*!important$/i, "");
  return v !== "" && !NOT_SOLID.test(v) && !/currentcolor/i.test(v);
}

/** Add the `--tk-fill` twin of every solid `background-color` declaration
 * in `css` (see the header). Idempotent: a rule that already has the same
 * twin right after the declaration is not changed again. */
export function addFills(css: string): string {
  // Declarations are `name: value;` inside a block; colour values never
  // contain `;`, `{` or `}`. The lookbehind keeps `--x-background-color`
  // and other names ending in `background-color` out.
  return css.replace(
    /(?<![\w-])background-color\s*:\s*([^;{}]+?)\s*;(?![ \t]*--tk-fill)/g,
    (decl: string, value: string) => (solidColour(value) ? `${decl} --tk-fill: ${value};` : decl),
  );
}
