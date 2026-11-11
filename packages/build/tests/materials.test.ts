import { test, expect } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadClasses, markPlates, materialPlates, projectStylesheet } from "../src/materials";
import { tokamak } from "../src/vite";

// The real stylesheet: the classes the build accepts are the ones ui's
// Tailwind design system generates (theme, utilities, materials.css).
const sheet = fileURLToPath(new URL("../../ui/src/styles.css", import.meta.url));
const classes = await loadClasses(sheet, "ui/src/styles.css");
const mark = (code: string) => markPlates(code, "src/view.tsx", classes)?.code ?? null;

test("the materials are utilities of the design system", () => {
  for (const name of ["key", "key-bright", "key-pressed", "tray", "card", "chip", "well"]) {
    expect(classes.css(`material-${name}`)).toMatch(/background-color: var\(--color-[a-z]+\)/);
  }
  expect(classes.css("material-crad")).toBeNull();
  // A material is a shortcut: a background colour, a bevel and an elevation.
  expect(classes.css("material-key")).toMatch(/background-color: var\(--color-chip\);[^}]*--tk-bevel: 1\.5;[^}]*--tk-elevation: raised/s);
});

test("solid background colours make an element a plate, with any variant", () => {
  for (const cls of [
    "bg-blue-600", "bg-[#3a2420]", "bg-white/50", "bg-chip/[0.3]", "bg-[rgb(1,2,3)]", "bg-(--my-colour)",
    "hover:bg-chip", "active:bg-sky-300", "aria-pressed:bg-ink", "dark:bg-black", "group-hover:bg-red-500",
  ]) {
    expect(mark(`<button class="px-2 ${cls}" />`)).toBe(`<button tk-plate class="px-2 ${cls}" />`);
  }
  // `bevel-*` and the elevations are checked, and only add to a fill.
  expect(mark('<div class="bg-blue-600 bevel-2 recessed rounded-md" />')).toBe('<div tk-plate class="bg-blue-600 bevel-2 recessed rounded-md" />');
  expect(mark('<div class="bevel-2 bevel-[2.5] raised" />')).toBeNull();
});

test("backgrounds that are not one solid colour are not plates", () => {
  for (const cls of [
    "bg-transparent", "bg-current", "bg-current/50", "bg-inherit", "bg-none", "bg-cover",
    "bg-linear-to-r from-red-500", "bg-[url(x.png)]", "bg-center bg-no-repeat",
  ]) {
    expect(mark(`<div class="${cls}" />`)).toBeNull();
  }
});

test("an unknown background, bevel or variant fails the build", () => {
  expect(() => mark('<div class="p-2 bg-blu-600" />')).toThrow('src/view.tsx:1:17: unknown background "bg-blu-600"; did you mean "bg-blue-600"?');
  expect(() => mark('<div class="bg-chp" />')).toThrow('did you mean "bg-chip"?');
  expect(() => mark('<div class="hovr:bg-chip" />')).toThrow('unknown variant in "hovr:bg-chip"');
  expect(() => mark('<div class="bevel-x" />')).toThrow('unknown bevel "bevel-x"');
  expect(() => mark('<div class="bg-[#zz]" />')).toThrow('invalid colour "#zz" in "bg-[#zz]"');
  expect(() => mark('<div class="bg-[#12345]" />')).toThrow('invalid colour');
  // A component's class prop is checked too.
  expect(() => mark('<Card class="bg-blu-600" />')).toThrow("unknown background");
});

test("the project's own stylesheet comes first", () => {
  const lab = fileURLToPath(new URL("../../../lab", import.meta.url));
  expect(projectStylesheet(lab)).toBe(`${lab}/src/styles.css`);
  expect(projectStylesheet(lab, "/x.css")).toBe("/x.css");
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
    "<div class={`bg-${tone}`} />",
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
  expect(() => markPlates(code, "src/caps.tsx", classes)).toThrow(
    'src/caps.tsx:3:25: unknown material "material-key-presed"; did you mean "material-key-pressed"?',
  );
  expect(() => mark("<div class={on() ? \"material-tray\" : \"material-try\"} />")).toThrow('"material-try"; did you mean "material-tray"?');
  expect(() => markPlates('<div class="material-key" />', "a.tsx", null)).toThrow("a.tsx:1:13: unknown material \"material-key\"; no materials stylesheet");
  // Without a stylesheet nothing paints at all; backgrounds are not errors.
  expect(markPlates('<div class="bg-chip" />', "a.tsx", null)).toBeNull();
});

test("the marker keeps a source map back to the original text", () => {
  const result = markPlates('<div class="material-key" />', "src/view.tsx", classes)!;
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
