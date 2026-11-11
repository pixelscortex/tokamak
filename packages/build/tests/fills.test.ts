import { test, expect } from "bun:test";
import { addFills, solidColour } from "../src/fills";

test("a solid background colour gets a --tk-fill twin, importance kept", () => {
  expect(addFills(".a { background-color: var(--color-blue-600); }"))
    .toBe(".a { background-color: var(--color-blue-600); --tk-fill: var(--color-blue-600); }");
  expect(addFills(".a{background-color:#3a2420 !important;}"))
    .toBe(".a{background-color:#3a2420 !important; --tk-fill: #3a2420 !important;}");
  // Opacity forms and their @supports fallbacks, each in its own block.
  const mixed = ".a { background-color: color-mix(in srgb, #fff 50%, transparent);\n"
    + "  @supports (color: color-mix(in lab, red, red)) {\n"
    + "    background-color: color-mix(in oklab, var(--color-white) 50%, transparent);\n  }\n}";
  const out = addFills(mixed);
  expect(out.match(/--tk-fill/g)?.length).toBe(2);
  expect(out).toContain("--tk-fill: color-mix(in oklab, var(--color-white) 50%, transparent);\n  }");
  expect(addFills(out)).toBe(out);
});

test("keywords, currentcolor and other properties are left alone", () => {
  for (const value of ["transparent", "currentcolor", "currentColor", "inherit", "initial", "unset", "revert",
    "color-mix(in oklab, currentcolor 50%, transparent)", "transparent !important"]) {
    expect(solidColour(value)).toBe(false);
    const css = `.a { background-color: ${value}; }`;
    expect(addFills(css)).toBe(css);
  }
  const other = ".a { --x-background-color: red; background-image: url(x.png); }";
  expect(addFills(other)).toBe(other);
});
