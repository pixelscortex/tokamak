import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function clientEntry(root) {
  for (const entry of ["src/client/api.ts", "src/client/api.tsx", "src/client/main.tsx", "src/main.tsx"]) {
    const file = resolve(root, entry);
    if (existsSync(file)) return file;
  }
  return resolve(root, existsSync(resolve(root, "src/client")) ? "src/client/main.tsx" : "src/main.tsx");
}
