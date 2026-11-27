# Web plugin loading

`createPluginShell(client, endpoint, source, routing): PluginShell` accepts the
connected SDK client, `{ http, ws, token }` supplied by the host, an optional SDK
catalog/event source (otherwise GET `/plugins`), and the shell TanStack router,
root route, and static routes. `App` connects on start using `host/endpoint.ts`; its optional `getEndpoint`
override also feeds the plugin shell. The browser fallback uses VITE_TOKAMAK_HTTP.

The shell gets:

- `views: Accessor<readonly PluginView[]>`, where `PluginView` is
  `{ id, plugin, route, title, generation }`. Routes are namespaced under
  `/p/<plugin>`; view modules load lazily when selected.
- `PluginViews({ shell, view })` for a stage, also installed automatically as
  code-defined TanStack routes. Route components keep their identity across
  unrelated catalog updates. Generation changes retire their Solid roots.
- `loader`, `host`, `navigation`, `client`, `connect()`, and `dispose()`.

`adapter.ts` is the server contract boundary. It accepts the retained
`plugin`/`entries.ui.code`/`entries.ui.css` catalog and a flat
`id`/`revision`/`ui`/`stylesheet`/`contributes` form. Server `uiUrl` and
`stylesheetUrl` take precedence over the artifact filenames. Relative asset names become
revision paths; absolute URL paths remain intact. Tokens are added only for the
configured server origin. The server must permit CORS from the app origin.

Vite emits strict entry chunks re-exporting the installed browser host modules,
plus a single import map before the shell script. Shared dependencies remain in
Vite's common graph, so plugins and the shell receive identical functions,
brands, and contexts. Dev uses virtual Vite modules for the same entries. The
map covers runtime package exports of Solid, SDK, UI, and both ui-sdk packages;
CSS and types-only entries are excluded. This does not resurrect removed
package exports such as `solid-js/universal`, `solid-js/store`, or the old
`@tokamak/ui/components` and `@tokamak/ui/elements`.

Cross-plugin imports are lexed, fetched, and rewritten to generation-owned blob
URLs before native `import()`. Relative chunks, literal dynamic imports,
re-exports, and `import.meta.url` are handled too. The pure JavaScript lexer is
resolved from the pinned Vite toolchain's `es-module-lexer/js` dependency; it
requires neither eval nor WebAssembly compilation. Runtime-computed dynamic
import specifiers and cyclic UI module graphs fail with a plugin error. Native
ESM caches cannot be unloaded; retirement revokes blobs, detaches stylesheets,
and disposes mounted contribution owners. Module-level arbitrary side effects
are not disposable: plugins must create Solid effects/resources inside their
components. Cross-plugin stylesheet generations retire with their module.

The loader gains one optional `PluginModuleHost.importModule` hook. Its existing
catalog paging, pending-load retirement checks, metadata diffs, static dependency
invalidation and reload API remain in charge. The web host adds actual ESM
importer edges, including literal lazy imports.

`router.ts` honours every old router export: `RouteLocation`, `RouteMatch`,
`MemoryRouter`, `matchRoute`, `createMemoryRouter`, `RouterContext`, and
`useRouter`. The router interface still provides `location`, `navigate`, `back`,
`forward`, `match`, and `dispose`. It wraps TanStack history; no second shell
history is created. Shortcut exports remain the SDK's `Shortcuts`,
`ShortcutContext`, and `useShortcuts`; `registerShortcut` returns unregister.
Dispatch ignores composition, repeat, and already handled events. Names use
`Meta+Control+Alt+Shift+<lowercase key>` in that order, omitting absent modifiers.

## Browser checks

From the repository root:

```sh
proto run bun -- run --cwd app dev
```

Open `/tests/fixtures/check.html` to run the fixture in dev. For built assets:

```sh
TOKAMAK_PLUGIN_FIXTURES=1 proto run bun -- run --cwd app build
TOKAMAK_PLUGIN_FIXTURES=1 proto run bun -- run --cwd app vite preview --host 127.0.0.1 --port 4173 --strictPort
TOKAMAK_PLUGIN_FIXTURES=1 proto run bun -- run --cwd app vite preview --host 127.0.0.1 --port 4174 --strictPort
```

Open `http://127.0.0.1:4173/tests/fixtures/check.html?assets=http%3A%2F%2F127.0.0.1%3A4174`
to fetch plugin bytes from another origin. The result element reports
`data-status="passed"` or `failed`. The preview fixture route requires the
explicit environment flag; normal builds contain no fixture harness.

On macOS the same production check runs directly in the system WKWebView:

```sh
xcrun swift app/tests/fixtures/check-webkit.swift
```

Both Chromium 152 (T3 preview) and the installed system WKWebView passed all 18
assertions: host and cross-plugin identity; route installation; branded view and
query mounting; signal updates; unchanged-catalog owner preservation; revision
swap and query cleanup; importer invalidation and owner retirement; one current
stylesheet; throwing-view boundary and reload button; shared router and shortcut contexts; host survival; route and
stylesheet removal. Dev passed in Chromium too. These are fixture-client checks,
not acceptance of the parallel server implementation or the packaged Tauri app.

A single static import map is deliberate. WebKit's multiple-map implementation
is recorded in <https://bugs.webkit.org/show_bug.cgi?id=279025>; older WKWebViews
cannot be assumed to support late/multiple maps, and maps cannot replace an
already resolved specifier on reload. No dynamic-map behavior is relied on.
The installed WKWebView verified static maps, CSP hashes, blob modules and
cross-origin fetching; older WKWebView versions were not tested.

The Tauri and index CSPs permit blob scripts, loopback HTTP assets and
WebSocket connections. The import map is hashed; no `unsafe-eval` is needed.
Other server origins require host CSP configuration.

## Validation ledger

Final command results on `tauri/1e-plugin-loader`:

| Command                                                          | Exit | Result                                                                                                     |
| ---------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| `proto run bun -- run check`                                     | 0    | Workspace format, TypeScript lint and Rust lint pass.                                                      |
| `proto run bun -- run --cwd app check`                           | 0    | App TypeScript check passes.                                                                               |
| `proto run bun -- run --cwd app test`                            | 0    | 10 tests across two files pass. Node reports a nonfatal asm.js optimization warning for the pure JS lexer. |
| `proto run bun -- run --cwd app build`                           | 0    | Production Vite build passes; fixture harness excluded.                                                    |
| `TOKAMAK_PLUGIN_FIXTURES=1 proto run bun -- run --cwd app build` | 0    | Production fixture build passes.                                                                           |
| `xcrun swift app/tests/fixtures/check-webkit.swift`              | 0    | All 18 assertions pass against the fixture preview build, using port 4174 for cross-origin plugin assets.  |

T3 preview navigation/evaluation of the fixture page at port 4173 returned
`data-status="passed"` and all 18 assertions in Chromium 152. Preview tool calls
have no process exit code. The equivalent dev check at port 1420 also passed.
No server process, release Tauri bundle, Windows or Linux runtime was tested.
