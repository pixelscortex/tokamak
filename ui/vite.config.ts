/** Build native ESM without duplicating the consumer's Solid or host runtime. */
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { nativeSolid } from "../render/tools/native-build";

const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root,
  publicDir: false,
  plugins: [nativeSolid()],
  build: {
    target: "es2022",
    sourcemap: true,
    lib: {
      entry: {
        index: `${root}/src/index.ts`,
        elements: `${root}/src/elements/index.ts`,
        components: `${root}/src/components/index.ts`,
      },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rolldownOptions: {
      external: [/^solid-js(?:\/|$)/, /^@tokamak\/render(?:\/|$)/],
    },
  },
});
