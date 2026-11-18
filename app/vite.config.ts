import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import tailwind from "@tailwindcss/vite";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { pluginModules, pluginFixtures } from "./src/plugins/vite.ts";

const require = createRequire(import.meta.url);
const solidRoot = dirname(require.resolve("solid-js/package.json"));
export default defineConfig(({ mode }) => ({
  plugins: [solid(), tailwind(), pluginModules(), pluginFixtures()],
  resolve: {
    alias: [
      {
        find: /^solid-js$/,
        replacement: resolve(solidRoot, `dist/${mode === "production" ? "solid.js" : "solid.dev.js"}`),
      },
    ],
    dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals", "@ui-sdk/core"],
  },
  optimizeDeps: { exclude: ["@ui-sdk/core"] },
  build: {
    target: "es2022",
    ...(process.env.TOKAMAK_PLUGIN_FIXTURES === "1"
      ? {
          rolldownOptions: {
            input: {
              app: resolve(import.meta.dirname, "index.html"),
              plugins: resolve(import.meta.dirname, "tests/fixtures/check.html"),
            },
          },
        }
      : {}),
  },
}));
