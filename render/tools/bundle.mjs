// Build-only Babel supplies Solid's universal JSX transform; Bun bundles the
// client reactive implementation into plain JS for QuickJS, not a Bun runtime.
import { transformNativeTsx } from "./transform.mjs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });

const solidInputs = new Set();

const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../demo/main.tsx", import.meta.url))],
  outdir: fileURLToPath(new URL("../dist/", import.meta.url)),
  naming: "demo.js",
  target: "browser",
  format: "iife",
  minify: true,
  conditions: ["browser"],
  plugins: [
    {
      name: "native-solid",
      setup(build) {
        build.onLoad({ filter: /\/solid-js\/(?:dist|web\/dist)\/[^/]+\.js$/ }, async ({ path }) => {
          solidInputs.add(path);
          return { contents: await Bun.file(path).text(), loader: "js", resolveDir: dirname(path) };
        });
        build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
          const source = await Bun.file(path).text();
          const contents = await transformNativeTsx(source, path);
          return { contents, loader: "ts", resolveDir: dirname(path) };
        });
      },
    },
  ],
});

if (!result.success) throw new AggregateError(result.logs, "Native bundle failed");

// Check the actual resolver inputs, not just package.json's stated conditions:
// SSR signal stubs can bundle successfully but never update the native tree.
if (
  ![...solidInputs].some((path) => path.endsWith("/solid-js/dist/solid.js")) ||
  [...solidInputs].some((path) => /\/(server|dev)\.js$|\/web\//.test(path))
) {
  throw new Error(
    `Expected Solid's production client runtime, resolved: ${[...solidInputs].join(", ")}`,
  );
}

const bundle = await Bun.file(new URL("../dist/demo.js", import.meta.url)).text();

if (/document\.createElement|window\.|solid-js\/web/.test(bundle))
  throw new Error("Web DOM leaked into native bundle");

console.log(`Native universal/client bundle: ${new TextEncoder().encode(bundle).length} bytes`);
