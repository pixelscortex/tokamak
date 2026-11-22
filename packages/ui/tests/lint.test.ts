// @vitest-environment node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const root = resolve(process.cwd(), "../..");
const lint = (fixture: string) => {
  const run = spawnSync(
    "node_modules/.bin/oxlint",
    ["-c", "packages/ui/lint/oxlint.json", `packages/ui/lint/fixtures/${fixture}`],
    { cwd: root, encoding: "utf8" },
  );
  return { status: run.status, out: run.stdout + run.stderr };
};

test.each([
  ["raw-color.tsx", "no-raw-colors", "text-ink-2, text-ink-3"],
  ["arbitrary-value.tsx", "no-arbitrary-values", "spacing 1 2 3 4 5 6 8 10 12 16"],
  ["off-scale.tsx", "no-unknown-classes", "Spacing steps are 1 2 3 4 5 6 8 10 12 16"],
  ["restyle.tsx", "no-restyle", "Use a size (md, lg)"],
  ["corner.tsx", "concentric-radius", "Use rounded-md (12 px) here"],
  ["density.tsx", "density-inward", "Use density-dense or remove it here"],
])("%s fails with %s and names the alternative", (fixture, rule, alternative) => {
  const { status, out } = lint(fixture);
  expect(status).not.toBe(0);
  expect(out).toContain(rule);
  expect(out).toContain(alternative);
});

test("negative margin is denied on primitives even with a variant", () => {
  const { status, out } = lint("negative-margin-primitive.tsx");
  expect(status).not.toBe(0);
  expect(out.match(/shadcn\(no-restyle\)/g)).toHaveLength(2);
  expect(out).toContain('"-ms-3" uses a negative margin on <Button>');
  expect(out).toContain('"hover:-mb-2" uses a negative margin on <Button>');
});

test.each([
  ["negative-margin.tsx", "no-negative-margin", "gap on the parent", 2],
  ["raw-button.tsx", "no-raw-button", 'Row with as="button" for list rows', 2],
  ["text-style-in-button.tsx", "no-text-style-in-button", "owns its text size, weight and tone", 6],
] as const)("%s fails with %s and names the alternative", (fixture, rule, alternative, count) => {
  const { status, out } = lint(fixture);
  expect(status).not.toBe(0);
  expect(out.split(`tokamak(${rule})`)).toHaveLength(count + 1);
  expect(out).toContain(alternative);
});

test("a fixed-radius primitive gets the parent fix", () => {
  expect(lint("corner.tsx").out).toContain(
    "<Button> has a fixed 8 px radius, so give the parent rounded-md or give the parent p-2",
  );
});

test("a namespaced primitive's own radius is known", () => {
  expect(lint("corner.tsx").out).toContain(
    "<Menu.Content> has a fixed 12 px radius, so give the parent rounded-lg",
  );
});

test.each(["corrected.tsx", "fixed-control-sizes.tsx"])("%s passes", (fixture) => {
  const { status, out } = lint(fixture);
  expect(out).not.toMatch(/\b[1-9]\d* errors?\b/);
  expect(status).toBe(0);
});

test("the shapes the corner rule assumes are the primitives' own classes", async () => {
  const { primitiveShapes } = await import("../lint/plugin.js");
  const { buttonVariants, chipVariants, rowVariants } = await import("../src/index.ts");
  const { popupClass, itemClass } = await import("../src/menu.tsx");
  expect(primitiveShapes.Button[0]).toBe(8);
  expect(buttonVariants()).toContain("rounded-sm");
  expect(chipVariants()).toContain("rounded-sm");
  expect(rowVariants().root()).toContain("rounded-sm");
  expect(primitiveShapes["Menu.Content"]).toEqual([12, 4]);
  expect(popupClass.join(" ")).toContain("rounded-md");
  expect(popupClass.join(" ")).toContain("p-1");
  expect(primitiveShapes["Command.Item"]).toEqual([8, null]);
  expect(primitiveShapes["Menu.RadioItem"]).toEqual([8, null]);
  expect(itemClass.join(" ")).toContain("rounded-sm");
});
