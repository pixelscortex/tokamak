import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
  testDir: "./browser",
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: "../.ci-results/playwright",
  reporter: [["list"], ["html", { outputFolder: ".ci-results/playwright-report", open: "never" }]],
  use: { baseURL: "http://127.0.0.1:1420", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chromium" } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: [
    {
      cwd: resolve(import.meta.dirname, ".."),
      command: "proto run bun -- e2e/serve.ts",
      url: `http://127.0.0.1:43123/plugins?token=${process.env.VITE_TOKAMAK_TOKEN}`,
      timeout: 30_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
      reuseExistingServer: false,
    },
    {
      cwd: resolve(import.meta.dirname, ".."),
      command: "proto run bun -- run --cwd app vite preview --host 127.0.0.1 --port 1420 --strictPort",
      url: "http://127.0.0.1:1420",
      reuseExistingServer: false,
    },
    {
      cwd: resolve(import.meta.dirname, ".."),
      command: "proto run bun -- run --cwd app vite preview --host 127.0.0.1 --port 1421 --strictPort",
      url: "http://127.0.0.1:1421",
      reuseExistingServer: false,
    },
  ],
});
