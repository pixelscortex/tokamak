import { clientEntry } from "./descriptor.ts";
import type { UserConfig } from "vite";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { nativeConfig } from "./native.ts";

export function uiBuildConfig(root: string, options: { ui?: false; standalone?: boolean }): UserConfig {
  if (options.ui === false) {
    return {
      root,
      build: {
        target: "es2022",
        emptyOutDir: false,
        outDir: "dist",
        lib: {
          entry: resolve(root, ".tokamak-empty-ui.js"),
          name: "TokamakEmpty",
          formats: ["iife"],
          fileName: () => "ui.js",
        },
      },
    };
  }
  const renderer = createRequire(resolve(root, "package.json")).resolve("@tokamak/render");
  const { plugins: _plugins, ...native } = nativeConfig(resolve(dirname(renderer), ".."), {
    entry: clientEntry(root),
    outDir: resolve(root, "dist"),
    fileName: "ui.js",
  });
  if (options.standalone) return { ...native, root };
  return {
    ...native,
    root,
    build: {
      ...native.build,
      lib: { entry: clientEntry(root), formats: ["cjs"], fileName: () => "ui.js" },
      rollupOptions: {
        external: (id) => /^(solid-js(?:$|\/)|@tokamak\/|@plugins\/)/.test(id),
        output: { exports: "named", codeSplitting: false },
      },
    },
  };
}
