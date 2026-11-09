import { defineConfig } from "vite";
import { tokamak } from "@tokamak/build/vite";
import { definePlugin } from "@tokamak/sdk";
export default defineConfig({ plugins: [tokamak({ standalone: true,
  backend: false,
  plugin: definePlugin({ id: "tokamak.lab", version: "0.1.0" }),
})] });
