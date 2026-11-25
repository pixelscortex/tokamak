# @tokamak/sdk (POC)

The portable authoring/client layer between TypeScript features and the native
host. `src/` uses ES2022 only. `tools/` runs on the pinned Bun 1.4.4 build machine,
not in QuickJS. There is no SDK CLI and no runtime dependency.

## Author a feature

A feature folder contains `schema.ts` (default schema export, optional) and
TypeScript modules exporting query, mutation or action definitions. Bind builders to the
schema for table, document and filter types:

```ts
// schema.ts
import { defineSchema, defineTable, v } from "@tokamak/sdk";
export default defineSchema({
  notes: defineTable({ text: v.string(), done: v.boolean() }),
});
```

```ts
// notes.ts
import { createFunctions, v } from "@tokamak/sdk";
import schema from "./schema";
const { query, mutation } = createFunctions(schema);

export const list = query({
  args: { done: v.boolean() },
  handler: (ctx, { done }) => ctx.db.query("notes").where("done", "=", done).order("desc").collect(),
});
export const add = mutation({
  args: { text: v.string() },
  handler: (ctx, { text }) => ctx.db.insert("notes", { text, done: false }),
});
```

Direct `query` and `mutation` exports also work without schema-bound table
checking. Validators infer handler/client argument types; arguments default to
an empty, strict object. `v` supports string, finite number, boolean, null,
literal, id, array, object, optional object fields, union, and any JSON value.
Validation runs before the handler and names the failing argument path.

Queries have a read-only `ctx.db` at both the type and runtime levels. Mutations
also have `insert`, `patch`, `replace`, `delete`. Writes return IDs (insert) or
null (other writes). `get(id)` returns a document or null. Query builders are
immutable, use repeated `.where(field, '=', value)` for equality AND, order by
creation time with `.order('asc' | 'desc')` (default asc), and execute only with
`take(n)`, `first()` or `collect()`. There is no SQL expression, pagination,
or implicit thenable.

Declare indexes on tables before loading the plugin:

```ts
const schema = defineSchema({
  notes: defineTable({ owner: v.string(), text: v.string(), created: v.number() })
    .index("by_owner_created", ["owner", "created"])
    .unique("by_owner_text", ["owner", "text"]),
});
const { query } = createFunctions(schema);
const recent = query({
  args: { owner: v.string(), since: v.number() },
  handler: (ctx, { owner, since }) =>
    ctx.db
      .query("notes")
      .withIndex("by_owner_created", (q) => q.eq("owner", owner).gt("created", since))
      .order("desc")
      .take(20),
});
```

Index names and indexed fields must match `[A-Za-z_][A-Za-z0-9_]*`. Fields must
be declared top-level fields, nonempty and distinct; names are unique per table.
Table builders are immutable, so keep the returned value when adding an index.
Schema-bound queries check index names, field order and value types in TypeScript
and validate the range builder at runtime. Equalities consume leading index
fields in order. A range constrains the next field and ends the equality chain;
it may have one lower (`gt`/`gte`) and one upper (`lt`/`lte`) bound on that same
field. The callback can be omitted to scan the entire index. Indexed queries
cannot combine with `where`. Ordering follows index fields then ID; the default
is ascending. Indexed scans have the native `u32::MAX` row ceiling. Live indexed
queries conservatively invalidate whenever their table changes.

The loader installs ordinary and unique indexes in the plugin's data space.
Unique violations reject the host operation with the index name and abort the
invocation even if caught in JS. Reloading identical definitions is a no-op.
The server fills new and changed indexes from existing rows and removes indexes
that are no longer declared. Rows are preserved. If existing rows violate a new
unique index, the server reports the index and conflicting value. A failed reload keeps
the old version installed. At startup the server skips the affected plugin and
plugins that require it.

Limits, checked at declaration and again by the server at load: 256 tables per
plugin, 32 indexes per table, 16 fields per index, 64 characters per table or
index name.
Field descriptions provide types and metadata; field validation on persisted
writes and schema migrations remain deferred.

## Actions

