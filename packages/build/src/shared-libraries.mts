// The window supplies runtime modules; type and stylesheet entries are build-only.
import { dirname, isAbsolute, join } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { BuildError } from "./diagnostics.ts";

const authoredWindow = [
  "solid-js", // Signals and reactive state in plugin views.
  "@solidjs/web", // Components and rendering primitives in plugin views.
  "@tokamak/sdk", // Shared client and server API contracts.
  "@tokamak/sdk/client", // Contribution declarations and window context.
  "@tokamak/sdk/solid", // Reactive queries in the window.
  "@tokamak/ui", // App components and theme.
  "@tokamak/runtime/router", // Navigation from plugin views.
];
const compilerWindow = [
  "solid-js/refresh", // Solid compiler hot reload.
  "solid-js/attribution", // Solid performance attribution tooling.
  "solid-js/internal", // Solid Web renderer internals.
  "solid-js/internal/container-trace", // Solid Web frame tracing.
  "@solidjs/web/jsx-runtime", // JSX transforms; serves the base renderer.
  // jsx-dev-runtime is deliberately unavailable: it ships another renderer.
];
export const windowAliases: Readonly<Record<string, string>> = {
  "@solidjs/web/jsx-runtime": "@solidjs/web",
};
const serverEntries = ["@tokamak/sdk"]; // Server operations, validators and schema.
const typeEntries = ["@tokamak/sdk/web"]; // Server definitions that augment Web types.
const stylesheetEntries = ["@tokamak/ui/theme.css"]; // Theme reference for Tailwind.
const buildOnly = [...typeEntries, ...stylesheetEntries];
// The direct escape hatch includes the roots and concrete JavaScript exports
// from the exact two UI SDK packages installed by the app (e.g. Chat textarea).
const unstable = ["@ui-sdk/solid", "@ui-sdk/core"];

export function packageName(id: string) {
  return id
    .split("/")
    .slice(0, id.startsWith("@") ? 2 : 1)
    .join("/");
}

export const sharedPackages = new Set(
  [...authoredWindow, ...compilerWindow, ...buildOnly, ...unstable].map(packageName),
);

const unstableEntries = unstable.flatMap((name) => {
  const { exports } = JSON.parse(
    readFileSync(new URL(`../../../app/node_modules/${name}/package.json`, import.meta.url), "utf8"),
  );
  return Object.keys(exports)
    .filter((key) => !/\.(?:json|css)$|\*/.test(key))
    .map((key) => name + key.slice(1));
});
const authoredWindowEntries = [...authoredWindow, ...unstableEntries];
export const windowSharedImports = [...authoredWindowEntries, ...compilerWindow];
export const sharedImports = [...windowSharedImports, ...buildOnly];
type ImportPart = "window" | "server" | "stylesheet";

function importEntries(part: ImportPart, authored: boolean) {
  if (part === "server") return serverEntries;
  if (part === "stylesheet") return stylesheetEntries;
  return authored ? authoredWindowEntries : windowSharedImports;
}

export function authoredTypeImports(part: "window" | "server") {
  return [...importEntries(part, true), ...typeEntries];
}

export function checkTokamakImport(
  id: string,
  file: string,
  part: ImportPart,
  typeOnly = false,
  resolved = id,
  authored = false,
) {
  if (!resolved.startsWith("@tokamak/") && !sharedPackages.has(packageName(resolved))) return;
  const entries = importEntries(part, authored);
  const allowed = [
    ...entries.filter((path) => !id.startsWith("@tokamak/") || path.startsWith("@tokamak/")),
    ...(part === "stylesheet" ? [] : typeEntries),
  ];
  if (resolved === id && (entries.includes(id) || (typeOnly && typeEntries.includes(id)))) return;
  const restriction = typeEntries.includes(id)
    ? " (types only)"
    : stylesheetEntries.includes(id)
      ? " (stylesheet only)"
      : "";
  throw new BuildError([
    {
      code: sharedPackages.has(packageName(resolved)) ? "PLUGIN_SHARED_IMPORT" : "PLUGIN_PRIVATE_IMPORT",
      message: `Plugin import ${JSON.stringify(id)} in ${file} is not allowed in the ${part} part${restriction}. Allowed paths: ${allowed.join(", ")}`,
    },
  ]);
}

const windowEntries = new Set(windowSharedImports);

export function resolvedPackage(file: string): string | undefined {
  if (!isAbsolute(file)) return;
  for (
    let dir = dirname(existsSync(file) ? realpathSync(file) : file);
    dir !== dirname(dir);
    dir = dirname(dir)
  ) {
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof name === "string") return name;
  }
}

export function windowExternal(id: string, importer: string, target?: string) {
  if (windowEntries.has(id)) return id;
  const requested = packageName(id);
  const owner = target && resolvedPackage(target);
  const shared = sharedPackages.has(requested) ? requested : owner;
  if (shared && sharedPackages.has(shared))
    throw new BuildError([
      {
        code: "PLUGIN_SHARED_IMPORT",
        message: `Plugin import ${JSON.stringify(id)} in ${importer} resolves to shared library ${shared}. Allowed paths: ${windowSharedImports.filter((path) => packageName(path) === shared).join(", ")}`,
      },
    ]);
}
