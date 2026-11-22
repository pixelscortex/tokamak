import solid from "@solidjs/vite-plugin";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { AliasOptions, PluginOption } from "vite";
import { clientSurface } from "./client-surface";
import { windowStateModule } from "../../sdk/src/window-state-protocol";

export function windowTestConfig(
  root: string,
  id: string,
  alias: AliasOptions = [],
  plugins: PluginOption[] = [],
) {
  const require = createRequire(resolve(root, "package.json"));
  const extras = Array.isArray(alias)
    ? alias
    : Object.entries(alias).map(([find, replacement]) => ({ find, replacement }));
  return {
    root,
    plugins: [
      ...plugins,
      clientSurface(
        () => root,
        () => id,
      ),
      solid({ refresh: false }),
    ],
    resolve: {
      alias: [
        {
          find: /^solid-js$/,
          replacement: resolve(dirname(require.resolve("solid-js/package.json")), "dist/solid.dev.js"),
        },
        { find: windowStateModule, replacement: resolve(root, "tests/window-state.ts") },
        ...extras,
      ],
      dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals", "@ui-sdk/core"],
    },
    optimizeDeps: { exclude: ["@ui-sdk/core"] },
    test: {
      environment: "jsdom",
      setupFiles: [resolve(root, "../../packages/ui/tests/setup.ts")],
      css: false,
      testTimeout: 60000,
      include: ["tests/**/*.test.{ts,tsx}"],
    },
  };
}
