# Per-window plugin UI host

`app/src/main.tsx` mounts exactly one document and provides module namespaces to
`ModuleRegistry`. Host names are `solid-js`, `solid-js/universal`,
`@tokamak/render` (without `mount`), `@tokamak/sdk`, `@tokamak/sdk/solid`,
`@tokamak/ui`, `@tokamak/ui/elements`, `@tokamak/ui/components`, and
`@tokamak/runtime/router`. Plugins use `useClient()` and `useRouter()` from the
shared Solid contexts. Neither the connection nor history belongs to a plugin.

## Build contract

The default `tokamak()` build compiles `src/main.tsx` into a single CommonJS
factory wrapped in:

```js
globalThis.__tokamakModules.register("@plugins/todo/ui", ["@tokamak/render", "@tokamak/sdk"],
  function(require, exports, module) { /* plugin code */ });
```

Host packages and `@plugins/*` stay external. A plugin can import another's
ordinary exports with `import { Component } from "@plugins/other/ui"` (the bare
`@plugins/other` spelling is an alias). Static dependencies load before factories run. Literal dynamic imports, such as
`import("@plugins/other/ui")`, compile to the evaluation-scoped
`__tokamakModules.load(...)` capability. They infer `optional[other] = "*"`
(unless already required), keeping installation and UI loading lazy. Computed
`import(expr)` is rejected because the compiler cannot prove its target namespace.
Configure TypeScript paths to the other plugin's source or declarations when
checking cross-plugin imports locally; the bundle keeps the module name external.
The compiler rejects bundled host runtimes and browser runtime imports. Plugins
never mount, create a native connection, or access browser globals.

SDK helpers return the supplied callable with a contribution brand. The compiler
resolves exported aliases/reexports through TypeScript's symbol graph, extracts
literal options without running UI code, and uses public export names as IDs:

```json
{
  "plugin": {
    "id": "todo", "version": "0.1.0", "depends": {},
    "contributes": { "view": [{ "id": "Todo", "route": "/" }] }
  },
  "entries": { "ui": { "code": "ui.js", "map": "ui.js.map", "css": "styles.css", "shell": "shell.html" } }
}
```

Other kinds use `itemRenderer: [{id,type}]`, `toolbar: [{id,label}]`,
`command: [{id,title}]`, and `entityCard: [{id,table}]`. Computed options,
spreads, and nonliteral values fail the build. Runtime imports of
`@plugins/<id>` infer a `depends[id]` range of `*` unless explicitly constrained.
Type-only imports/reexports disappear before dependency and contribution
inference; the emitted JS graph and TypeScript's emitted export syntax are the
sources of truth. Plain exports add no contributions. `ui:false` and `backend:false` support
logic-only and UI-only artifacts. Plugin CSS is optional; the host document
uses its own shell HTML. `standalone:true` retains complete native documents
for the desktop, lab and old raw-bundle regression harnesses.

## Stream and lifecycle

