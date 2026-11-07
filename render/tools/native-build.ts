/** Shared Vite production configuration for QuickJS, never a browser entry.
 * The maintained Solid plugin owns TSX/Babel; Vite owns TS erasure and maps. */
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import { resolve } from "node:path";

export function nativeSolid(): Plugin {
  return solid({
    dev: false,
    hot: false,
    solid: { generate: "universal", moduleName: "@tokamak/render" },
  });
}

interface NativeBuildOptions {
  entry?: string;
  outDir?: string;
  fileName?: string;
  sourcemap?: boolean;
}

export function nativeConfig(root: string, options: NativeBuildOptions = {}) {
  return defineConfig({
    root,
    mode: "production",
    publicDir: false,
    plugins: [
      nativeSolid(),
      {
        name: "quickjs-runtime-guard",
        generateBundle(_options, bundle) {
          const inputs = [...this.getModuleIds()].filter((id) =>
            /\/solid-js\/(?:dist|web\/dist)\//.test(id),
          );
          if (
            !inputs.some((id) => id.endsWith("/solid-js/dist/solid.js")) ||
            inputs.some((id) => /\/(server|dev)\.js$|\/web\//.test(id))
          ) {
            throw new Error(
              `Expected Solid production client runtime: ${inputs.join(", ")}`,
            );
          }
          for (const output of Object.values(bundle)) {
            if (
              output.type === "chunk" &&
              /document\.createElement|window\.|solid-js\/web|@vite\/client|solid-refresh/.test(
                output.code,
              )
            ) {
              throw new Error("Browser/dev runtime leaked into native bundle");
            }
          }
        },
      },
    ],
    // A copied checkout must use its own host, including when UI is linked from
    // the workspace; otherwise two host trees silently split event ownership.
    resolve: {
      conditions: ["browser", "production"],
      alias: [
        {
          find: /^@tokamak\/render$/,
          replacement: resolve(root, "js/index.ts"),
        },
      ],
    },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      target: "es2022",
      minify: true,
      sourcemap: options.sourcemap ?? true,
      emptyOutDir: false,
      outDir: options.outDir ?? "dist",
      lib: {
        entry: options.entry ?? resolve(root, "demo/main.tsx"),
        name: "TokamakNative",
        formats: ["iife"],
        fileName: () => options.fileName ?? "demo.js",
      },
    },
  });
}
