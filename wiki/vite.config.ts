import { sourceContent } from "./scripts/sync-content.mjs";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import press from "fumapress/vite";
import { fumadocsMdx } from "fumadocs-mdx/vite";

export default defineConfig({
  plugins: [sourceContent(), press({ components: "./src/components/mdx.tsx" }), fumadocsMdx(), tailwindcss()],
});
