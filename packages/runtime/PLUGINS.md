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
`@plugins/other` spelling is an alias). Dependencies load before factories run.
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
Plain exports add no contributions. `ui:false` and `backend:false` support
logic-only and UI-only artifacts. Plugin CSS is optional; the host document
uses its own shell HTML. `standalone:true` retains complete native documents
for the desktop, lab and old raw-bundle regression harnesses.

## Stream and lifecycle

The shell sends `{type:"plugins",id}` on its connected session. The response is an 8192-byte UTF-8 JSON text page: `{revision,text,next,done}`.
Continue with `{type:"pluginspage",id,revision,offset:next}` until `done`; the SDK
assembles `{revision,plugins,functions}` and rejects mixed revisions. No UI assets are fetched at
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
loader retires affected modules plus transitive importers, including in-flight
loads. Unrelated completed modules remain live. Version checks prevent stale
asset promises from publishing. Factories own disposable Solid roots;
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

Requests and individual events share the WebSocket's 1 MiB UTF-8 limit. The
native event queue still holds at most 256 events / 1 MiB in total. Oversized
results become a correlated `result too large` error; an oversized subscription
ends only that subscription. Oversized requests are rejected before admission,
so unrelated calls and the window connection remain usable.
