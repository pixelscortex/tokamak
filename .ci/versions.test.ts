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
  // Plugin versions are their own; the check must not touch them.
  write(root, "plugins/chat/package.json", json({ name: "chat", version: "0.3.0" }));
  write(root, "plugins/chat/plugin.ts", 'export default { id: "chat", version: "0.3.0" };\n');
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
  expect(report(root)).toEqual({ ok: true, lines: ["All 5 owned versions are 0.1.0."] });
  expect(places(root).map((place) => place.file)).not.toContain("plugins/chat/package.json");
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

test("a package that arrives later is discovered and checked", () => {
  const root = fixture();
  write(root, "packages/cli/package.json", json({ name: "@tokamak/cli", version: "0.1.0" }));
  expect(drift(root)).toEqual([]);
  write(root, "packages/cli/package.json", json({ name: "@tokamak/cli", version: "1.0.0" }));
  expect(drift(root).map((place) => place.file)).toEqual(["packages/cli/package.json"]);
});

test("set fixes a drifted fixture and leaves plugin versions alone", () => {
  const root = fixture();
  write(root, "packages/sdk/package.json", json({ name: "@tokamak/sdk", version: "0.2.0" }));
  expect(set(root, "0.1.0")).toEqual(["packages/sdk/package.json"]);
  expect(drift(root)).toEqual([]);

  const changed = set(root, "0.4.0");
  expect(changed.sort()).toEqual(
    [
      "Cargo.toml",
      "app/package.json",
      "app/src-tauri/tauri.conf.json",
      "package.json",
      "packages/sdk/package.json",
    ].sort(),
  );
  expect(report(root).lines).toEqual(["All 5 owned versions are 0.4.0."]);
  // Only the version line moved; the dependency's `version` key and the plugin did not.
  expect(readFileSync(join(root, "Cargo.toml"), "utf8")).toContain('version = "0.4.0"\nedition = "2024"');
  expect(readFileSync(join(root, "packages/server/Cargo.toml"), "utf8")).toContain(
    'semver = { version = "1" }',
  );
  expect(JSON.parse(readFileSync(join(root, "plugins/chat/package.json"), "utf8")).version).toBe("0.3.0");
  expect(JSON.parse(readFileSync(join(root, "packages/bare/package.json"), "utf8")).version).toBeUndefined();
});

test("set with the current version changes nothing", () => {
  const root = fixture();
  const before = readFileSync(join(root, "package.json"), "utf8");
  expect(set(root, "0.1.0")).toEqual([]);
  expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
  expect(() => set(root, "next")).toThrow(/semantic version/);
});
