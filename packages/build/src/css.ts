/** Build-time Tailwind only: QuickJS receives CSS, never a compiler/scanner. */
import { compile } from "tailwindcss";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

export async function compileCss(path: string): Promise<string> {
  const compiler = await compile(await readFile(path, "utf8"), {
    base: dirname(path),
    async loadStylesheet(id, base) {
      const file = id.startsWith(".")
        ? resolve(base, id)
        : createRequire(resolve(base, "package.json")).resolve(id);
      return {
        path: file,
        base: dirname(file),
        content: await readFile(file, "utf8"),
      };
    },
  });
  // All POC rules use @apply. No homegrown source scanner or dynamic candidates.
  return compiler.build([]);
}
