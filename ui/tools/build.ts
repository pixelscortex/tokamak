/** Package build uses Vite's Solid plugin, then compiles the shared theme CSS. */
import { build } from "vite";
import config from "../vite.config";
import { compileCss } from "./css";
import { fileURLToPath } from "node:url";
import { copyFile, writeFile } from "node:fs/promises";

await build({ ...config, configFile: false });
await copyFile(
  new URL("../src/theme.css", import.meta.url),
  new URL("../dist/theme.css", import.meta.url),
);
await writeFile(
  new URL("../dist/styles.css", import.meta.url),
  await compileCss(
    fileURLToPath(new URL("../src/styles.css", import.meta.url)),
  ),
);
