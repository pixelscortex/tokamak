import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { windowTestConfig } from "../../../packages/build/src/window-test-config";

const config = windowTestConfig(resolve(import.meta.dirname, ".."), "ai-profiles");
export default defineConfig({
  ...config,
  // ui-sdk's Switch reads its field context from a plain .js module; inline it so it
  // shares the browser build of solid-js with the rest of the window, not Node's server build.
  test: { ...config.test, server: { deps: { inline: [/@ui-sdk\//] } } },
});
