# Tokamak artifact build

Build a plugin's server artifact from the repository root:

```sh
proto run bun -- packages/build/src/build.ts plugins/chat
```

The builder reads literal `plugin.ts` metadata, bundles `src/server/` through the
SDK compiler, derives public function references and provider contracts, and
writes a versioned `dist/manifest.json` with hashes of final emitted bytes.
Worker plugins also receive their Bun action bundle and worker entry.
Unchanged output preserves bytes and modification times. The manifest is
published last; installation still needs its own complete-artifact staging.

The UI target emits browser ESM in `ui.js` and `ui.js.map`, compiled with Solid 2
DOM JSX. `ui: false` explicitly disables the
UI target; the server target and `backend: false` option keep their names.
Put plugin styles in `src/client/styles.css`. The build discovers this file
beside the window entry and compiles it with Tailwind. Vite can bundle other
imported CSS files, but those files do not get the checkout's Tailwind and
Tokamak theme resolver. No registration wrapper or
HTML shell is emitted.

`entries.ui` is `{ "code": "ui.js", "map": "ui.js.map", "css": "styles.css" }`;
`css` is omitted when no stylesheet is emitted. Contributions and qualified
slot/component names still come from the compiler, without executing the client.
Final file hashes cover JavaScript, source maps, CSS and server output.

The [shared library list](src/shared-libraries.mts) defines which entry points
the desktop window provides. A plugin can import the authored window entries;
the compiler and shared dependencies can also reference compiler-only entries.
Direct `@ui-sdk/*` imports warn because those APIs are unstable; prefer
`@tokamak/ui`. Server code can use `@tokamak/sdk`; `@tokamak/sdk/web` is types
only and `@tokamak/ui/theme.css` is stylesheet only. The build checks these
rules in both the window and server parts, including bundled dependencies.

The window build does not bundle shared libraries. An npm dependency can use
the app's copy of Solid if it imports a listed entry point as an ES module.
Deep paths and CommonJS requires of shared libraries fail the build. A dependency
may still require a compatible version of Solid.

A plugin can declare its own npm dependencies in an optional `package.json`.
Keep shared libraries out of every dependency section. With dependencies present,
the build installs them in the plugin folder and bundles what its source imports.
An existing Bun lockfile is frozen; if it disagrees with the manifest, update
the lockfile explicitly and try again. Convert other package managers' lockfiles
to a Bun lockfile before building. Without a lockfile, the first install writes
one. The build skips installation for a dependency-free manifest and reuses a
previously verified tree as long as the recorded inputs and install state
match. Offline, an unchanged install works without the registry; an install
can use Bun's cache and fails with an install diagnostic if a package is missing.
Bun runs dependency lifecycle scripts according to its regular trust rules.

Compiler-emitted `@plugins/*` module names also remain bare. Authors use
`import { Panel } from "plugin:example/client"`. The compiler emits
`@plugins/example/ui`; the web loader resolves it to the dependency's
revision-pinned module, including literal dynamic imports. Static imports infer
required dependencies; literal dynamic imports infer optional dependencies.

The catalog keeps existing manifest fields and adds `revision`, `uiUrl` and
`stylesheetUrl` per plugin. URLs are `/plugins/<id>/<catalog revision>/assets/<name>`;
plugins without UI or CSS have null URLs. Only manifest-declared UI assets from
the current verified snapshot are served. Stale revisions return 404. Successful
assets use `private, max-age=31536000, immutable` caching and JavaScript uses
`text/javascript`.

Asset GET, catalog GET and WebSocket upgrades accept exactly the origins in
`TOKAMAK_ALLOWED_ORIGINS` (comma-separated, replacing the defaults):
`tauri://localhost`, `http://tauri.localhost`, `http://127.0.0.1:1420`.
Other origins receive 403. Requests without Origin remain supported.
Desktop mode requires the existing local token, either `Authorization: Bearer …`
or `?token=…` on those browser routes. Web loaders must append the token to each
asset URL, including stylesheet URLs, and the WebSocket URL. Missing or wrong
tokens receive 401. Tokenless loopback development exposes these routes too,
with the same origin checks. Control routes remain native-only and require
header authorization in desktop mode.

Run the focused build tests from this directory with `sh tests/run.sh`.
The browser fixture lives in `tests/fixtures/browser`; its optional cross-plugin
module need not be installed to build or serve it.
After building `target/debug/tokamak`, run the real curl/WebSocket checks from the
repository root with `proto run bun -- packages/build/tests/browser-assets.mjs`.
They cover loopback, desktop token authentication and a configured origin list.

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

`plugin:<id>/client` compiles to the internal module name `@plugins/<id>/ui`.
Authors use only `plugin:<id>/client`; authored `@plugins/*` imports are rejected.
Static imports declare dependencies and literal dynamic imports declare optional
dependencies. The web loader rewrites both to revision-owned browser modules.
Public client types come from `src/client/api.ts` or `src/client/api.tsx`.

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

## Building outside the checkout

Run the build from an installed checkout and pass the plugin folder:

```sh
proto run bun -- packages/build/src/build.ts /path/to/plugin
```

A source-only plugin can contain just `plugin.ts` and `src/`. Put the server
part in `src/server` and the window part in `src/client`. The build supplies
TypeScript defaults and resolves shared library types and the Tailwind and
Tokamak theme styles from the checkout. A `tsconfig.json` in the plugin folder
or in the relevant source folder overrides the defaults option by option.
The build still selects the source files it checks, controls emission and
generated `plugin:*` paths, and fixes the server libraries and ambient types:
ES2022 and no ambient type packages for the default runtime; ES2022, DOM and
Node types from the checkout for the worker runtime. A
`package.json` is optional with a descriptor. When present, its dependencies
are installed before bundling. Output goes to the plugin's own `dist/` folder.

To test the external artifact against a real server:

```sh
cargo build --locked -p server --bin tokamak
proto run bun -- test packages/build/tests/outside-server.test.mjs
```
