# Tokamak artifact build

Build a plugin artifact by passing its folder to the builder:

```sh
proto run bun -- packages/build/src/build.ts plugins/chat
```

## Building outside the checkout

Install the Tokamak checkout's workspace dependencies with
`proto run bun -- install --frozen-lockfile`. In the plugin or its parent
workspace's `node_modules/@tokamak/`, link `sdk`, `build`, `ui` and `runtime`
to the checkout's corresponding `packages/` directories. Keep the links pointing
to the real checkout so the builder and SDK can resolve their installed tools
(Vite, TypeScript, the Solid compiler and Tailwind's compiler and scanner).

Install the third-party packages that plugin source imports in the plugin
workspace. For a Solid window, use `solid-js@2.0.0` and `@solidjs/web@2.0.0`;
for window type checking, also install `vite@8.3.6` and `@types/node@26.6.6`.
Stylesheets that import Tailwind need `tailwindcss` there too (the bundled
plugins use `4.3.5`). A setup using the checkout's existing installs can
symlink these individual dependency directories instead.

```sh
bun node_modules/@tokamak/build/src/build.ts <plugin-folder>
```

Use Bun 1.4.4, as pinned by the checkout. The plugin folder can be absolute or
relative to the current directory.
Extend `@tokamak/sdk/tsconfig.server.json` for server code and
`@tokamak/sdk/tsconfig.window.json` for window code. If the plugin has no server
config, the builder uses the SDK's server base. Window tests can import
`@tokamak/build/window-test-config` and `@tokamak/build/client-surface`.

Keep source for plugins imported as `plugin:<id>/server` or `plugin:<id>/client`
in sibling folders named by ID. The builder looks for dependency manifests
beside the plugin, in the configured plugin catalog, or in `TOKAMAK_PLUGIN_DIR`.

## Artifacts

The builder reads literal `plugin.ts` metadata, bundles `src/server/` through the
SDK compiler, derives public function references and provider contracts, and
writes a versioned `dist/manifest.json` with hashes of final emitted bytes.
The transaction bundle contains queries and mutations. The action process
loads server actions from the full server bundle.
Unchanged output preserves bytes and modification times. The manifest is
published last; installation still needs its own complete-artifact staging.

The UI target emits browser ESM in `ui.js` and `ui.js.map`, compiled with Solid 2
DOM JSX. `ui: false` explicitly disables the
UI target; `backend: false` disables the server target. The server output is declared in `entries.server`.
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

The catalog keeps existing manifest fields and adds `revision`, `installOrder`,
`uiUrl` and `stylesheetUrl` per plugin. URLs are `/plugins/<id>/<catalog revision>/assets/<name>`;
plugins without UI or CSS have null URLs. Only manifest-declared UI assets from
the current verified snapshot are served. Stale revisions return 404. Successful
assets use `private, max-age=31536000, immutable` caching and JavaScript uses
`text/javascript`.

Asset GET, catalog GET and WebSocket upgrades accept exactly the origins in
`TOKAMAK_ALLOWED_ORIGINS` (comma-separated, replacing the defaults):
`tauri://localhost`, `http://tauri.localhost`, `http://127.0.0.1:1420`.
Other origins receive 403. Requests without Origin remain supported.
Desktop mode requires the existing local token. The window sends
`Authorization: Bearer …` for HTTP, including asset and stylesheet fetches.
It applies the fetched CSS as a constructed stylesheet, which it removes
when the plugin generation retires.
On browser WebSocket upgrades it offers `tokamak` and
`tokamak.bearer.<percent-encoded token>` as subprotocols; the server selects
only `tokamak`. Missing or wrong credentials receive 401. Tokenless loopback development exposes these routes too,
with the same origin checks. Control routes remain native-only and require
header authorization in desktop mode.

Run the focused build tests from this directory with `sh tests/run.sh`.
The browser fixture lives in `tests/fixtures/browser`; its optional cross-plugin
module need not be installed to build or serve it.
After building `target/debug/tokamak-server`, run the real curl/WebSocket checks from the
repository root with `proto run bun -- packages/build/tests/browser-assets.mjs`.
They cover loopback, desktop token authentication and a configured origin list.

## Plugin imports

Production source (server, window and caller actions; tests excluded) must stay inside
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
boundary. Public APIs are inspected
statically and are never executed by the builder.

`plugin:<id>/tables` exposes generated handles for the tables in a sibling
plugin's server schema. Add the owner to `depends` to use one in `v.ref`. The
builder makes a local type copy in `.tokamak/types/<id>/tables.d.ts` and emits
only qualified table names at runtime. Do not check in or hand edit the copy.

Within a plugin, use `src/server/_generated/api.ts` from the window. Its runtime
references contain only public names. The window build refuses imports of other
server code, including `_generated/internal.ts`. Internal definitions cannot be
re-exported through the public server entry. Commit both generated files.

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

## Extending a screen

Build the owner plugin to publish a typed `find` on its public client API.
Searches look at that plugin's authored JSX, including UI it contributes to
other plugins. Each element is named by its nonempty static `data-part`,
then its static `id`, then its tag or component name (such as `Menu.Item`).
`data-part-ignore` excludes an element and its descendants.

If a name has several matches, narrow it with `in` to an enclosing render
function or element. Solid control flow and fragments are transparent.
You can also narrow a name by static `type`, `href`, `role`, and `aria-*`
attributes. Write ARIA keys without the prefix, for example
`find("button", { aria: { label: "Stop" } })`. The typed API offers the
attribute filters and values the owner writes for that name. Computed JSX
values, class, style, data attributes and text cannot match a filter, and
neither can an attribute written before a spread, which can replace it. A
value is matched as written in the source: `aria-label="Save &amp; quit"` is
found with `"Save &amp; quit"`.

Filters must all match. If the search is still ambiguous, use `nth` to select
a 1-based position among the remaining matches in source order. The name
and filters in the search must be literals. If the search does not identify
exactly one element, the build fails and lists the candidates.

When an add-on finds a plain tag without a static `data-part` or `id`,
both builds warn and suggest adding `data-part`. The owner's build reports
this once per installed add-on and target.

Commit the generated `_generated/components.d.ts` next to the client entry.
Export actions from the contributing plugin's client entry:

```tsx
import { after } from "@tokamak/sdk/client";
import * as chat from "plugin:chat/client";

export const Branch = after(chat.find("title", { in: "Header" }), BranchChip);
```

`before` and `after` render siblings. `prepend` and `append` render inside
elements that accept children.

Use `layer(target, (props, Original) => …)` to take over the element.
Render `<Original />` to draw the next layer down, or the owner's element
at the bottom. Pass children to change the contents without changing the
element or its attributes. Put `<Original.Children />` inside `<Original>` to
draw the contents that would appear without this layer: the children supplied
by an outer layer, or the owner's contents with other plugins' `prepend` and
`append`. Draw `Original` and `Original.Children` at most once per layer.
If no layer draws `Original`, the owner's element is unloaded. While a layer
supplies the contents, the owner's plain tags inside keep their DOM nodes,
but components inside mount again each time the contents change hands, so
their own state starts over. A layer with a
false `when` passes through.
Layers run outermost first by plugin install order, then `order` (default
0), plugin ID, and export name. `before` and `after` stay outside all layers;
`hide` also removes those sibling additions.

Actions and their live `when` option receive the
props of the render function that owns the tag. Parts inside an inline list
callback get `props.$row.item` and `props.$row.index`, typed as Solid passes
them to that callback. Nested rows expose the enclosing row as `$row.parent`.
With `Index` (or Solid 2’s `For keyed={false}`), the item is an accessor and
the index is a number.

An add-on's manifest records both the search and the element selected at
build time. When the owner changes, a search keeps its original match if
possible, or follows the only remaining match. If a search cannot be
resolved, the owner's build warns with the add-on ID and the window skips
the placement and raises an alert. A search with `nth` stays on the element
it found: when the owner's change puts another element at that position, the
placement is skipped, never moved. Give a target a `data-part` to avoid
relying on position.

A positional segment hashes the tag, the attributes `role`, `type`, `name`,
`for` and `href` (each by its static string value or as "an expression"),
and any `aria-*` attribute that has a static string value. It ignores every
other attribute, including `class`, `style`, `data-*`, computed `aria-*`,
event handlers, `ref`, spread attributes, and the source text of
expressions. If two positional siblings
still have the same identity, a swap of the two cannot be seen; an add-on
build that picks one of them with `nth` warns that the target is ambiguous
and asks the owner for a `data-part` or `id`.

Use `attach(owner.find("Composer"), TrackComposer, { when })` to run a
component for each mounted instance of the owner's named render function.
It receives live props and can use effects, cleanup, context, and shell
regions such as `Region.Panel`. Returned JSX is evaluated without drawing in
place. Hiding or layering an element inside the function leaves the attachment
running. An attachment stops and cleans up when its instance leaves, `when`
becomes false, or it throws. Failures are warned once per plugin and export.

For `attach`, `find` searches only render functions; placements search only
elements. Use `in` for an enclosing render function and `nth` to pick a
position; attribute filters apply to elements. Attachments start in plugin
install order, then `order`, plugin ID, and export name. Owner updates
recheck the match and warn when an attachment can no longer resolve.

### Contract registrations

`src/contracts.ts` declares named public contract keys. A
`plugin:<id>/contracts` import compiles to a key and type references only; it
never includes the provider or defining plugin's executable code. Optional
dependencies can build with a checked-in copy of the public declarations at
`contracts/<id>.ts` if the defining plugin's source is absent. The compiler
checks each exported `provide(...)` against the declaration and requires the
defining plugin in `depends` or `optional`. The artifact records declarations
and registrations in `contracts` and `contractProviders`, and includes
implementation code only in the declared local or server lane.

Generated `_generated/plugin.ts` contains references for `pluginOnly(...)`
functions when present. Commit it along with `api.ts` and `internal.ts`.
