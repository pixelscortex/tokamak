// One version for everything we own: the `version` field of the root package.json.
//
//   proto run bun -- .ci/versions.ts check        fails when an owned version differs
//   proto run bun -- .ci/versions.ts set 0.2.0    writes the version everywhere, then the lockfiles
//
// The places are discovered, not listed: the root package.json, every Bun workspace
// package that declares a version, the `version` in the plugin.ts of every workspace
// package that has one (plugins/chat, plugins/acp), the Cargo workspace version and
// every member crate, and each member crate's tauri.conf.json. A package added later is
// covered as soon as it joins a workspace.
//
// Test fixture plugins (packages/*/tests/fixtures, app/tests/fixtures) are not workspace
// packages, so they are not covered. Their versions are test inputs: tests write the
// same `1.0.0` inline and bump a version on purpose to exercise grants and dependency
// ranges, so they must not follow the product version.
//
// A plugin's version is also the key of its capability grant (`<id>@<version>`,
// packages/server/src/plugins/grants.rs). A data folder holding a grant row for a key
// with other permissions makes the server refuse to start; see .ci/README.md "Versions".
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Place = {
  /** Path relative to the repository root. */
  file: string;
  /** The declared value; `undefined` when the file declares none. */
  version: string | undefined;
  /** Where the value sits, for messages: `version`, `[workspace.package] version`, ... */
  field: string;
  /**
   * A package.json or tauri.conf.json may have no version field: nothing reads one
   * there and it cannot drift. Cargo manifests must have one (Cargo would use 0.0.0).
   */
  optional: boolean;
};

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function expand(root: string, patterns: string[], marker: string): string[] {
  // Workspace and Cargo member lists both use directory globs such as "plugins/*".
  const directories = new Set<string>();
  for (const pattern of patterns) {
    for (const match of new Bun.Glob(`${pattern}/${marker}`).scanSync({ cwd: root, onlyFiles: true }))
      directories.add(match.slice(0, -marker.length - 1));
  }
  return [...directories].sort();
}

