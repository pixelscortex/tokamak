/** Static package conventions. Never import or evaluate an authored descriptor. */
import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";
export { readDescriptor } from "../../sdk/tools/plugin-descriptor.ts";

export function serverModule(root: string, module: string): string {
  return existsSync(resolve(root, "src/server")) ? basename(module) : module;
}
export function clientEntry(root: string): string {
  for (const entry of ["src/client/api.ts", "src/client/api.tsx", "src/client/main.tsx", "src/main.tsx"])
    if (existsSync(resolve(root, entry))) return resolve(root, entry);
  return resolve(root, existsSync(resolve(root, "src/client")) ? "src/client/main.tsx" : "src/main.tsx");
}
