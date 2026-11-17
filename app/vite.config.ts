import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import tailwind from "@tailwindcss/vite";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const solidRoot = dirname(require.resolve("solid-js/package.json"));
export default defineConfig(({ mode }) => ({
  plugins: [solid(), tailwind()],
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
  build: { target: "es2022" },
}));
