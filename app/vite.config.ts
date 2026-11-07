/** Tokamak's fixed internal native application conventions live in build. */
import { defineConfig } from "vite";
import { tokamak } from "@tokamak/build/vite";

export default defineConfig({ plugins: [tokamak()] });
