# Tokamak artifact build

One public pipeline coordinates maintained Vite/Solid, the existing SDK backend
compiler and Tailwind v4. It does not introduce another TypeScript compiler,
runtime loader. The build enforces source isolation; the host enforces call permissions.

```sh
bun run plugin:build path/to/plugin
bun run app:dev
bun run ui:lab
bun run build          # explicit size-oriented release build
```

The builder accepts a folder (defaults to cwd) or `--config <vite.config.ts>`.
App, lab and regression fixtures all use this publisher. If a folder has no
static `plugin.ts`, the normal `src/server/`, `src/client/api.ts`, `src/client/styles.css` conventions
apply.

## Definition and output

```ts
import { defineConfig } from "vite";
import { definePlugin } from "@tokamak/sdk";
import { tokamak } from "@tokamak/build/vite";

export default defineConfig({
  plugins: [
    tokamak({
      plugin: definePlugin({ id: "acme.notes", version: "0.1.0" }),
    }),
  ],
});
```

`backend: false` builds UI-only artifacts; `ui: false` builds backend-only
artifacts. Omitting the descriptor derives identity from package.json for
internal/test projects. Explicit identity is recommended for real plugins.
Dependency resolution, grants, contribution registration and runtime loading
belong to M1; `definePlugin` currently validates packaging identity only.

The versioned `dist/manifest.json` declares only emitted entries:

```json
{
  "formatVersion": 1,
  "plugin": { "id": "acme.notes", "version": "0.1.0" },
  "entries": {
    "backend": { "code": "bundle.js", "map": "bundle.js.map", "api": "api.ts" },
    "ui": { "code": "ui.js", "map": "ui.js.map", "css": "styles.css", "shell": "shell.html" }
  }
}
```

- Backend is self-contained ESM; UI is native Solid-universal IIFE.
- Maps preserve original TS/TSX source. SDK type checking uses a temporary file,
  while bundling uses a stable virtual entry and canonical cwd.
- `api.ts` contains typed references, not executable handlers. As in the existing
  SDK, its type imports require the author's backend source when type-checking.
  This is not a portable declaration-only SDK publishing format.
- Only changed output bytes are atomically replaced. No-op mtimes remain stable,
  including source-map-only and backend-only edits.
- Manifest is written last, but publication is not an atomic multi-file install.
  The M1 installer must stage complete artifacts. Consumers must use manifest
  entries, not assume unreferenced leftover files are active.
- Chunking is deferred; there is no native module/resource loader yet.

M1 still must establish shared Solid/renderer ownership, contribution
registration and disposal before loading several UI plugins into one window.
The current self-contained application/preview IIFE must not simply be
evaluated repeatedly over a running shell's global renderer state.

## Plugin imports

Production source (server, client and worker; tests excluded) must stay inside
its own plugin folder. Relative paths, absolute paths, source aliases and
symlinks cannot reach another folder. Dependencies installed through
`node_modules`, including workspace packages, are allowed; another plugin's
implementation is never a package dependency.

Use a sibling plugin's public API through sanctioned specifiers:

```ts
import { api as chat, type ToolPart } from "plugin:chat/server";
// Inside an action: host routing and can_call still govern every operation.
await ctx.use(chat).updateRun({ runId, token, delta: "Hello" });
```

`plugin:<id>/server` and its shorthand `plugin:<id>` expose public types from
that plugin's `src/server/api.ts` and generated references for its exported
queries, mutations and actions. The `api` object uses the public export names;
named imports also carry references. No runtime helpers or handlers cross the
boundary. Legacy packages use `backend/api.ts`. Public APIs are inspected
statically and are never executed by the builder.

`plugin:<id>/client` resolves to the client registry (`@plugins/<id>/ui`, which
remains supported). Static imports declare dependencies and dynamic imports
use the lazy registry loader. Public client types come from `src/client/api.ts`.

The builder generates ignored type facades in `.tokamak/types` and configures
its checkers automatically. For editor checking outside the builder, add these
paths to the plugin's tsconfig (relative to the plugin root):

```json
{
  "compilerOptions": {
    "paths": {
      "plugin:*/server": [".tokamak/types/*/server.d.ts"],
      "plugin:*/client": [".tokamak/types/*/client.d.ts"],
      "plugin:*": [".tokamak/types/*/server.d.ts"]
    }
  }
}
```

The current authoring build requires sibling public source APIs for type and
reference metadata; installed artifacts remain independent of that source.

## Generated native context

Applications add the `tokamak-build` Cargo build dependency from this directory
and a build.rs calling `tokamak_build::build()`. It reads app.config.json:

```json
{ "title": "My app", "width": 680, "height": 820 }
```

The helper validates `dist/manifest.json` and required UI assets, tracks them as
Cargo inputs, and writes context into OUT_DIR without changing identical output.
Authored entry points use `runtime::context!()`, never generated paths or manual
asset embedding. Connected apps call `runtime::client::run`; UI-only tools call
`runtime::client::run_ui`.

## CSS

Pinned Tailwind 4.3.4 Node compilation + maintained Oxide extraction run only at
build time. Automatic sources start beside the target stylesheet, not at the
monorepo root. Use `@source` for shared code and complete static utility names.
Shared UI theme/utilities omit browser preflight to preserve native input defaults.
Generating a utility does not prove every browser CSS feature renders in Blitz.

## Ownership and checks

- Build package: packaging, code generation and CSS compilation.
- Runtime tools: independent server process discovery/start/status/stop.
- Engine: JavaScript execution; never Vite/Bun/Tailwind.
- SDK: portable plugin/function authoring and typed references.

`app/tests/compiler.ts` exercises cwd/spacing, maps, guards, optional entries,
stable bytes/mtimes and repair. Build tests check CSS extraction and compile the
generated Rust context with a minimal independent client type. Lab tests execute
the actual native control/layout path.
