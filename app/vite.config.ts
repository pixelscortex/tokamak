/** Tokamak's fixed internal native application conventions live in build. */
import { defineConfig } from "vite";
import { tokamak } from "@tokamak/build/vite";
import { definePlugin } from "@tokamak/sdk";

export default defineConfig({ plugins: [tokamak({ standalone: true,
  plugin: definePlugin({ id: "tokamak.app", version: "0.1.0" }),
})] });
