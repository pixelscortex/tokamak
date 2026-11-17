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
and `@plugins/*`. Cross-plugin imports retain their authored specifier, for
example `import { Panel } from "@plugins/example/ui"`; the shell import map must
map it to that plugin's catalog UI URL. Static imports infer required dependencies;
literal dynamic imports infer optional dependencies.

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
