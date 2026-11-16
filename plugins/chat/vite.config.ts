import { defineConfig } from "vite";
import { tokamak } from "@tokamak/build/vite";

export default defineConfig({
  plugins: [
    tokamak({
      ui: false,
      plugin: {
        id: "chat",
        version: "0.3.0",
        consumes: ["chat.tools", "chat.backend"],
        exports: "./api.ts",
        permissions: ["net:openrouter.ai", "env:OPENROUTER_API_KEY", "env:OPENROUTER_BASE_URL"],
      },
    }),
  ],
});
