# How Tokamak works, end to end

This file explains the runtime and "sync" in plain terms. It shows how a click in the desktop window turns into data in the database and back into pixels. Read this first. The detailed docs it links to come next.

Each part below is marked as **built** (on `dev`), **on a branch** (built, not merged yet), or **planned** (designed, not built).

## The one-sentence version

**The Tokamak server is a database (SurrealDB, embedded) plus our own runtime that runs plugin code (QuickJS) next to it, plus a layer that knows which screens need which data.** The desktop is a thin window that draws the UI and asks the server for everything.

It's the same idea as Convex: Convex is "their database + a V8 runtime + live sync". Tokamak is "SurrealDB + a QuickJS runtime + live sync", in one ~40 MB binary you run yourself.

## The pieces and who owns what

```
┌──────────────── desktop app (tokamak-desktop, ~12 MB) ────────────────┐
│  Blitz          draws HTML/CSS natively (no browser, no webview)      │
│  QuickJS (UI)   runs the shell + plugin UI (Solid components)         │
│  SDK client     useQuery / useMutation; talks to the server           │
│  NO database. Nothing is stored here.                                 │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ WebSocket (local, token-protected)
┌───────────────────────────────▼───────────────────────────────────────┐
│ server (tokamak, ~40 MB)   ← the owner of everything below            │
│                                                                       │
│  websocket.rs    receives requests, sends responses + live updates    │
│  service.rs      the Coordinator: runs queries/mutations ONE AT A     │
│                  TIME, in order, and refreshes subscriptions          │
│  plugins.rs      loads plugins, checks dependencies and exports       │
│  host.rs         what a plugin function may do (db, call plugins…)    │
│  engine (pkg)    QuickJS: actually executes the plugin's JS function  │
│  data/           SurrealDB behind a "Store" boundary; tracks what     │
│                  each query read and what each write changed          │
└───────────────────────────────────────────────────────────────────────┘
```

* **Plugins** are TypeScript. Their **backend functions** run in the server's QuickJS, and their **UI** runs in the desktop's QuickJS. Both halves are downloaded from the server.
* **SurrealDB** is a library inside the server process, not a separate service. Its files live on disk (SurrealKV).
* Plugins never write database queries. They call `ctx.db.get / query / insert / patch / delete`, and the server turns those into database operations. All SurrealQL stays inside `data/`.

## Three kinds of backend function

| Kind | Can | Can't | Status |
|---|---|---|---|
| `query` | read data | write, use the network | built |
| `mutation` | read + write, all-or-nothing (one transaction) | use the network | built |
| `action` | network (`fetch`), AI (Vercel AI SDK), long waits | touch the database directly; it calls queries and mutations instead | built (TKM-45) |

Queries and mutations are **deterministic**. Inside one call the clock is frozen and `Math.random` is seeded. So a mutation that's retried after a conflict, or replayed later for offline sync, does exactly the same thing. Actions see the real clock.

## Flow 1: a live query (`useQuery`)

```
UI:  const todos = useQuery(api.todo.list)

1  desktop → server   "subscribe to todo/list"
2  Coordinator        runs todo.list in QuickJS
3  data/              while it runs, records WHAT it read:
                        e.g. (todo/items, all rows)  or  (todo/items, id = 5)
4  server → desktop   the result
5  UI                 Solid re-renders with it
```

The subscription stays open. The server remembers "this screen depends on (todo/items, …)".

## Flow 2: a write (`useMutation`)

```
UI:  setDone({ id: 5, done: true })

1  desktop → server   "run todo/setDone"
2  Coordinator        opens a transaction, runs setDone in QuickJS
3  data/              commits; produces a FOOTPRINT: what changed
                        e.g. (todo/items, id = 5)
4  Coordinator        finds every open subscription whose recorded reads
                      overlap that footprint, and re-runs ONLY those
5  server → desktop   new results for those subscriptions (every window,
                      every device connected to this server)
```

**This is all the "sync" there is today.** It's not two databases syncing. There's one database on the server, and every window is a live view of it. Two windows, or later your phone, stay in step because they're all subscribed to the same server.

Precision matters. A write to thread A doesn't re-run a screen showing thread B. Invalidation is keyed by `(table, equality key)`, not by whole tables (TKM-42). If the change feed falls behind, the server plays safe and refreshes everything.

If two mutations collide, the loser is thrown away and **re-run from scratch** with the same frozen clock and seed. That's why mutations must be deterministic.

## Flow 3: AI (actions)

```
action: summarize
  ├─ ctx.runQuery(...)        read what it needs (separate short transaction)
  ├─ streamText(...)          talk to the model over fetch (needs net:<host>)
  │     tokens ─► (planned) live channel to the screen, NOT the database
  └─ ctx.runMutation(...)     save the result (separate short transaction)
```

Actions run on their **own lane**, so a 2-minute AI call never blocks your todos. They never hold a database transaction open.

## Plugins calling plugins

Plugin A can call plugin B only through the functions B lists in its `exports` file. The call joins A's transaction, so if A fails afterwards, B's writes are undone too. Plugins never read each other's tables.

## What's planned (designed, not built)

* **Core threads** (TKM-46/47): threads, items, runs and an inbox, built on the flows above. Token streaming uses an in-memory channel, and the finished text is saved once.
* **Pagination** (planned): a `paginate()` helper for queries and a `usePaginatedQuery` hook with Convex-style **reactive pagination**. Each loaded page is its own live subscription with a fixed boundary, so pages stay stable while data changes. Long lists and long threads need this.
* **Hub and runner** (TKM-49): the same server binary in two roles. The hub is the source of truth, anywhere. The runner sits on your Mac for local work (files, Claude Code).
* **Offline "hybrid" sync** (TKM-50): a runner keeps a local copy of some tables. When offline, mutations run locally and are recorded. On reconnect, the hub **re-runs the same mutations** against the real data. This is why mutations are deterministic and why plugins write intents (`setDone(true)`), not toggles.

## So, in one line

We're building **our own runtime that sits on the database**: SurrealDB stores, QuickJS runs plugin code, and the server tracks which reads each screen depends on so it can push updates when writes touch them. Everything else (Core threads, AI, plugins, the desktop) is built on top of those three flows.

## Further reading

* `packages/server/README.md`: server CLI, local mode, lifecycle.
* `packages/server/PLUGINS.md`: plugin manifests, dependencies, exports, reload.
* `packages/server/src/data/README.md`: the Store boundary and invalidation.
* `packages/runtime/ROUTING.md`: window routing.
* `packages/runtime/PLUGINS.md`: the desktop plugin loader (paged catalog, lazy UI, hot reload).
* `packages/engine/WEB_APIS.md`: the web APIs that actions get.
