// Production entry shared with the typed/spaced-checkout regression harness.
// TypeScript Vite configuration owns compilation; no custom transform remains.
import { build } from "vite";
import config from "../vite.config.ts";

await build({ ...config, configFile: false });
const bundle = await Bun.file(new URL("../dist/demo.js", import.meta.url)).text();
console.log(`Native universal/client bundle: ${new TextEncoder().encode(bundle).length} bytes`);
