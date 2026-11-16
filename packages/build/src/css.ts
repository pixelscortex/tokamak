/** Build-time Tailwind only: QuickJS receives CSS, never a compiler/scanner. */
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function compileCss(path: string): Promise<string> {
  const compiler = await compile(await readFile(path, "utf8"), {
    base: dirname(path),
    from: path,
    onDependency() {},
  });
  const automatic =
    compiler.root === "none"
      ? []
      : [
          {
            ...(compiler.root ?? { base: dirname(path), pattern: "**/*" }),
            negated: false,
          },
        ];
  // The maintained scanner owns extraction, ignores and @source semantics.
  const scanner = new Scanner({ sources: [...automatic, ...compiler.sources] });
  return compiler.build(scanner.scan());
}
