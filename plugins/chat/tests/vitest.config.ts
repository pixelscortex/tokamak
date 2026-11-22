import { windowTestConfig } from "../../../packages/build/src/window-test-config";
import { defineConfig } from "vitest/config";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const chat = resolve(import.meta.dirname, "..");
const probeModule = "\0chat-probe";

/**
 * Builds the test plugin in tests/fixtures/chat-probe with the real plugin
 * build. The build finds `plugin:chat/client` beside the plugin, so the copy
 * sits next to a link to this chat folder. The copy lives in the workspace's
 * ignored target folder, outside chat, so nothing that copies chat picks it up.
 */
function buildProbe() {
  const root = resolve(chat, "../../target/chat-probe");
  const probe = join(root, "chat-probe");
  mkdirSync(root, { recursive: true });
  cpSync(join(chat, "tests/fixtures/chat-probe"), probe, { recursive: true, force: true });
  if (!existsSync(join(root, "chat"))) symlinkSync(chat, join(root, "chat"), "dir");
  if (!existsSync(join(probe, "node_modules")))
    symlinkSync(join(chat, "node_modules"), join(probe, "node_modules"), "dir");
  writeFileSync(
    join(probe, "tsconfig.json"),
    JSON.stringify({ extends: join(chat, "src/client/tsconfig.json"), include: ["src"] }),
  );
  execFileSync("proto", ["run", "bun", "--", resolve(chat, "../../packages/build/src/build.ts"), probe]);
  return probe;
}

export default defineConfig(
  windowTestConfig(
    chat,
    "chat",
    {
      "@tokamak/runtime/router": resolve(chat, "../../packages/runtime/js/router.ts"),
      "@plugins/chat/ui": resolve(chat, "src/client/api.ts"),
    },
    [
      {
        name: "chat-probe",
        resolveId: (id) => (id === "virtual:chat-probe" ? probeModule : undefined),
        load(id) {
          if (id !== probeModule) return;
          const probe = buildProbe();
          return `
          export { default as manifest } from ${JSON.stringify(join(probe, "dist/manifest.json"))};
          export const loadActions = () => import(${JSON.stringify(join(probe, "dist/ui.js"))});
        `;
        },
      },
    ],
  ),
);
