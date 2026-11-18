import type { UserConfig } from "vite";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compileCss } from "./css.ts";
import { clientEntry } from "./descriptor.ts";

export const hostModule = (id: string) =>
  /^(solid-js(?:$|\/)|@solidjs\/web(?:$|\/)|@tokamak\/(?:sdk(?:$|\/)|ui(?:$|\/)|runtime\/router$)|@ui-sdk\/(?:solid|core)(?:$|\/)|@plugins\/)/.test(
    id,
  );

export function uiBuildConfig(root: string): UserConfig {
  return {
    root,
    build: {
      target: "es2022",
      emptyOutDir: false,
      outDir: "dist",
      sourcemap: true,
      lib: {
        entry: clientEntry(root),
        formats: ["es"],
        fileName: () => "ui.js",
        cssFileName: "styles",
      },
      rollupOptions: { external: hostModule, output: { codeSplitting: false } },
    },
  };
}

export function clientAssets(root: () => string): import("vite").Plugin {
  return {
    name: "tokamak-client-entry",
    enforce: "post",
    async load(id) {
      const css = resolve(dirname(clientEntry(root())), "styles.css");
      if (id === css) return compileCss(css);
    },
    transform(code, id) {
      const entry = clientEntry(root());
      const css = resolve(dirname(entry), "styles.css");
      if (id === entry && existsSync(css))
        return { code: `${code}\nimport ${JSON.stringify(css)};`, map: null };
    },
  };
}
