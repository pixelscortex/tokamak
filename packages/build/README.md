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
Client `styles.css` is discovered beside the client entry and compiled with
Tailwind. Imported CSS is also collected by Vite. No registration wrapper or
HTML shell is emitted.

`entries.ui` is `{ "code": "ui.js", "map": "ui.js.map", "css": "styles.css" }`;
`css` is omitted when no stylesheet is emitted. Contributions and qualified
slot/component names still come from the compiler, without executing the client.
Final file hashes cover JavaScript, source maps, CSS and server output.

Window imports from the [shared library list](src/shared-libraries.mts) remain bare
and resolve to the desktop app's copies. This includes Solid, the SDK, the UI
kit and the router. Other `@tokamak/*` paths are rejected in both the window
and server parts. Direct `@ui-sdk/*` imports warn because those APIs are unstable;
prefer `@tokamak/ui`.

If a plugin has a `package.json`, the build runs Bun install in the plugin's
folder and bundles its own npm dependencies. Keep shared libraries out of
every dependency section. An npm dependency that uses Solid in the window
gets the app's copy and may require a compatible version.

Compiler-emitted `@plugins/*` module names also remain bare. Authors use
`import { Panel } from "plugin:example/client"`. The compiler emits
`@plugins/example/ui`; the web loader resolves it to the dependency's
revision-pinned module, including literal dynamic imports. Static imports infer
required dependencies; literal dynamic imports infer optional dependencies.

The catalog keeps existing manifest fields and adds `revision`, `uiUrl` and
`stylesheetUrl` per plugin. URLs are `/plugins/<id>/<catalog revision>/assets/<name>`;
plugins without UI or CSS have null URLs. Only manifest-declared window assets and public declarations from
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
The browser fixture lives in `tests/fixtures/browser`; its optional dependency
is built for type checking and need not be installed to serve the fixture.
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

Each build publishes a single `dist/public.d.ts`. The manifest lists it at
`entries.types` and hashes it in `hashes`. It contains declarations for the
plugin's existing public server and window APIs. Public signatures can use types
from the shared library list, but cannot expose types from a plugin's own npm
packages.

The builder looks for a sibling folder whose `dist/manifest.json` declares the
dependency's id. If it finds no built copy, it looks in the running local
server's catalog using `server.json` and `server.token` in the desktop app's data
folder. Set `TOKAMAK_SERVER_DIR` to use another data folder. The build copies the
declarations into `.tokamak/types/` without opening the dependency's source.
If neither location has the declarations, build or install that plugin first.

Build the starter set in dependency order. Chat must publish its types before
ACP builds; the repository's `workspace:plugins-check` task does this:

```sh
proto run bun -- packages/build/src/build.ts plugins/chat
proto run bun -- packages/build/src/build.ts plugins/acp
```

## Building outside the checkout

Run the build from an installed checkout and pass the plugin folder:

```sh
proto run bun -- packages/build/src/build.ts /path/to/plugin
```

A source-only plugin can contain just `plugin.ts` and `src/`. Put the server
part in `src/server` and the window part in `src/client`. The build supplies
TypeScript defaults and resolves shared library types and the Tailwind and
Tokamak theme styles from the checkout. A `tsconfig.json` in the plugin folder
or in the relevant source folder can override the compiler defaults. A
`package.json` is optional with a descriptor. When present, its dependencies
are installed before bundling. Output goes to the plugin's own `dist/` folder.

To test the external artifact against a real server:

```sh
cargo build --locked -p server --bin tokamak
proto run bun -- test packages/build/tests/outside-server.test.mjs
```
