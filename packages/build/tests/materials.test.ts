import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { markPlates, materialNames, materialPlates } from "../src/materials";
import { tokamak } from "../src/vite";

// The real stylesheet: the names the build accepts are the ones ui defines.
const names = materialNames(readFileSync(fileURLToPath(new URL("../../ui/src/materials.css", import.meta.url)), "utf8"));
const mark = (code: string) => markPlates(code, "src/view.tsx", names)?.code ?? null;

test("material names come from the @utility material-* rules", () => {
  for (const name of ["key", "key-bright", "key-pressed", "tray", "card", "chip", "well"]) expect(names.has(name)).toBe(true);
  expect(names.has("bevel")).toBe(false);
  expect([...materialNames("@utility material-a { } @utility other { } @utility material-b-c {}")]).toEqual(["a", "b-c"]);
});

test("an element with a static material class is marked, once", () => {
  expect(mark('<div class="material-tray flex rounded-[10px]">x</div>'))
    .toBe('<div tk-plate class="material-tray flex rounded-[10px]">x</div>');
  expect(mark('<span class={"material-chip"} />')).toBe('<span tk-plate class={"material-chip"} />');
  expect(mark('<div tk-plate class="material-key" />')).toBeNull();
  // Nested elements are marked independently.
  expect(mark('<div class="material-tray"><button class="material-key">a</button><p class="m-0">b</p></div>'))
    .toBe('<div tk-plate class="material-tray"><button tk-plate class="material-key">a</button><p class="m-0">b</p></div>');
});

test("variants and important still name a material", () => {
  for (const cls of ["active:material-key-pressed", "aria-pressed:hover:material-key-pressed", "[&:hover]:material-chip", "!material-key", "material-key!"]) {
    expect(mark(`<button class="px-2 ${cls}" />`)).toBe(`<button tk-plate class="px-2 ${cls}" />`);
  }
  expect(mark('<div class="bevel-1 text-material-x" />')).toBeNull();
});

test("static strings inside expressions count: templates, both branches, operators, classList", () => {
  for (const expr of [
    "`flex ${gap} material-key`",
    "`flex hover:material-chip ${i() === 0 ? \"material-chip\" : \"\"}`",
    'on() ? "material-key-pressed" : "material-key"',
    'on() ? "" : "material-key"',
    '"material-key " + extra',
    'on() && "material-key"',
    '(props.class ?? "material-card") as string',
  ]) {
    expect(mark(`<div class={${expr}} />`)).toBe(`<div tk-plate class={${expr}} />`);
  }
  expect(mark('<div classList={{ "material-key": on(), flex: true }} />')).toBe('<div tk-plate classList={{ "material-key": on(), flex: true }} />');
});

test("fully dynamic classes and cut tokens are left to the run-time scan", () => {
  for (const code of [
    "<div class={cls()} />",
    "<div class={`material-${name}`} />",
    "<div class={`flex material-${name}`} />",
    '<div class={"material-" + name} />',
    "<div {...props} />",
    "<div class={styles.material} />",
  ]) {
    expect(mark(code)).toBeNull();
  }
});

test("components are checked but not marked", () => {
  expect(mark('<Sheet class="material-card rounded-lg" />')).toBeNull();
  expect(() => mark('<Sheet class="material-crad" />')).toThrow('unknown material "material-crad"; did you mean "material-card"?');
});

test("an unknown material fails the build with file, line, name and the closest name", () => {
  const code = 'export const A = () => (\n  <div>\n    <button class="px-2 active:material-key-presed">x</button>\n  </div>\n);\n';
  expect(() => markPlates(code, "src/caps.tsx", names)).toThrow(
    'src/caps.tsx:3:25: unknown material "material-key-presed"; did you mean "material-key-pressed"?',
  );
  expect(() => mark("<div class={on() ? \"material-tray\" : \"material-try\"} />")).toThrow('"material-try"; did you mean "material-tray"?');
  expect(() => markPlates('<div class="material-key" />', "a.tsx", null)).toThrow("a.tsx:1:13: unknown material \"material-key\"; no materials stylesheet");
});

test("the marker keeps a source map back to the original text", () => {
  const result = markPlates('<div class="material-key" />', "src/view.tsx", names)!;
  expect(result.map.sources).toEqual(["src/view.tsx"]);
  expect(result.map.mappings.length).toBeGreaterThan(0);
});

test("the tokamak plugin marks plates before Solid compiles TSX", () => {
  for (const options of [{ standalone: true }, {}]) {
    const list = (tokamak(options) as { name: string }[]).flat();
    const plates = list.findIndex((p) => p.name === "tokamak-material-plates");
    const solid = list.findIndex((p) => p.name === "solid");
    expect(plates).toBeGreaterThanOrEqual(0);
    expect(plates).toBeLessThan(solid);
  }
  expect((tokamak({ ui: false }) as { name: string }[]).flat().some((p) => p.name === "tokamak-material-plates")).toBe(false);
  expect(materialPlates().enforce).toBe("pre");
});
