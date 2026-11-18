import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreInputTimes } from "./windows-cache-inputs.mjs";

test("unchanged inputs reuse timestamps; changed and new inputs remain fresh", () => {
  const root = mkdtempSync(join(tmpdir(), "windows-cache-inputs-"));
  try {
    const source = join(root, "source.rs");
    const first = Date.now() - 60_000;
    const next = first + 30_000;
    writeFileSync(source, "pub fn value() -> u32 { 1 }");
    expect(restoreInputTimes(root, ["source.rs"], first)).toBe(0);
    utimesSync(source, next / 1000, next / 1000);
    expect(restoreInputTimes(root, ["source.rs"], next)).toBe(1);
    expect(Math.abs(statSync(source).mtimeMs - first)).toBeLessThan(1);

    // Content changes must invalidate the cache even when their mtime matches.
    writeFileSync(source, "pub fn value() -> u32 { 2 }");
    utimesSync(source, first / 1000, first / 1000);
    writeFileSync(join(root, "new.rs"), "// new input");
    expect(restoreInputTimes(root, ["source.rs", "new.rs"], next)).toBe(0);
    for (const file of [source, join(root, "new.rs")]) {
      expect(Math.abs(statSync(file).mtimeMs - next)).toBeLessThan(1);
    }
    expect(readFileSync(source, "utf8")).toContain("{ 2 }");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
