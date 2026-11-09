// Fails the build when a public export of @tokamak/sdk (or its Solid entry)
// has no <api-declaration> or <auto-type-table> on an SDK reference page.
// Signatures regenerate on every build; this keeps the list of them complete.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const sdk = join(root, "../packages/sdk");
const pages = join(root, "content/docs/api");

function exportsOf(source) {
  const names = new Set();
  // export { a, b as c } from "…" and export type { … } from "…"
  for (const [, list] of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const item of list.split(",")) {
      const name = item.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name.replace(/^type\s+/, ""));
    }
  }
  // export function / const / class / interface / type Name
  for (const [, name] of source.matchAll(
    /export\s+(?:async\s+)?(?:function|const|let|class|interface|type)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(name);
  }
  return names;
}

const exported = new Set([
  ...exportsOf(await readFile(join(sdk, "src/index.ts"), "utf8")),
  ...exportsOf(await readFile(join(sdk, "solid.ts"), "utf8")),
]);

const documented = new Set();
for (const file of await readdir(pages)) {
  if (!file.endsWith(".mdx")) continue;
  const text = await readFile(join(pages, file), "utf8");
  for (const [, name] of text.matchAll(/<(?:api-declaration|auto-type-table)\b[^>]*\bname="([^"]+)"/g)) {
    documented.add(name);
  }
}

const missing = [...exported].filter((name) => !documented.has(name)).sort();
if (missing.length > 0) {
  console.error(`SDK exports missing from wiki/content/docs/api: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`SDK reference covers all ${exported.size} exports.`);
