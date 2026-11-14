import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileCss } from "../src/css";

test("Tailwind extracts TSX utilities and honors shared sources/exclusions", async () => {
  await mkdir(fileURLToPath(new URL("../dist", import.meta.url)), { recursive: true });
  const scratch = await mkdtemp(fileURLToPath(new URL("../dist/css-test-", import.meta.url)));
  try {
    for (const name of ["src", "shared", "src/excluded", "dist"]) {
      await mkdir(resolve(scratch, name), { recursive: true });
    }
    const path = resolve(scratch, "src/styles.css");
    await writeFile(path, `
      @import "tailwindcss/theme.css";
      @import "tailwindcss/utilities";
      @source "../shared";
      @source not "./excluded";
      .applied { @apply flex; }
    `);
    await writeFile(resolve(scratch, "src/main.tsx"),
      '<div class="grid gap-4 w-[137px] min-[681px]:grid-cols-2 data-[active]:opacity-50 bg-[#137137]" />');
    await writeFile(resolve(scratch, "shared/input.tsx"), '<input class="rounded-[13px]" />');
    await writeFile(resolve(scratch, "src/excluded/demo.tsx"), '<div class="w-[999px]" />');
    await writeFile(resolve(scratch, "dist/ui.js"), '"w-[888px]"');
    const css = await compileCss(path);
    for (const rule of [".grid {", ".gap-4 {", "width: 137px", "width >= 681px",
      "[data-active]", "border-radius: 13px", ".applied {",
      "background-color: #137137;"]) assert(css.includes(rule), rule);
    assert(!css.includes("999px"));
    assert(!css.includes("888px"));
    assert.equal(await compileCss(path), css);
    await writeFile(resolve(scratch, "src/main.tsx"), '<div class="w-[138px]" />');
    const changed = await compileCss(path);
    assert(changed.includes("width: 138px") && !changed.includes("width: 137px"));
    await writeFile(path, '@import "tailwindcss/utilities" source(none); @source inline("flex");');
    const explicit = await compileCss(path);
    assert(explicit.includes(".flex {") && !explicit.includes("138px"));
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("surface colours and bevels compile without changing ordinary backgrounds", async () => {
  const scratch = await mkdtemp(fileURLToPath(new URL("../dist/surface-css-", import.meta.url)));
  try {
    const sheet = fileURLToPath(new URL("../../ui/src/styles.css", import.meta.url));
    const path = resolve(scratch, "styles.css");
    await writeFile(path, `@import "${sheet}"; @source inline("bg-blue-600 surface-panel surface-[#1b1b1b] surface-(--my-var) surface-white/10 bevel bevel-2 bevel-[0.75] bevel-inset bevel-quiet focus:ring-2 hover:bg-blue-500 active:bevel-1 aria-pressed:bevel-inset");`);
    const css = await compileCss(path);
    for (const rule of ["--tk-fill: var(--color-panel)", "--tk-fill: #1b1b1b", "--tk-fill: var(--my-var)",
      "--tk-bevel: 0.75", "--tk-bevel-inset: 1", "--tk-bevel-strength: 0.2", "--tw-inset-shadow:",
      "--tw-ring-shadow", "box-shadow: none !important", "--color-white) calc(10 * 1%)"]) assert(css.includes(rule), rule);
    const background = css.match(/\.bg-blue-600\s*\{([^}]+)\}/)?.[1];
    assert(background?.includes("background-color:"));
    assert(!background.includes("--tk-fill"));
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
