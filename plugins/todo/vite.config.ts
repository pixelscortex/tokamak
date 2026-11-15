import { defineConfig } from "vite";
import { tokamak } from "@tokamak/build/vite";
export default defineConfig({ plugins: [tokamak({ plugin: { id: "todo", version: "0.2.0", provides: ["chat.tools"], exports: "./api.ts" } })] });
