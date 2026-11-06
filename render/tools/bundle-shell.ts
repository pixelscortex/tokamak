/** Embed actual UI CSS in the native shell, separately from JS fixtures. */
import { compileCss } from "../../ui/tools/css";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const demo = new URL("../demo/", import.meta.url);
const css = await compileCss(fileURLToPath(new URL("styles.css", demo)));
const shell = await readFile(new URL("shell.html", demo), "utf8");
await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../dist/shell.html", import.meta.url),
  shell.replace(/<style>[\s\S]*?<\/style>/, `<style>${css}</style>`),
);
console.log(`Native themed CSS: ${Buffer.byteLength(css)} bytes`);
