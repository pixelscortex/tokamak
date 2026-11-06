/** Validate composed maps at real emitted tokens, not map encoding or filenames. */
import assert from "node:assert/strict";
import { SourceMap } from "node:module";
import { readFile } from "node:fs/promises";

export async function assertOriginalMapping(bundlePath: string, sourcePath: string, probes: [string, string][]) {
  const code = await readFile(bundlePath, "utf8");
  const raw = JSON.parse(await readFile(`${bundlePath}.map`, "utf8"));
  const original = await readFile(sourcePath, "utf8");
  const index = raw.sources.findIndex((p: string) => p.endsWith(sourcePath.split("/").pop()!));
  assert(index >= 0, `Missing original source ${sourcePath}`);
  assert.equal(raw.sourcesContent[index], original, "composed map must contain exact typed TSX, not transformed adapter calls");
  assert(raw.mappings.length > 0);
  const map = new SourceMap(raw);
  for (const [token, lineText] of probes) {
    const expected = original.split("\n").findIndex((line) => line.includes(lineText));
    assert(expected >= 0, `Missing probe line ${lineText}`);
    let matched = false;
    for (let pos = code.indexOf(token); pos >= 0; pos = code.indexOf(token, pos + token.length)) {
      const prefix = code.slice(0, pos).split("\n");
      const entry = map.findEntry(prefix.length - 1, prefix.at(-1)!.length);
      if ("originalSource" in entry && entry.originalSource === raw.sources[index] && entry.originalLine === expected) matched = true;
    }
    assert(matched, `${token} must map to ${sourcePath}:${expected + 1} through TSX transform AND bundle`);
  }
  assert(!/document\.|window\.|solid-js\/web|@vite\/client|solid-refresh|import\.meta\.hot/.test(code), "native output must not depend on DOM or HMR");
}
