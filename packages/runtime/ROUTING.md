# M1.3 routing checkpoint

This implements the **navigation primitive**, not the completed client-plugin
loader or a routed product shell. `@tokamak/runtime/router` exports
`createMemoryRouter` and `matchRoute`. SDK remains the plugin/data API; window
navigation belongs to runtime.

## Verified compatibility decision

On 2026-11-08, tested the published `@tanstack/solid-router@1.170.43` with
`solid-js@1.9.18`, `vite@8.3.6` and the unchanged production
`packages/build/src/native.ts` compiler.

The probe used `createRootRoute`, one `createRoute`, `createRouter` with
`createMemoryHistory`, and mounted `<RouterProvider router={router} />` through
Tokamak's universal renderer. It transformed 80 modules, then **failed the
native-runtime guard** because `solid-js/web/dist/web.js` entered the graph.
Pinned upstream `Match.tsx` and `link.tsx` import `Dynamic` from `solid-js/web`.
Choosing memory history does not change the rendering adapter to universal.
We did not disable the guard, polyfill a DOM, or claim an actual native window
ran this incompatible adapter.

The probe lives under ignored `spikes/router-native`, not a shipping dependency.
To reproduce, create a private package with the three pinned dependencies above
and this entry:

```tsx
import {
  createMemoryHistory, createRootRoute, createRoute,
  createRouter, RouterProvider,
} from "@tanstack/solid-router";
import { mount } from "@tokamak/render";
const root = createRootRoute();
const page = createRoute({
  getParentRoute: () => root,
  path: "/",
  component: () => <div>Native routing</div>,
});
const router = createRouter({
  routeTree: root.addChildren([page]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
mount(() => <RouterProvider router={router} />);
```

Build it with `nativeConfig` from `@tokamak/build/native`, pointing at the
workspace renderer and this entry. The expected outcome is the guard rejection,
not a successful browser fallback.

## Chosen implementation

Reuse **`@tanstack/history@1.162.5`** for memory history. It has no transitive
runtime dependencies. Only the memory constructor is imported; browser/hash
constructors are tree-shaken out. The native production test verifies no
`window.*` or DOM element construction is required, and actually executes the
bundle in QuickJS/Blitz.

A small universal wrapper supplies Solid-reactive immutable locations,
push/replace/back/forward, owner cleanup and exact segment matching. Patterns
support `:id` and a terminal `*path`; query/hash are preserved as strings, not
interpreted as path segments. Invalid/external navigation is rejected.
Each call creates a distinct history; there is no process-global current router.

```ts
const router = createMemoryRouter("/threads");
router.navigate("/threads/one?tab=items#latest");
router.match("/threads/:id")?.params.id; // "one", reactive when read in UI
router.back();
router.forward();
```

This is not a general router framework: no SSR, browser URL synchronization,
async loaders, nested outlet engine, URL polyfills or automatic network requests.
History entries are retained for the window lifetime; there is not yet an
eviction policy or persisted navigation state.

## Evidence and remaining work

`moon run runtime:check runtime:test` runs:

- Portable ES2022-only source checking.
- Two JavaScript tests for matching, independent history, replacement,
  forward-branch truncation, invalid routes and disposal.
- A production Vite/universal bundle in two separate QuickJS/native documents.
  Host-delivered navigation updates real native text, back/forward works and the
  second document remains independent.

These are headless native-document tests, **not physical two-window UI testing**.

Remaining TKM-44 work: share a single Solid/renderer/SDK-context instance across
shell and plugin bundles; evaluate plugins behind scoped lifecycle/error
boundaries; consume authenticated server UI assets/reload notifications; define
and mount contribution slots; route workspace contributions; implement grants
and their UI; and prove edited-plugin reload in an open native window. The
application does not use this router until that shell integration is implemented.
