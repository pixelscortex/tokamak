/** Build-time Tailwind compilation. */
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export async function compileCss(path: string): Promise<string> {
  const compiler = await compile(await readFile(path, "utf8"), {
    base: dirname(path),
    from: path,
    onDependency() {},
    async customCssResolver(id, base) {
      const tailwind = id === "tailwindcss" || id.startsWith("tailwindcss/");
      if (!tailwind && id !== "@tokamak/ui/theme.css") return;
      const request = id === "tailwindcss" ? "tailwindcss/index.css" : id;
      try {
        return createRequire(join(base, "package.json")).resolve(request);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
      }
      return tailwind
        ? require.resolve(request)
        : fileURLToPath(new URL("../../ui/src/theme.css", import.meta.url));
    },
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
