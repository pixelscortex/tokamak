import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: [
      {
        find: /^solid-js$/,
        replacement: resolve(dirname(require.resolve("solid-js/package.json")), "dist/solid.dev.js"),
      },
    ],
    dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"],
  },
  test: { environment: "jsdom", include: ["tests/web/*.test.tsx"] },
});
