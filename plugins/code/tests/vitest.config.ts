import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { clientSurface } from "../../../packages/build/src/client-surface";
import { windowTestConfig } from "../../../packages/build/src/window-test-config";

const code = resolve(import.meta.dirname, "..");
const chat = resolve(code, "../chat");

export default defineConfig(
  windowTestConfig(code, "code", { "plugin:chat/client": resolve(chat, "src/client/api.ts") }, [
    clientSurface(
      () => chat,
      () => "chat",
    ),
  ]),
);