// The descriptor's own `version: "..."` line, indented once inside definePlugin({ ... }).
const descriptorVersion = /^( {2}version:\s*")([^"]*)(",?)$/m;

/** A TOML `version` value; `{ workspace = true }` counts as inherited. */
function tomlVersion(value: unknown): { value: string | undefined; inherited: boolean } {
  if (typeof value === "object" && (value as { workspace?: unknown })?.workspace === true)
    return { value: undefined, inherited: true };
  return { value: typeof value === "string" ? value : undefined, inherited: false };
}

function readToml(path: string): Record<string, any> {
  return Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, any>;
}

export function source(root: string): string {
  const version = readJson(join(root, "package.json")).version;
  if (typeof version !== "string" || !semver.test(version))
    throw new Error(`package.json: the root "version" field must be a semantic version, got ${version}`);
  return version;
}

export function places(root: string): Place[] {
  const found: Place[] = [{ file: "package.json", version: source(root), field: "version", optional: false }];
  const manifest = readJson(join(root, "package.json"));
  for (const directory of expand(root, manifest.workspaces ?? [], "package.json")) {
    const file = `${directory}/package.json`;
    const descriptor = `${directory}/plugin.ts`;
    const plugin = existsSync(join(root, descriptor));
    // A plugin's package.json version is the build's fallback (packages/build/src/vite.ts),
    // so a plugin may leave it out; when present it must match too.
    found.push({ file, version: readJson(join(root, file)).version, field: "version", optional: true });
    if (plugin) {
      const match = readFileSync(join(root, descriptor), "utf8").match(descriptorVersion);
      found.push({ file: descriptor, version: match?.[2], field: "plugin version", optional: false });
    }
  }

  const cargo = join(root, "Cargo.toml");
  if (!existsSync(cargo)) return found;
  const workspace = readToml(cargo).workspace ?? {};
  const shared = tomlVersion(workspace.package?.version).value;
  found.push({ file: "Cargo.toml", version: shared, field: "[workspace.package] version", optional: false });
  for (const directory of expand(root, workspace.members ?? [], "Cargo.toml")) {
    const file = `${directory}/Cargo.toml`;
    const own = tomlVersion(readToml(join(root, file)).package?.version);
    // `version.workspace = true` takes the workspace value checked above.
    if (!own.inherited) found.push({ file, version: own.value, field: "[package] version", optional: false });
    const tauri = `${directory}/tauri.conf.json`;
    if (existsSync(join(root, tauri))) {
      // Without a version field Tauri takes the crate's version, which is fine.
      found.push({
        file: tauri,
        version: readJson(join(root, tauri)).version,
        field: "version",
        optional: true,
      });
    }
  }
  return found;
}

/** Owned places whose version differs from the root package.json. */
export function drift(root: string): Place[] {
  const expected = source(root);
  return places(root).filter((place) =>
    place.version === undefined ? !place.optional : place.version !== expected,
  );
}

/** The check's verdict as printable lines; `ok` is false when any version drifted. */
export function report(root: string): { ok: boolean; lines: string[] } {
  const expected = source(root);
  const wrong = drift(root);
  if (wrong.length === 0) {
    const count = places(root).filter((place) => place.version !== undefined).length;
    return { ok: true, lines: [`All ${count} owned versions are ${expected}.`] };
  }
  return {
    ok: false,
    lines: [
      `Versions differ from the root package.json (${expected}):`,
      ...wrong.map((place) => `  ${place.file}: ${place.field} is ${place.version ?? "missing"}`),
      "Run `proto run bun -- run version:set <version>` to write one version everywhere.",
    ],
  };
}

function replaceJson(text: string, version: string): string {
  // Edit the one top-level line instead of re-serialising, so formatting stays as it is.
  const next = text.replace(/^( {2}"version":\s*")[^"]*(")/m, `$1${version}$2`);
  if (JSON.parse(next).version !== version) throw new Error("top-level version field not found");
  return next;
}

function replaceDescriptor(text: string, version: string): string {
  if (!descriptorVersion.test(text)) throw new Error("no `version` line in definePlugin");
  return text.replace(descriptorVersion, `$1${version}$3`);
}

function replaceToml(text: string, section: string, version: string): string {
  const lines = text.split("\n");
  let inside = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*\[/.test(line)) inside = line.trim() === `[${section}]`;
    else if (inside && /^version\s*=\s*"/.test(line)) {
      lines[index] = line.replace(/"[^"]*"/, `"${version}"`);
      return lines.join("\n");
    }
  }
  throw new Error(`no version line in [${section}]`);
}

/** Writes `version` to every owned place that declares one; returns the files it changed. */
export function set(root: string, version: string): string[] {
  if (!semver.test(version)) throw new Error(`Not a semantic version: ${version}`);
  const changed: string[] = [];
  // Collect every place before the first write: discovery reads the root version.
  for (const place of places(root)) {
    // A package without a version field stays without one.
    if (place.version === version || (place.version === undefined && place.optional)) continue;
    const path = join(root, place.file);
    const text = readFileSync(path, "utf8");
    const section = place.field.match(/^\[(.+)\]/)?.[1];
    const next = section
      ? replaceToml(text, section, version)
      : place.file.endsWith(".ts")
        ? replaceDescriptor(text, version)
        : replaceJson(text, version);
    if (next !== text) {
      writeFileSync(path, next);
      changed.push(place.file);
    }
  }
  return changed;
}

function run(root: string, command: string[]) {
  const result = spawnSync(command[0]!, command.slice(1), { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command.join(" ")} failed`);
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const [command, value] = process.argv.slice(2);
  if (command === "check") {
    const { ok, lines } = report(root);
    (ok ? console.log : console.error)(lines.join("\n"));
    if (!ok) process.exit(1);
  } else if (command === "set" && value) {
    const previous = source(root);
    const changed = set(root, value);
    if (changed.length === 0) {
      console.log(`Already ${value}; nothing changed.`);
    } else {
      for (const file of changed) console.log(`${file} -> ${value}`);
      // Lockfiles record our own package versions; let the tools rewrite those entries.
      run(root, [process.execPath, "install"]);
      run(root, ["cargo", "update", "--workspace", "--offline"]);
      // The server crate's version is also the host API version that plugins name in
      // `api` (default `tokamak@^0.1`, packages/server/src/plugins/manifest.rs).
      const series = (version: string) => version.split(".").slice(0, 2).join(".");
      if (series(previous) !== series(value))
        console.warn(
          `Note: the server now reports host API ${value}. Plugins whose \`api\` range excludes it ` +
            "(the default is tokamak@^0.1, packages/server/src/plugins/manifest.rs) will not load.",
        );
    }
  } else {
    console.error("Usage: .ci/versions.ts check | set <version>");
    process.exit(2);
  }
}
