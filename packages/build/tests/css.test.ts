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
      // Solid backgrounds carry their plate fill (fills.ts).
      "background-color: #137137; --tk-fill: #137137;"]) assert(css.includes(rule), rule);
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
