# @tokamak/sdk (POC)

The portable authoring/client layer between TypeScript features and the native
host. `src/` uses ES2022 only. `tools/` runs on the pinned Bun 1.4.4 build machine,
not in QuickJS. There is no SDK CLI and no runtime dependency.

## Author a feature

A feature folder contains `schema.ts` (default schema export, optional) and
TypeScript modules exporting query/mutation definitions. Bind builders to the
schema for table, document and filter types:

```ts
// schema.ts
import { defineSchema, defineTable, v } from '@tokamak/sdk';
export default defineSchema({
  todos: defineTable({ text: v.string(), done: v.boolean() }),
});
```

```ts
// todos.ts
import { createFunctions, v } from '@tokamak/sdk';
import schema from './schema';
const { query, mutation } = createFunctions(schema);

export const list = query({
  args: { done: v.boolean() },
  handler: (ctx, { done }) =>
    ctx.db.query('todos').where('done', '=', done).order('desc').collect(),
});
export const add = mutation({
  args: { text: v.string() },
  handler: (ctx, { text }) => ctx.db.insert('todos', { text, done: false }),
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
`take(n)`, `first()` or `collect()`. There is no `.index()`, SQL expression,
pagination, implicit thenable, action, internal function or nested call API.

Schemas describe types and metadata, not enforced persistence constraints.
Schema enforcement/migrations are outside this POC.

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
- `FEATURE/_generated/api.ts`: typed UI references, not handlers.

Discovery includes `.ts` modules recursively, excluding `schema.ts`, declarations,
`.test.ts`/`.spec.ts`, `tests/`, `dist/`, `node_modules/` and paths beginning with
`_` or `.`. Imported helpers in excluded folders still bundle normally; they are
not independent function modules. Use a backend-only feature folder. Module
path collisions (`a.ts` with `a/b.ts`) fail rather than produce ambiguous APIs.
Generated references need feature source types available to the UI type checker;
they do not import backend code at runtime. Keep `_generated/` out of source
control and regenerate before checking a consumer.

The bundle checker inherits the feature's resolution options unchanged, including
`paths` aliases inherited from another config (relative to the declaring config).
With the default workspace config, use extensionless TypeScript imports such as
`./schema`, not `./schema.ts`; the bundle task does not add a build-only
`allowImportingTsExtensions` opt-in. If a feature explicitly opts in or uses
aliases, consumers of its generated API must share those compiler settings,
because checking the references also checks the backend source types.

```ts
import { TokamakClient } from '@tokamak/sdk';
import { api } from './_generated/api';
const client = new TokamakClient(transport); // see concrete transports below
const rows = await client.query(api.todos.list, { done: false });
const id = await client.mutation(api.todos.add, { text: 'Read this' });
const stop = client.subscribe(api.todos.list, { done: false }, (event) => {
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
import { TokamakClient, InProcessTransport, WebSocketTransport } from '@tokamak/sdk';
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
