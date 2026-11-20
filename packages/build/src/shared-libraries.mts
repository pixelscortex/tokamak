// The window supplies runtime modules; type and stylesheet entries are build-only.
import { readFileSync } from "node:fs";

const runtime = [
  "solid-js",
  "solid-js/refresh",
  "solid-js/attribution",
  "solid-js/internal",
  "solid-js/internal/container-trace",
  "@solidjs/web",
  "@solidjs/web/jsx-runtime",
  "@solidjs/web/jsx-dev-runtime",
  "@tokamak/sdk",
  "@tokamak/sdk/client",
  "@tokamak/sdk/solid",
  "@tokamak/ui",
  "@tokamak/runtime/router",
];
const buildOnly = ["@tokamak/sdk/web", "@tokamak/ui/theme.css"];
const unstable = ["@ui-sdk/solid", "@ui-sdk/core"];

export function packageName(id: string) {
  return id
    .split("/")
    .slice(0, id.startsWith("@") ? 2 : 1)
    .join("/");
}

export const sharedPackages = new Set([...runtime, ...buildOnly, ...unstable].map(packageName));

export const windowSharedImports = [
  ...runtime,
  ...unstable.flatMap((name) => {
    const { exports } = JSON.parse(
      readFileSync(new URL(`../../../app/node_modules/${name}/package.json`, import.meta.url), "utf8"),
    );
    return Object.keys(exports)
      .filter((key) => !/\.(?:json|css)$|\*/.test(key))
      .map((key) => name + key.slice(1));
  }),
];
export const sharedImports = [...windowSharedImports, ...buildOnly];
const allowed = new Set(sharedImports);

export function checkTokamakImport(id: string, file: string) {
  if (id.startsWith("@tokamak/") && !allowed.has(id))
    throw new Error(
      `Plugin import ${JSON.stringify(id)} in ${file} is not shared. Allowed paths: ${sharedImports.filter((path) => path.startsWith("@tokamak/")).join(", ")}`,
    );
}
