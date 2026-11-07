/** Bun owns app preparation; existing SDK/Vite/theme tools own their formats.
 * Underscore directories keep frontend and tooling out of function discovery. */
import { bundleFeature } from "../../packages/sdk/tools/bundle.mjs";
import { compileCss } from "../../packages/ui/tools/css.ts";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const app = fileURLToPath(new URL("../", import.meta.url));
await bundleFeature(app);
await build({ configFile: `${app}_tools/vite.config.ts` });
const css = await compileCss(`${app}_view/styles.css`);
const shell = await readFile(`${app}_view/shell.html`, "utf8");
await writeFile(
  `${app}dist/shell.html`,
  shell.replace("<style></style>", `<style>${css}</style>`),
);
