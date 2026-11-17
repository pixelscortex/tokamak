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
      {
        find: "@tokamak/runtime/router",
        replacement: resolve(import.meta.dirname, "../../app/src/plugins/router.ts"),
      },
    ],
    dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals", "@ui-sdk/core"],
  },
  optimizeDeps: { exclude: ["@ui-sdk/core"] },
  test: {
    environment: "jsdom",
    setupFiles: ["../../packages/ui/tests/setup.ts"],
    css: false,
    testTimeout: 30000,
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
