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
  ["arbitrary-value.tsx", "no-arbitrary-values", "spacing 1 2 3 4 6 8 12 16"],
  ["off-scale.tsx", "no-unknown-classes", "Spacing steps are 1 2 3 4 6 8 12 16"],
  ["restyle.tsx", "no-restyle", "Use a size (md, lg)"],
  ["corner.tsx", "concentric-radius", "Use rounded-md (12 px) here"],
])("%s fails with %s and names the alternative", (fixture, rule, alternative) => {
  const { status, out } = lint(fixture);
  expect(status).not.toBe(0);
  expect(out).toContain(rule);
  expect(out).toContain(alternative);
});

test("a fixed-radius primitive gets the parent fix", () => {
  expect(lint("corner.tsx").out).toContain(
    "<Button> has a fixed 8 px radius, so give the parent rounded-md or give the parent p-2",
  );
});

test("the corrected file passes", () => {
  const { status, out } = lint("corrected.tsx");
  expect(out).not.toContain("error");
  expect(status).toBe(0);
});
