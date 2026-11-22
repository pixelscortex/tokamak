import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";
export default defineConfig((environment) =>
  mergeConfig(viteConfig(environment), {
    test: {
      environment: "jsdom",
      setupFiles: ["./tests/setup.ts"],
      css: false,
      exclude: [...configDefaults.exclude, ".dev/**"],
    },
  }),
);
