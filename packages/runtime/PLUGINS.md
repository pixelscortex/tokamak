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

`@tokamak/runtime/plugins` preserves the manifest/catalog/reload logic.
It consumes SDK asset pages pinned to a catalog revision, invalidates affected
importers, and prevents retired loads from publishing. `PluginModuleHost` is the
boundary for a future web implementation. No module evaluator ships here.

The plugin UI build is disabled by `PLUGIN_UI_BUILD_ENABLED` in
`packages/build/src/vite.ts`. Server artifacts remain valid without `entries.ui`.
A later agent must add DOM ESM output, server asset URLs, shared host imports,
and a web module host. The app skeleton loads no plugin UI. Plugin isolation,
server discovery/authentication, router imports, and shortcut integration remain
part of that work; the author API has not changed.
