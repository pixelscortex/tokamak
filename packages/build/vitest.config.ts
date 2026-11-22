import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { windowStateModule } from "../sdk/src/window-state-protocol.ts";
import { clientSurface } from "./src/client-surface.ts";

const fixture = resolve(import.meta.dirname, "tests/fixtures/window-plugin");
const require = createRequire(import.meta.url);
export default defineConfig({
  plugins: [
    clientSurface(
      () => fixture,
      () => "window-plugin",
    ),
    solid(),
  ],
  resolve: {
    alias: [
      { find: windowStateModule, replacement: resolve(fixture, "binding.ts") },
      {
        find: /^solid-js$/,
        replacement: resolve(dirname(require.resolve("solid-js/package.json")), "dist/solid.dev.js"),
      },
    ],
    dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"],
  },
  test: { environment: "jsdom", include: ["tests/window-state.test.tsx"] },
});
