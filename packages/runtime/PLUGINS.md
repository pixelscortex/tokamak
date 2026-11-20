# Plugin client contracts

Plugins keep `src/server/api.ts` and `src/client/api.ts` as their public contracts.
The compiler derives contribution identities from exported SDK brands, without
executing client code. `view`, `itemRenderer`, `toolbar`, `command`, and
`entityCard` remain available from `@tokamak/sdk` and `@tokamak/sdk/client`.

`@tokamak/sdk/client` supplies `defineSlot`, `fill`, `wrap`, `replace`, `Slot`,
`publicComponent`, `ExtensionProvider`, and shortcut context helpers for the DOM.
The compiler qualifies slot names as `<plugin>.<slot>` and public components as
`<plugin>.<export>`. Fills sort by order, plugin ID, then fill identity or export
name. Each fill has an error boundary. Replacements precede wrappers; layers
sort by plugin ID and export name. A failed layer falls back to its inner layer.
The first replacement wins. The shell owns the client and extension lifetimes.

The browser UI target in `packages/build` emits native DOM ES modules. Host
libraries stay bare imports resolved by the app's static import map. For cross-plugin imports,
authors use `plugin:<id>/client`, for example
`import { Panel } from "plugin:example/client"`. The compiler emits the internal
`@plugins/<id>/ui` spelling and the web loader resolves it to blobs owned by the plugin build.
Server imports use `plugin:<id>/server` for public types and host-call references.
Production source cannot escape its plugin via relative paths, aliases, absolute
paths, symlinks or linked plugin packages. Installed packages and the SDK alias
remain allowed; provider implementations are never bundled into consumers.
Server-only plugin artifacts need no UI entry.

The server catalog retains manifest metadata and adds `revision`, `uiUrl` and
`stylesheetUrl` per plugin. The plugin's `revision` field contains its build id.
Assets use `/plugins/<id>/<build-id>/assets/<name>`. The separate catalog revision
pins catalog paging. The app's `plugins/adapter.ts` resolves
these against the endpoint from `host/endpoint.ts` and adds its private query
token. The same token authenticates the WebSocket. Server CORS permits only
configured app origins (`TOKAMAK_ALLOWED_ORIGINS`).

The runtime's `createPluginLoader` retains catalog paging, contribution lookup
and reload/invalidation. The app's `WebPluginHost` fetches modules and rewrites
cross-plugin and relative imports to blobs owned by the plugin build. Host SDK/Solid
contexts are shared through one import map; no eval is needed. Reload remounts
the views of changed plugins and their window importers, releasing their blobs,
stylesheets and query owners. Run `tokamak plugin reload <id>` to build and reload an indexed plugin.
There is no automatic file watcher. The server rejects asset requests for retired builds.

`createPluginShell` and `PluginViews` in `app/src/plugins/views.tsx` expose a
reactive view list, navigation and stage rendering, and register namespaced
TanStack routes. Router and shortcut facades use host contexts. See
[the app instructions](../../app/README.md) for desktop/browser startup and the
compiler-built disposable fixture used to check live queries and reloads.

## View regions

Inside a view, render `Region.Sidebar`, `Region.Header`, or `Region.Panel` from
`@tokamak/sdk/client` with children to place content in the shell's sidebar, page
header, or side panel. The shell supplies `RegionProvider` and `RegionOutlet`
with names `"sidebar"`, `"header"`, and `"panel"`; `useRegionFilled(name)` returns
an accessor for hiding empty regions. Content waits for its outlet, retains the
view's context and reactive owner, and disappears when the view unmounts. Multiple
mounted regions targeting the same outlet render in mount order. Without a
provider, region components render nothing.
