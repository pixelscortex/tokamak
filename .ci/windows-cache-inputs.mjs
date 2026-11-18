import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Cargo uses input mtimes for freshness. A fresh checkout otherwise rebuilds
// workspace crates even when a restored target directory has identical inputs.
export function restoreInputTimes(root, files, now = Date.now()) {
  const manifest = join(root, "target/release/.ci-inputs.json");
  const previous = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : {};
  const inputs = {};
  let restored = 0;
  for (const file of files) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile()) continue;
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    const match = previous[file]?.hash === hash;
    // Changed/new inputs must be newer than the restored outputs, even if a
    // parallel build saved that cache after this job checked out its sources.
    const mtime = match ? previous[file].mtime : now;
    utimesSync(path, stat.atime, mtime / 1000);
    inputs[file] = { hash, mtime };
    if (match) restored++;
  }
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, JSON.stringify(inputs));
  return restored;
}

if (import.meta.main) {
  const tracked = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  if (tracked.error) throw tracked.error;
  if (tracked.status !== 0) throw new Error("Cannot list tracked Windows build inputs");
  const files = tracked.stdout.split("\0").filter(Boolean);
  console.log(`Restored timestamps for ${restoreInputTimes(process.cwd(), files)} unchanged inputs`);
}
