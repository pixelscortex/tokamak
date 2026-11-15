/** Package/build contracts complement, never replace, QuickJS+Blitz behavior. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);
test("native library preserves its public element and component exports", async () => {
  const elementsPath = new URL("elements.js", dist).href;
  const componentsPath = new URL("components.js", dist).href;
  assert.deepEqual(Object.keys(await import(elementsPath)).sort(), ["Button", "Icon", "Input"]);
  assert.deepEqual(Object.keys(await import(componentsPath)).sort(), [
    "Button", "Chip", "ChipMore", "Composer", "Kbd", "Select", "Shell", "Textarea",
    "dismissOutside", "place", "rail", "textareaLine", "topBar",
    "trackLayout",
  ]);
  let library = "";
  for (const file of await readdir(dist)) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(new URL(file, dist), "utf8");
    assert(!/document\.|window\.|solid-js\/web|@vite\/client|solid-refresh|import\.meta\.hot/.test(source));
    library += source;
  }
  // Vite may factor both entry points through a shared chunk. Assert the
  // library graph's externals, not an incidental entry-file layout.
  assert.match(library, /from ["']solid-js["']/);
  assert.match(library, /from ["']@tokamak\/render["']/);
});

test("Tailwind theme retains shared color, radius, spacing and font variables and targetable states", async () => {
  const theme = await readFile(new URL("theme.css", dist), "utf8");
  const css = await readFile(new URL("styles.css", dist), "utf8");
  assert.match(theme, /@theme\s+static/);
  for (const token of ["color-surface", "color-foreground", "color-accent", "color-focus", "color-invalid", "radius-control", "spacing", "font-sans"]) {
    assert(theme.includes(`--${token}:`), `${token} must be theme-owned`);
    assert(css.includes(`var(--${token}`), `${token} must reach compiled native styles`);
  }
  for (const selector of [".tk-button", ".tk-input", "[data-pressed]", "[data-disabled]", "[data-focused]", "[data-invalid]"]) assert(css.includes(selector), selector);
  assert(!/@apply|@import/.test(css), "QuickJS/Blitz must receive compiled CSS, not compiler directives");
});

test("the components' tokens are theme-owned", async () => {
  const theme = await readFile(new URL("theme.css", dist), "utf8");
  for (const token of ["color-line", "color-lift", "color-danger", "color-well", "color-chip", "font-data"]) {
    assert(theme.includes(`--${token}:`), `${token} must be theme-owned`);
  }
});
