# Tokamak artifact build

Build a plugin's server artifact from the repository root:

```sh
proto run bun -- packages/build/src/build.ts plugins/chat
```

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

Production source (server, window and local part; tests excluded) must stay inside
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

Build the owner plugin to publish a typed `parts` export on its public client
API. No part declarations are needed: every authored JSX element in window
code is addressable. Solid control flow (`Show`, `For`, `Index`, `Switch`,
`Match`, `Suspense`, `ErrorBoundary`/`Errored`, `Dynamic`, and `Portal`) is
transparent, like fragments. Wrapping an element with one does not rename it.

A path follows the named render function and the element's JSX ancestry.
Nested named functions add a segment under their enclosing function and
inherit its props if they declare no parameter. Inline callbacks, including
callbacks passed to calls such as `map` or `createMemo`, add no segment. A
duplicate render name in the same scope fails the build with both locations
rather than assigning file-order suffixes.

Each element's segment is its nonempty static `data-part`, then its static
`id`, then its tag or component name. A static name keeps its segment if a plain tag shares the name; the plain tag
gets a positional suffix. Two explicit names cannot collide. Unnamed siblings with the same name use source order:
`div`, `div$2`, `div$3`. Inserting another tag or editing another branch
does not renumber them. Adding an earlier unnamed sibling with the same name
can change a positional path; static names keep their paths. Names retain
case. Punctuation is escaped as a dollar sign, its hex code, and a closing
dollar sign (`Menu.Root` becomes `Menu$2e$Root`). The names `target`, `fingerprint`,
`constructor`, `prototype`, and `__proto__` are prefixed with `$`.

For example, Chat's message body is `chat.parts.Message.article.body` and
AI's picker option is `ai.parts.Picker.Menu$2e$Root.Menu$2e$Content.Menu$2e$Item`.

Commit the generated `_generated/components.d.ts` next to the client entry.
Export actions from the contributing plugin's client entry:

```tsx
import { after } from "@tokamak/sdk/client";
import * as ai from "plugin:ai/client";

export const Profile = after(ai.parts.Picker.Menu$2e$Root.Menu$2e$Content.Menu$2e$Item, ProfileColumn);
```

`before` and `after` render siblings. `prepend` and `append` render inside
elements that accept children. `wrap` receives the element as `props.children`.
`replace` substitutes another element; `hide` also removes the sibling
additions. `replace` and `hide` dispose the original element and its
descendants while active. Actions and their live `when` option receive the
props of the render function that owns the tag. Parts inside an inline list
callback get `props.$row.item` and `props.$row.index`, typed as Solid passes
them to that callback. Nested rows expose the enclosing row as `$row.parent`.
With `Index` (or Solid 2’s `For keyed={false}`), the item is an accessor and
the index is a number. Layers at one position are
ordered by `order` (default 0) and then plugin ID. The first installed
replacement owns the position even while its condition is false.

If an installed plugin targets a path that is renamed or removed, the build
warns with the contributing plugin's ID. The window also warns once per
add-on and path when a missing or changed target is skipped.

Only positional segments add to a fingerprint: a shared tag or component
name disambiguated by position. A path's fingerprint chains every positional
segment from its render scope down, so a named part under a positional
ancestor is still protected. A static `data-part` or `id`, or a name unique
among its siblings, adds nothing. Paths with no positional segment carry no
fingerprint and are never skipped for a fingerprint mismatch.

A positional segment hashes the tag, the attributes `role`, `type`, `name`,
`for` and `href` (each by its static string value or as "an expression"),
and any `aria-*` attribute that has a static string value. It ignores every
other attribute, including `class`, `style`, `data-*`, computed `aria-*`,
event handlers, `ref`, spread attributes, and the source text of
expressions. If two positional siblings
still have the same identity, the add-on build warns that the target is
ambiguous and asks the owner for a `data-part` or `id`.

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