Tokamak has **no product limits**. Installed plugins, contributions, dependencies,
capability lists and descriptor strings have no arbitrary count/length quotas.
Identifier syntax, nonempty/unique capabilities and version compatibility remain
validation rules. Catalog and UI asset transfers have no total-size ceilings;
8 KiB pages keep each event below the wire budget. The SDK joins chunks once
when complete. UI source is compiled as a whole by QuickJS after transfer, so
compilation still needs memory proportional to the module. The desktop window
heap has no fixed quota (the former 64 MiB ceiling is removed); system allocation
failures remain possible. Backend code/maps have a separate 512 MiB whole-input safety exception; see
[the server contract](../server/PLUGINS.md#loading-and-reload-contract).

Catalog manifests use indexed identity lookup. Module retirement builds reverse
edges and walks affected importers once, including static imports that have not
yet loaded. The rail shares one memoized view list and active-route lookup;
rendering N buttons does not repeatedly enumerate N manifests. There is no rail
entry ceiling or eager module fetch per button.

The shell sends `{type:"plugins",id}` on its connected session. The response is an 8192-byte UTF-8 JSON text page: `{revision,text,next,done}`.
Continue with `{type:"pluginspage",id,revision,offset:next}` until `done`; the SDK
assembles `{revision,plugins,functions}` and discards mixed revisions, including
a mismatched revision in the assembled catalog. Stale-page errors restart the
transfer from its first page, with at most three attempts before rejecting. No UI assets are fetched at
connect. A contribution's first render calls the loader. Code/CSS requests are
`{type:"pluginasset",id,plugin,name,revision,offset}`; responses are
`{text,next,done}` in the usual `response.result.Ok` envelope. Offsets count
UTF-8 bytes. Chunks are at most 8192 bytes before JSON encoding, keeping even
escaped text inside the native 1 MiB event limit. The server refuses a stale
catalog revision, undeclared files and invalid offsets.

After an atomic server reload, every connected session receives
`{type:"pluginchanged",plugins:[changedIds],catalog:{revision,paged:true}}` on the same ordered stream
as data updates. The loader fetches the new catalog in bounded pages before
retiring affected owners, accumulating ids if reloads race. The server compares the entire old/new catalogs, so one reload
also reports other edited/added/removed artifacts in that installation. The
loader also diffs the assembled old/new manifests. If the changed-id list would
exceed one event, the notification omits that list; the paged catalog diff still
retires every affected module. The loader retires transitive importers and in-flight
loads. Unrelated completed modules remain live. Version checks prevent stale
asset promises from publishing. Factories receive a frozen registration/loading capability scoped to their own
module and generation; host `provide`, `remove` and `require` APIs are never
published. Retired handles cannot register or load modules. Factories own disposable Solid roots;
contribution owners reset at the same generation boundary. Future renders load
fresh modules lazily.

The window-owned query cache keeps the underlying data subscription while UI
owners remount, replays its latest value, and closes everything at window
retirement. It retains at most 128 distinct queries and evicts dormant entries
when full. Permission declarations remain server-auto-granted; there is no
permission screen or grant prompt.

## Presentation handoff

`ShellFrame` in `app/src/shell-frame.tsx` is presentation only. Its JSX slots are
`rail`, `navigation`, `sidebar?`, `stage`, and `thread?`. The `.shell-*` CSS in
`app/src/styles.css` can be replaced without changing module loading.

`Shell` in `app/src/shell.tsx` owns one `/chat` memory history, handles
`/chat/:thread`, and maps view-local routes beneath `/p/<plugin>`. The docked
thread panel is a placeholder. Navigation buttons use real back/forward.

`Contribution` in `app/src/contribution.tsx` accepts `loader`, a
`SlotContribution`, and optional `componentProps`; it supplies loading and
`<plugin> failed · Reload` states around one plugin part. The loader's
`contributions(kind)` enumerates all five slot kinds without fetching modules.
Views mount in the stage now; future item, toolbar, entity and command surfaces
can select descriptors and reuse the same boundary/lifecycle plumbing.

Native event and host callbacks capture their Solid owner at registration.
QuickJS promise hooks propagate that ownership through async/await, and report
unhandled rejections after promise jobs settle so normal catches still work.
Factory effects have a separate module-owned error scope; the registry forwards
those failures by module id to mounted consumers, including transitive importers.
Retired scopes ignore late failures. No attribution depends on whichever view is
active when an error arrives.

The error card uses a flex formatting context: Blitz's inline formatting hit
test can return the anonymous parent box at an inline button's centre. Flex gives
the Reload button a separate box while keeping the existing card classes.

Requests and individual events share the WebSocket's 1 MiB UTF-8 limit. The
native event queue holds at most 256 events / 1 MiB of wire payloads, plus
bounded topic/routing envelopes (at most 1560 bytes per event). The inclusive
1 MiB boundary applies to serialized wire JSON, excluding native envelopes. Oversized
results become a correlated `result too large` error; an oversized subscription
ends only that subscription. Oversized requests are rejected before admission,
so unrelated calls and the window connection remain usable.
