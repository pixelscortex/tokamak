import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { drift, places, report, set } from "./versions";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, file: string, text: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

const json = (value: object) => `${JSON.stringify(value, null, 2)}\n`;

const descriptor = (id: string, version: string) =>
  `import { definePlugin } from "@tokamak/sdk";\nexport default definePlugin({\n  id: "${id}",\n  version: "${version}",\n  depends: { other: "^1.0.0" },\n});\n`;

/** A small copy of the repository layout: Bun workspaces, a plugin, Cargo members and Tauri. */
function fixture(version = "0.1.0") {
  const root = mkdtempSync(join(tmpdir(), "versions-"));
  roots.push(root);
  write(
    root,
    "package.json",
    json({ name: "tokamak", version, workspaces: ["app", "packages/*", "plugins/*"] }),
  );
  write(root, "app/package.json", json({ name: "@tokamak/app", version, private: true }));
  write(root, "packages/sdk/package.json", json({ name: "@tokamak/sdk", version, private: true }));
  write(root, "packages/bare/package.json", json({ name: "@tokamak/bare", private: true }));
  // Plugins in this repo follow the version; a nested dependency range is not a version.
  write(root, "plugins/chat/package.json", json({ name: "chat", version }));
  write(root, "plugins/chat/plugin.ts", descriptor("chat", version));
  // A test fixture plugin is not a workspace package; its version is a test input.
  write(
    root,
    "packages/server/tests/fixtures/record/package.json",
    json({ name: "record", version: "1.0.0" }),
  );
  write(root, "packages/server/tests/fixtures/record/plugin.ts", descriptor("record", "1.0.0"));
  write(
    root,
    "Cargo.toml",
    `[workspace]\nmembers = ["packages/server", "app/src-tauri"]\n\n[workspace.package]\nversion = "${version}"\nedition = "2024"\n`,
  );
  write(
    root,
    "packages/server/Cargo.toml",
    '[package]\nname = "server"\nversion.workspace = true\n\n[dependencies]\nsemver = { version = "1" }\n',
  );
  write(root, "app/src-tauri/Cargo.toml", '[package]\nname = "tokamak-app"\nversion.workspace = true\n');
  write(root, "app/src-tauri/tauri.conf.json", json({ productName: "Tokamak", version }));
  return root;
}

test("a repository with one version passes", () => {
  const root = fixture();
  expect(drift(root)).toEqual([]);
  expect(report(root)).toEqual({ ok: true, lines: ["All 7 owned versions are 0.1.0."] });
  const files = places(root).map((place) => place.file);
  expect(files).toContain("plugins/chat/plugin.ts");
  expect(files.filter((file) => file.includes("fixtures"))).toEqual([]);
});

test("a drifted package fails with its file and value named", () => {
  const root = fixture();
  write(root, "packages/sdk/package.json", json({ name: "@tokamak/sdk", version: "0.2.0" }));
  write(root, "app/src-tauri/Cargo.toml", '[package]\nname = "tokamak-app"\nversion = "0.0.9"\n');
  const { ok, lines } = report(root);
  expect(ok).toBe(false);
  expect(lines).toContain("  packages/sdk/package.json: version is 0.2.0");
  expect(lines).toContain("  app/src-tauri/Cargo.toml: [package] version is 0.0.9");
  expect(lines).toHaveLength(4);
});

test("a drifted plugin fails for its package.json and its plugin.ts", () => {
  const root = fixture();
  write(root, "plugins/chat/package.json", json({ name: "chat", version: "0.3.0" }));
  write(root, "plugins/chat/plugin.ts", descriptor("chat", "0.3.0"));
  expect(report(root).lines).toEqual([
    "Versions differ from the root package.json (0.1.0):",
    "  plugins/chat/package.json: version is 0.3.0",
    "  plugins/chat/plugin.ts: plugin version is 0.3.0",
    "Run `proto run bun -- run version:set <version>` to write one version everywhere.",
  ]);
  write(root, "plugins/chat/plugin.ts", 'export default definePlugin({ id: "chat" });\n');
  expect(report(root).lines).toContain("  plugins/chat/plugin.ts: plugin version is missing");
});

test("a package that arrives later is discovered and checked", () => {
  const root = fixture();
  write(root, "packages/cli/package.json", json({ name: "@tokamak/cli", version: "0.1.0" }));
  expect(drift(root)).toEqual([]);
  write(root, "packages/cli/package.json", json({ name: "@tokamak/cli", version: "1.0.0" }));
  expect(drift(root).map((place) => place.file)).toEqual(["packages/cli/package.json"]);
});

test("set fixes a drifted fixture, plugins included, and leaves fixture plugins alone", () => {
  const root = fixture();
  write(root, "packages/sdk/package.json", json({ name: "@tokamak/sdk", version: "0.2.0" }));
  write(root, "plugins/chat/plugin.ts", descriptor("chat", "0.3.0"));
  expect(set(root, "0.1.0")).toEqual(["packages/sdk/package.json", "plugins/chat/plugin.ts"]);
  expect(drift(root)).toEqual([]);

  const changed = set(root, "0.4.0");
  expect(changed.sort()).toEqual(
    [
      "Cargo.toml",
      "app/package.json",
      "app/src-tauri/tauri.conf.json",
      "package.json",
      "packages/sdk/package.json",
      "plugins/chat/package.json",
      "plugins/chat/plugin.ts",
    ].sort(),
  );
  expect(report(root).lines).toEqual(["All 7 owned versions are 0.4.0."]);
  // Only version lines moved: not a dependency's `version` key, not a `depends` range.
  expect(readFileSync(join(root, "Cargo.toml"), "utf8")).toContain('version = "0.4.0"\nedition = "2024"');
  expect(readFileSync(join(root, "packages/server/Cargo.toml"), "utf8")).toContain(
    'semver = { version = "1" }',
  );
  expect(readFileSync(join(root, "plugins/chat/plugin.ts"), "utf8")).toBe(descriptor("chat", "0.4.0"));
  expect(readFileSync(join(root, "plugins/chat/plugin.ts"), "utf8")).toContain('other: "^1.0.0"');
  expect(readFileSync(join(root, "packages/server/tests/fixtures/record/plugin.ts"), "utf8")).toBe(
    descriptor("record", "1.0.0"),
  );
  expect(JSON.parse(readFileSync(join(root, "packages/bare/package.json"), "utf8")).version).toBeUndefined();
});

test("set with the current version changes nothing", () => {
  const root = fixture();
  const before = readFileSync(join(root, "package.json"), "utf8");
  expect(set(root, "0.1.0")).toEqual([]);
  expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
  expect(() => set(root, "next")).toThrow(/semantic version/);
});
