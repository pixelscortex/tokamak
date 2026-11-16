import { defineConfig } from "vite";
import { tokamak } from "@tokamak/build/vite";
export default defineConfig({
  plugins: [
    tokamak({
      ui: false,
      plugin: {
        id: "acp",
        version: "0.1.0",
        depends: { chat: "*" },
        provides: ["chat.backend"],
        exports: "./api.ts",
        permissions: ["acp"],
      },
    }),
  ],
});