`action({...})` (also returned by `createFunctions`) runs separately from
queries and mutations. See [Plugin process and action process](#plugin-process-and-action-process)
for action process budgets. Actions keep the real clock and randomness. They
have no `ctx.db`: each `ctx.runQuery` or `ctx.runMutation`
call rejoins the serialized coordinator and owns its own transaction. The action
itself is never retried; external effects and earlier mutations remain after a
later failure. Queries and mutations cannot call actions or fetch.

```ts
import type {} from "@tokamak/sdk/web";
import { action } from "@tokamak/sdk";
import { api } from "./_generated/api";

export const sync = action({
  handler: async (ctx) => {
    const response = await fetch("https://example.com/data");
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
    return ctx.runMutation(api.records.save, { value: await response.json() });
  },
});
// From a client: await client.action(api.jobs.sync, {});
```

Declare `permissions: ['net:example.com']` in the plugin definition. Grants use
the canonical URL hostname, omit the port, and are checked on every request and
redirect. Legacy bundles receive no network grants. Nested cross-plugin calls
check declared dependencies and exports. Reload cancels old-generation actions, and explicit
server shutdown cancels busy JS, pending timers and HTTP I/O. Disconnect alone
does not retract an accepted action; its outcome can be unknown.

The optional **type-only** `@tokamak/sdk/web` entry supplies standard web
authoring declarations for action code and browser-targeted dependencies. It
installs no globals and does not alter the SDK's ES2022-only source checker.
Only the runtime subset in [WEB_APIS.md](../engine/WEB_APIS.md) is implemented.
The AI SDK's published declarations additionally reference Node HTTP/Buffer and
JSON Schema types: consumers can install `@types/node` and `@types/json-schema`
as build-only dependencies, with a type-reference to Node declarations. These
types do not add a Node runtime; bundle with the browser target.

Generated `api.*` references infer the action kind and argument/result types.
Both bundled transports implement the `action` wire request. The optional
`ClientTransport.action` preserves existing custom transports; `client.action`
throws clearly when a custom transport has not implemented it.

## Internal functions and expected failures

Use `internalQuery`, `internalMutation` or `internalAction` for a function only
your plugin's server code can call. The same builders are available from
`createFunctions(schema)`. Import its reference from `_generated/internal`.
Queries can run nested queries; mutations can run nested queries and mutations
within the same transaction. Actions can also call `ctx.runAction`.

```ts
import { action, fail, internalQuery, v } from "@tokamak/sdk";
import { internal } from "./_generated/internal";

export const checkTitle = internalQuery({
  args: { title: v.string() },
  handler: (_, { title }) => (title.length > 200 ? fail("TooLong", { max: 200 }) : { title }),
});

export const previewTitle = action({
  args: { title: v.string() },
  handler: (ctx, args) => ctx.runQuery(internal.titles.checkTitle, args),
});
```

The action's caller receives the inferred result. For an object success like
`{ title }`, `if (result.failed && result.kind === "TooLong")` narrows to the
failure and makes `result.data.max` a number. Use `isFailure(result)` from
`@tokamak/sdk` to distinguish failures from any success, including a string or
`null`. A mutation that returns `fail` rolls back its writes and still returns
the typed failure. If a nested `ctx.runMutation` returns `fail`, only that
callee's writes roll back. The caller can handle it and commit its own writes,
or return the failure to roll back the caller's writes too. Actions are not
transactional: returning `fail` from an action does not undo mutations it
already called. Throw for unexpected errors.

## Local functions

`local({ args, handler })` runs in the client's local part. Put it
under the plugin's `src/`; it can share a module with server functions.
The plugin build emits its own `local.js` and a typed reference in the
generated `api`. The desktop client uses the matching plugin build installed
on the computer. A browser without the desktop client cannot run it.

```ts
import { local } from "@tokamak/sdk";
import { api } from "./_generated/api";

export const collect = local({
  handler: async (ctx) => {
    const program = ctx.proc(["git", "status", "--short"], { cwd: "/path/to/repo" });
    for await (const text of program.stdout) {
      await ctx.runMutation(api.records.save, { text });
    }
    return await program.exited;
  },
});
// From the window: await client.local(api.jobs.collect, {});
```

`client.hasLocal` is true when the window has a local part (the desktop
client); in a plain browser `client.local` throws, so check it first when local
work is optional.

`ctx.proc` starts an executable directly. Its `stdout` and `stderr` yield
one line at a time. Use `write` and `closeInput` for stdin and `stop` to send
a signal. The invocation stays alive until the handler settles. To cancel
from the window, pass `{ signal }` to `client.local`; the plugin process stops programs
still running for that invocation. Use `node:fs/promises` for local files.

**Await the programs you need finished before returning.** Any
call (including a routed contract method) can return while its unawaited
programs are still being reaped. These programs still count toward the host's
256-program limit. Normal cleanup sends TERM and gives a live process group
up to two seconds before sending KILL.

Use `ctx.withPrograms(async (forceStop, scoped) => { … })` to group programs
started through `scoped.proc` and providers selected with `scoped`. Calling
`forceStop()` ends those process groups without cancelling the invocation
or its other programs. `withPrograms` can return while the scope
is still being reaped. Force stop sends KILL immediately, including to groups
already in their TERM grace. Use `contract.list(ctx)` or `contract.get(id, ctx)` in
local functions and server actions so the lookup follows the caller across awaits.
Queries and mutations still use `contract.list()` and `contract.get(id)`.

Local functions have no database context. Use `ctx.runQuery`,
`ctx.runMutation`, or `ctx.runAction` with references from the public `api` to
call the connected server. Only server functions can use `_generated/internal`.

## Build and consume typed references

From the workspace, with a feature folder path relative to the workspace root:

```sh
moon run sdk:check
moon run sdk:build
moon run sdk:bundle -- packages/server/demo/feature
```

The bundle task writes:

- `FEATURE/dist/bundle.js`: one self-contained ESM module.
- `FEATURE/dist/bundle.js.map`: linked source map with source contents.
- `FEATURE/dist/transactions.js` and its map: the companion for the QuickJS action process.
  It contains queries, mutations and inspection metadata.
- `FEATURE/_generated/api.ts`: typed public references.
- `FEATURE/_generated/internal.ts`: references for the plugin's server code.

Discovery includes `.ts` modules recursively, excluding `schema.ts`, declarations,
`.test.ts`/`.spec.ts`, `tests/`, `dist/`, `node_modules/` and paths beginning with
`_` or `.`. Imported helpers in excluded folders still bundle normally; they are
not independent function modules. Use a backend-only feature folder. Module
path collisions (`a.ts` with `a/b.ts`) fail rather than produce ambiguous APIs.
Generated references need feature source types available to the type checker;
they do not import server code at runtime. Commit both files and regenerate
them when functions change.

The bundle checker inherits the feature's resolution options unchanged, including
`paths` aliases inherited from another config (relative to the declaring config).
With the default workspace config, use extensionless TypeScript imports such as
`./schema`, not `./schema.ts`; the bundle task does not add a build-only
`allowImportingTsExtensions` opt-in. If a feature explicitly opts in or uses
aliases, consumers of its generated API must share those compiler settings,
because checking the references also checks the backend source types.

```ts
import { TokamakClient } from "@tokamak/sdk";
import { api } from "./_generated/api";
const client = new TokamakClient(transport); // see concrete transports below
const rows = await client.query(api.notes.list, { done: false });
const id = await client.mutation(api.notes.add, { text: "Read this" });
const stop = client.subscribe(api.notes.list, { done: false }, (event) => {
  // event is { value: typeof rows } | { error: Error }
});
stop();
```

`ClientTransport` owns connections, initial subscription delivery, ordering and
errors. The SDK snapshots arguments, checks JSON values, preserves inferred
argument/result types, and suppresses events after an idempotent unsubscribe.
An observer throwing during synchronous initial delivery deactivates the listener;
the SDK captures and calls the transport disposer before rethrowing that error.
If the transport's registration itself throws, the transport owns cleanup because
it has not returned a disposer. There is no reconnect/retry.

### Concrete transports (TKM-7)

```ts
import { TokamakClient, InProcessTransport, WebSocketTransport } from "@tokamak/sdk";
// Native host owns a server Session and implements MessageConnection: send a
// generated Request through Tower, feed its ordered Event stream to listen,
// and drop Session when close/dispose runs. No port is opened.
const embedded = new TokamakClient(new InProcessTransport(nativeConnection));
// Browser/Bun caller creates and awaits OPEN on a WebSocket itself. The SDK
// receives this structural capability rather than importing environment globals.
const remoteTransport = new WebSocketTransport(openSocket);
const remote = new TokamakClient(remoteTransport);
// All query/mutation/subscribe application code is identical for embedded/remote.
remoteTransport.close();
```

`Request` and `Event` are generated from `packages/server/src/protocol.rs` with `ts-rs`;
never edit `src/protocol.ts` manually. Regenerate/check from workspace root:

```sh
cargo run --locked -p server --features protocol-codegen --bin export-protocol
cargo run --locked -p server --features protocol-codegen --bin export-protocol -- --check
```

The WebSocket route is `/ws` on the headless runner's **loopback** listen address.
It preserves one stream for updates and call replies. Outstanding calls and
subscriptions are bounded at 128 each; safe-integer IDs are never reused.
Protocol/frame/admission/queue failures close the connection, reject all calls,
and report errors to subscriptions. A closed stream can hide a committed
mutation: never automatically retry it. Unsubscribe is idempotent; late events
are ignored. A throwing async observer is isolated so it cannot strand the
mutation reply behind its update; observers should handle their own failures.
There is no socket-open buffering, auth, TLS, reconnect or multiuser support.
Do not expose the POC publicly. See `packages/server/demo` for the two-client live demo.

## Native host integration contract

`packages/sdk/src/host.ts` is the single source for operation names and argument/result
shapes (`HostOperations`). Runtime serialization happens at the native boundary,
not through a second JSON-string envelope. The bundle exports:

- `schema`: the schema definition, or null when there is no `schema.ts`.
- `functions`: a registry keyed by `module/path:export`. Definitions expose
  `kind`, serializable `args`, and a validated `invoke`; handlers remain closed
  over, with no unchecked public handler entry point.
- `metadata`: `{ name, kind, args }[]`, inspectable without a host. `args` is a
  `ValidatorDescription`; reading metadata does not execute handlers.
- `invoke({ name, args }, host) -> Promise<JsonValue>`: dispatches through the
  same argument validator for every function. Unknown names reject. A void
  handler result becomes null, including async void; all other results must be
  JSON values. Errors reject rather than pretending to be successful data.

`host.op(name, payload)` accepts and returns plain JSON values, synchronously or
asynchronously. Bind this capability to one invocation: the native host owns
call lifetime, query read-only enforcement, transactions and commit/change
notifications. The SDK does not implement those host responsibilities.

### Record/value policy

- IDs are branded strings serialized as `table:key`. Table names match
  `[A-Za-z][A-Za-z0-9_]*`; opaque keys match `[A-Za-z0-9_-]+`. This is deliberately
  narrower than SurrealDB's full record-ID grammar; no SQL parser is in the SDK.
- Stored documents have host-owned `_id` and `_creationTime`, where the latter is
  a finite number of milliseconds since the Unix epoch. Patch/replace preserve
  both fields; authors cannot supply them in writes.
- Values are null, booleans, strings, finite numbers, dense arrays and plain
  string-keyed objects. No Date, bigint, undefined, functions, symbols, accessors,
  non-enumerable data or cycles. IDs used as fields are JSON strings, not an
  implicit SurrealDB record-link codec. Optional means an absent object key.
- Patch shallow-merges supplied keys; replace replaces user fields. There is no
  delete-field sentinel. Missing patch/replace is an error; missing get returns
  null and missing delete succeeds with null.
- All equality conditions are ANDed. Equality is structural JSON equality with
  object key order ignored. Fields are top-level literal names, not dotted paths
  or expressions. Missing fields do not equal null. Ordering is by
  `(_creationTime, _id)`, both in the requested direction; ID ties use lexical
  ASCII ordering. `limit: null` means collect all; zero means no rows.

## Why these build tools

Verified with Firecrawl docs, opensrc source retrieval, npm metadata and local
Bun 1.4.4 probes (2026-11-06):

- [Bun.Transpiler.scan](https://bun.com/docs/runtime/transpiler#scan) parses
  imports/exports without executing modules. Namespace registration plus mapped
  TS types recognizes definitions, including aliases and reexports; no
  hand-written parser or fragile initializer-pattern matching is needed.
- [Bun.build](https://bun.com/docs/bundler) provides ESM, one-file bundling,
  linked source maps and plugins. `allowUnresolved: []` rejects even opaque
  dynamic imports (verified against the pinned version's `bun-types/bun.d.ts`
  and a failing local probe); the final output must also have no imports.
- [Bun's native checker](https://bun.com/docs/runtime/check) already ships in
  1.4.4. No TypeScript/tsgo package is needed. `sdk:check` checks `src/` separately
  against `lib: ES2022`, `types: []` before checking the package/tests. This stops
  a future bun:test import from granting runtime code Bun/Node/browser globals.
  The native checker's `--listFilesOnly` graph also guards type-only imports and
  triple-slash references: dependencies must be inside `src/` or in the exact
  ES2022 library set obtained from an isolated compiler invocation. Extra ambient
  libraries (including DOM) and external declaration files are rejected.
- [Rolldown 1.3.0](https://rolldown.rs/guide/getting-started#using-the-api), released
  2026-11-05: `rolldown({ input, platform: 'neutral' }).generate({ format: 'esm',
  sourcemap: true, codeSplitting: false })` is a maintained alternative. npm
  reports 981,872 unpacked bytes plus 18,524,990 bytes for the macOS arm64 binding.
- [oxc-parser 0.157.0](https://oxc.rs/docs/guide/usage/parser), released 2026-11-02:
  `parseSync(filename, source)` exposes ESTree and ESM information; npm reports
  2,964,029 unpacked bytes plus a 1,877,726-byte macOS arm64 binding. Both oxc and
  Rolldown were retrieved through opensrc and inspected, but neither is needed
  for this build pipeline. These are package sizes, not native application size.
- [Standard Schema 1.x](https://standardschema.dev/) was evaluated, not accepted:
  its input/output transforms and async validation add a second argument-value
  model outside the requested `v` POC. No adapter dependency is installed.
- Surlvex and Convex 1.49.0 informed the function/validator/reference patterns;
  no implementation was copied. Their deployment, transport and extra function
  APIs are intentionally absent here.

The SDK changes do not link JavaScript bundles into the native binary. Native
size measurements therefore measure the inherited host only; real QuickJS and
SurrealDB integration remains for the host issues and their tests.

## Plugin process and action process

On macOS and Linux, a plugin process runs local functions and the action
process runs server actions in `tokamak-plugin-host`. Queries and mutations run
in the server's engine. On Windows, local functions and server actions report
“Plugin code is not supported on Windows yet.”

Local functions can import `node:path`, `node:os`, `node:crypto`,
`node:url`, and `node:fs/promises`. The server part cannot import Node modules. The build checks imports,
including bare names such as `path`. Unsupported imports such as `node:timers`,
`events`, or `node:path/posix` fail the build. Built-ins reached indirectly,
such as `process.getBuiltinModule`, `import.meta.require`, `process.binding`,
or `globalThis.Bun`, fail at runtime in QuickJS. Use `ctx.proc` in a local
function to run a separate program when needed.

Local functions get `process.platform` (`darwin` or `linux`), an
empty `process.versions`, and a snapshot in `process.env`. Writing to that
object does not change the environment of later programs. Pass `env` to
`ctx.proc` instead. The local host supplies global timers and fetch. It caps
the heap at 256 MiB by default, allows up to 128 calls and 256 live programs,
and interrupts JavaScript that runs for five seconds without yielding. See the
[host reference](../host/README.md) for filesystem, timers, I/O, and memory limits.

Root local calls also get `ctx.retiring`. It aborts when the window
replaces the plugin's own build. The call can still use its context to settle
work until the old connection closes. Routed provider calls do not
receive this signal.

### Server actions

All plugins’ actions run in one action process. Every action call has its own
QuickJS runtime and starts with fresh module state. Use `ctx.runQuery`,
`ctx.runMutation`, and `ctx.use` for host-mediated data and plugin calls;
`ctx.signal` observes cancellation. There is no `process` or `process.env`;
use `await ctx.env(name)` and declare `env:<name>`. Declare `net:<hostname>`
for every host you fetch from. Actions have the engine's web APIs, including
global timers and [fetch](../engine/WEB_APIS.md). See the host reference for
wall and CPU deadlines. The action process supplies no local file or program
capabilities.

The server runs up to 64 signed-in calls per plugin and 128 total, with no
queue. Anonymous sign-in counts toward the total and has four slots across all
plugins outside the per-plugin limit; a fifth request is refused as busy.

The default QuickJS heap limit is 64 MiB per call. The process-wide worst case
is 128 times that limit (8 GiB by default), if every call fills its heap. The
Linux allocator may keep some freed memory per thread. Every call compiles its
action bundle again, as the server's engine did for default actions. In a
release build on an Apple M4 Pro, 100 sequential calls took 0.569 s with a
trivial bundle and 12.343 s with a 1.30 MB bundle of 9,976 distinct functions
(5.69 and 123.43 ms per call, respectively). Compilation counts toward the
one-second default sign-in budget.

At each startup, the plugin host evaluates each plugin's action bundle once in
a separate process with no permissions, no network and no host operations. A
bundle that needs network access to load fails this check.

Queries, mutations, and the top-level code of modules they import, including
modules shared with actions, still run in the server. Action definitions,
helpers, and imports used only by actions are not loaded by the server. The
server trusts the action process to identify which call owns each host
operation. A memory-safety bug in QuickJS could expose other plugins' network
permissions and in-flight calls in the action process. The server itself does
not run those actions. See [Plugin host](../host/README.md#action-process)
for deadlines, limits, and recovery.

## Web client entries

`@tokamak/sdk` keeps the portable transport, function references, and plugin API.
`@tokamak/sdk/solid` supplies `useQuery`, `ClientContext`, and `useClient` for
Solid 2. Provide the connected client with `<ClientContext value={client}>`.
Reactive query argument changes unsubscribe the old query; owner disposal
unsubscribes the current query.

`@tokamak/sdk/client` supplies components and their extension actions, window
state, and shortcut and region helpers.
These entries use Solid 2.0.0 and `@solidjs/web` 2.0.0. They do not mount the app,
open sockets, or implement plugin module loading.

`state(initial, { keep: "me" })` loads the signed-in user's saved value once.
Edits show immediately and save after that load succeeds. Use a pure updater
such as `pins.set(previous => [...previous, pin])` to extend a saved value:
the updater may run again against the stored value. Passing a value to `set`
replaces it.

## Component actions

Export a `component(name, options, render)` from your plugin's window API to
give other plugins named JSX elements they can extend. The builder publishes
typed paths using `ComponentParts`, so an action can target a path such as
`chat.Composer.sendButton` and receive the owner's props.

Use `before` and `after` for siblings, `prepend` and `append` for children,
`wrap` to surround an element, `replace` to substitute another element, or
`hide` to remove it. A named native element can accept a `PartAdditions`
callback to place the prepended and appended children explicitly.
See the [builder guide](../build/README.md#extending-a-component) for examples
and the rules for naming, ordering, and locking elements.

## Caller identity

Queries, mutations and actions receive `ctx.auth.user` (`id`, `name`, and
`role`: `owner`, `admin`, or `member`) and `ctx.auth.device` (`id` and
`name`). Nested calls keep the same caller on signed-in requests. Before
sign-in, an `auth.method` action and its nested calls are anonymous:
`ctx.auth` throws, and nested calls can only access private queries and mutations
of that provider. On the QuickJS action process, the short sign-in
time budget includes starting the call's QuickJS runtime and evaluating the bundle.

In a window component, call `auth.me()` during setup. It returns a live object
with `id`, `name`, `role`, and `device`. Read the fields in reactive code so they
update in place. The fields suspend until identity loads.

```tsx
import { auth } from "@tokamak/sdk/client";
import { Loading } from "@solidjs/web";

function AccountName() {
  const me = auth.me();
  return (
    <Loading fallback="Loading…">
      <span>{me.name}</span>
    </Loading>
  );
}
```

The core provides identity even without any installed plugins. A local
server supplies the owner automatically and uses the computer's name for
the device.

### Call notes

Queries, mutations, actions and local functions receive a read-only
`ctx.call` with `user`, `device`, `depth`, and an optional `threadId`.
Anonymous calls have `null` for `user` and `device`; `ctx.auth` behaves
as before.

A root call starts at depth zero. Each nested call adds one,
and attempts to go past depth 15 fail with the target plugin and function
in the error. The first call in the chain with a validated
`v.id("threads")` argument whose value is a qualified `chat/threads:…` ID
sets the thread for its descendants. The argument can be inside an object
or array and can have any name. An ordinary string that looks like a thread
ID does not set it. If multiple typed IDs occur in one call, object fields
are visited in key order and arrays in element order.

The Runner preserves the note across routed local contracts and when a
local function calls a server query, mutation, or action through the window.
The server uses the window's authenticated identity and advances the depth.
A typed thread ID in the local function's own arguments carries into its
server calls when no earlier call set the thread.

### Membership hooks

Plugins with `depends: ["auth"]` can export a server hook to react when a
shared server adds or removes a member:

```ts
import { onMember } from "@tokamak/sdk";
import * as auth from "plugin:auth/contracts";

export const cleanup = onMember(auth.memberRemoved, async (ctx, member) => {
  // Use member.id to find data that belongs to the removed member.
});
```

`auth.memberAdded` has the same signature. Hooks run as private mutations
after the membership change takes effect. Use the event's `{ id, name, role }`
to identify the member; there is no caller or device. For a schema-typed
handler, use `provide(auth.memberRemoved, { run: internalMutation(...) })`
with `memberFields` as its arguments and return `null`. Hooks run on currently
loaded plugins; a failed hook is logged and does not undo a membership change.

A sign-in plugin that implements `auth.method.createAccount` must also clean
up the account by `member.id` in `auth.memberRemoved`. If the core cannot save
the member binding, it runs only that provider's cleanup with the unused ID.

## Views in the shell

Export `view({ route, title, icon }, render)` to declare a page. The route is
a literal; the optional title and icon can be literals or `const` strings.
Use one single-colour SVG path in a 24 × 24 box for the icon shown in the rail,
tabs and search. To expose elements, use a `component` inside the page.
Inside a view, `Region.Sidebar`, `Region.Header` and `Region.Panel`
place content in the shell, and `usePageTitle(() => title)` names the page for
its tab and the window title while the view is mounted.

### Quitting with work in progress

When the person quits the desktop app, it asks every check registered with
`onQuit` from `@tokamak/sdk/client`. A check that answers a blocker makes the
app ask first ("Claude is still working in 1 thread · Stop and quit ·
Cancel"); Stop and quit runs each blocker's `stop` before the app closes. A
check that throws or takes over 2 seconds blocks nothing. The app reads the
answers with `quitBlockers()`.

```ts
import { onQuit } from "@tokamak/sdk/client";
const remove = onQuit(async () => {
  const turns = await running();
  return turns.length ? { message: "Claude is still working in 1 thread", stop: stopAll } : undefined;
});
```

`within(promise, ms)` from `@tokamak/sdk` waits at most `ms` and resolves
`TIMED_OUT` when the time is up (window and local code; server functions have no timers).

### Typed contracts between plugins

Define a contract in `src/contracts.ts`. The defining plugin can discover and
choose providers without depending on them:

```ts
import { contract } from "@tokamak/sdk";

export const agent = contract<{
  id: string;
  name: string;
  start: (run: { report(text: string): void }) => Promise<void>;
}>("agent", { place: "local" });
```

A provider declares the defining plugin in `depends` or `optional` in
`plugin.ts`. Export the registration from any function source file:

```ts
import { provide } from "@tokamak/sdk";
import { agent } from "plugin:ai/contracts";

export default provide(agent, {
  id: "example",
  name: "Example",
  start: async (run) => {
    run.report("Started");
  },
});
```

In a local function or server action belonging to the defining plugin, pass
the handler's `ctx`: call `await agent.list(ctx)`, `await agent.get(id, ctx)`
(returns `undefined` when absent), or `await agent.get(id, ctx).start(run)`
for a required method. Queries and mutations leave `ctx` out. Use the awaited
provider to read data or check optional methods. Lookups use the current
catalog. An explicit
implementation `id` is the selection key; otherwise the plugin id is used.

A local contract is called from `local`. Declare
`{ place: "local", dataMethods: true }`. The Runner routes every call
to the provider's process, reusing the caller's host when the provider is the
same plugin. Lookups read provider data
and available method names from that process. Keep the fields static for a
build; the caller can reuse them after a process restarts. Arguments and
results must be plain JSON. A value JSON would change or lose fails with the
contract and method name. Size and nesting limits apply, and a void result
becomes `null` across processes.

Pass `{ signal }` to a local contract lookup to cancel its pending routed
calls without ending the caller's invocation. A method that accepts one object
can also take that same signal as `input.signal`. QuickJS sends only the other
fields and assigns the provider invocation's signal to `input.signal` before
calling the regular `local({ handler })` definition. If the live input uses a different signal than the
routed call, use `inputSignal` to identify the value to keep off the wire.
A provider can use `{ unavailable: "…" }` in
`provide()` to supply a notice for the lookup's `onUnavailable` callback even
when its process cannot start; errors thrown by the handler still reject.

The plugin build rejects local contracts without `dataMethods: true`, including
old declarations that mark only some methods as data. QuickJS also refuses
older built plugins that declare live methods.

Turn hook authors declare a regular `local({ handler })` and read
`turn.signal`. The SDK attaches the hook invocation's signal
as described above. Stop cancels the before hook; after hooks run together
under one deadline and are also cancelled if the turn is lost. Code stores
the before snapshot under a Git ref scoped to the thread and turn ID, so a
replacement Code process can pair it with the after snapshot.

Use `local({ handler: (ctx, run: Run) => ... })` when a method needs local context
such as `ctx.proc`. Declare it as a private constant and pass it to `provide`.
All local methods receive the calling member and device in their context. A
matching provider build must be installed on the client.

The `ai` agent contract uses the author's `start(ctx, run)` API. The provider SDK builds the `Run` in the agent's plugin process.
`run.text` and other reports are batched, `run.ask` waits for the sender's
answer, and `run.onSteer` and `run.onStop` register handlers in that host.
CLI programs opened by the agent's `ctx.proc` belong to the turn and are
reaped on force stop or when its manager's call is cancelled. While the
manager settles a turn, Force stop can also kill groups left by a completed
`start`. Await the CLI's exit before returning from `start` if the next turn
needs a session file the CLI is still writing. Agent authors
do not implement the message transport.

The adapter in `packages/sdk/worker/contracts.ts` special-cases
`owner === "ai" && name === "agent" && method === "start"` to build that
`Run`. The Runner's linked call transport is general and does not inspect
agent messages. The start carries a protocol version so an old ai bundle
and a host with a different wire format fail with a version error. Reports
are validated as a batch and acknowledged in order before the agent returns
its final result. The 1008 KiB start payload keeps the full prompt and drops
the oldest history as needed. A message that cannot fit even without history
fails once, including when it is at the head of the queue.

QuickJS allows up to 64 concurrent turns per Runner and up to 32 on an
individual agent host, within the 128 invocation slots per host. The Runner
enforces both limits. Reports and questions wait for space in bounded queues.
The adapter merges consecutive text or thinking deltas and replaces unsent
tasks, plan, and usage snapshots. It sends batches below 640 KiB and allows
768 KiB per turn (JSON bytes plus 64 bytes per buffered event, including the
batch awaiting acknowledgement). At 32 turns that accounts for 24 MiB of
reports per host. The reporting API stays synchronous; if coalescing cannot
keep the buffer below its limit, only that turn fails with “The agent produced
output faster than it could be saved.”

If Force stop cannot drain
reports within 750 ms, the host can still kill the invocation's programs
without running JavaScript. A stuck realm may subsequently be reset by the
watchdog, which also ends its other invocations.

A server contract defaults to `place: "server"`. For each
method provide a server function definition such as `internalAction` or
`internalQuery`; calls obey the usual kind rules and cross the server function
boundary as JSON. Data fields are JSON, and the implementation uses an object
literal so the build can register its methods.

An optional provider still builds and runs without the defining plugin
installed. The compiler only needs its public contract types. If the defining
plugin's source is unavailable, check in an exact copy of its public contract
declaration at `contracts/<id>.ts` in the provider. That copy supplies types
and a contract key. The implementation stays inactive until the owner is in
the installed catalog. For a local contract, the client skips an incompatible
provider individually; the ai agent list shows the provider as unavailable.
For a server contract, the server refuses a mismatched declaration hash.

For a direct server-to-server export, wrap a query, mutation or action in
`pluginOnly(...)` and re-export it from `src/server/api.ts` as usual.
Dependents can import the reference from `plugin:<id>/server`. Within the
defining plugin, use the generated `_generated/plugin.ts` references. These
functions are excluded from the window API, local-to-server transport and
subscriptions. `internal*` remains private to its own plugin.
