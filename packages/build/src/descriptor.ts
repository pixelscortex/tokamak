/** Static package conventions. Never import or evaluate an authored descriptor. */
import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";
export { clientEntry } from "../../sdk/tools/plugin-boundary.mjs";
export { readDescriptor } from "../../sdk/tools/plugin-descriptor.ts";

export function serverModule(root: string, module: string): string {
  return existsSync(resolve(root, "src/server")) ? basename(module) : module;
}
