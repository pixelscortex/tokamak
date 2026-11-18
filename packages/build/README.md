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

Shared imports remain bare: `solid-js`, `solid-js/*`, `@solidjs/web` (including
subpaths), `@tokamak/sdk` (including subpaths), `@tokamak/ui` (including subpaths),
`@tokamak/runtime/router`, `@ui-sdk/solid` and `@ui-sdk/core` (including subpaths),
and compiler-emitted `@plugins/*` module names. Authors use
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

## Machine services and maintenance

A plugin may add `src/machine/main.ts` exporting an async
`start(ctx: MachineContext)` from the SDK. It may optionally add a sibling
`tsconfig.json`. The compiler checks and bundles it for Bun separately from
`src/server`, including the same plugin import boundary. The manifest's
`entries.machine` has `entry`, `code`, and `map` paths covered by artifact hashes;
none are downloadable as UI assets. A machine-only plugin is valid. No extra
`runtime` field is needed for this entry.

The local host starts services on its first authenticated machine configuration,
keeps their configuration available for the service lifetime, supervises exits,
and stops them on reload or shutdown. Service code receives a cancellation signal
and `configuration()`; it has no transaction or action invocation authority.

A descriptor may name `maintenance: "module:mutation"`. Loading checks that this
is a mutation. The server invokes it with empty arguments every second through
its normal transaction coordinator, independent of window sessions. Chat uses
this hook to expire machine leases and interrupted runs.
