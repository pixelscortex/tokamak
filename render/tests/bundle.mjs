// Test-only build: preserve fixture source maps and verify actual resolved Solid
// inputs so a passing SSR stub or a web renderer cannot masquerade as integration.
import { transformNativeTsx } from "../tools/transform.mjs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const inputs = new Set();

const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL("./fixtures/component.tsx", import.meta.url))],
  outdir: fileURLToPath(new URL("../dist/tests/", import.meta.url)),
  naming: "component.js",
  format: "iife",
  target: "browser",
  minify: true,
  conditions: ["browser"],
  sourcemap: "linked",
  plugins: [
    {
      name: "acceptance-universal",
      setup(build) {
        build.onLoad({ filter: /\/solid-js\/(?:dist|web\/dist)\/[^/]+\.js$/ }, async ({ path }) => {
          inputs.add(path);
          return {
            contents: await Bun.file(path).text(),
            loader: "js",
            resolveDir: path.slice(0, path.lastIndexOf("/")),
          };
        });
        build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
          const contents = await transformNativeTsx(await Bun.file(path).text(), path, {
            sourceMaps: "inline",
          });
          return { contents, loader: "ts", resolveDir: path.slice(0, path.lastIndexOf("/")) };
        });
      },
    },
  ],
});

assert(result.success, result.logs.map(String).join("\n"));
assert([...inputs].some((p) => p.endsWith("/solid-js/dist/solid.js")));
assert(![...inputs].some((p) => /\/(server|dev)\.js$|\/web\//.test(p)));

const bundle = await Bun.file(new URL("../dist/tests/component.js", import.meta.url)).text();

assert(!/document\.createElement|window\.|solid-js\/web/.test(bundle));

const map = await Bun.file(new URL("../dist/tests/component.js.map", import.meta.url)).json();

assert(map.mappings.length > 0);

const fixtureIndex = map.sources.findIndex((p) => p.endsWith("component.tsx"));

assert(fixtureIndex >= 0);

// Bun keeps the JSX transform map nested rather than composing it. Check both
// real stages; a .tsx filename on generated adapter calls is not original mapping.
const inline = map.sourcesContent[fixtureIndex].match(
  /sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,([A-Za-z0-9+/=]+)/,
);

assert(inline, "bundle map must retain the transform source-map stage");

const originalMap = JSON.parse(Buffer.from(inline[1], "base64").toString("utf8"));

assert(originalMap.mappings.length > 0);
assert(originalMap.sources.some((p) => p.endsWith("component.tsx")));
assert(
  originalMap.sourcesContent.includes(
    await Bun.file(new URL("./fixtures/component.tsx", import.meta.url)).text(),
  ),
  "transform map must retain exact original typed JSX, not generated adapter calls",
);
assert(map.sources.some((p) => p.endsWith("js/index.ts")));

console.log(
  `Acceptance universal/client bundle + verified two-stage original TSX source maps: ${Buffer.byteLength(bundle)} bytes`,
);
