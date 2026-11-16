import { defineConfig } from "vite";
import { tokamak } from "@tokamak/build/vite";

export default defineConfig({
  plugins: [
    tokamak({
      plugin: {
        id: "chat",
        version: "0.3.0",
        consumes: ["chat.backend"],
        exports: "./api.ts",
      },
    }),
  ],
});
