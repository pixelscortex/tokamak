# Backend runner, transports and embedded data

## Independent desktop service

The desktop now uses this standalone server over authenticated loopback
WebSocket, not an embedded Backend. `bun run app` starts/reuses it.
`bun run server:status` and `bun run server:stop` do not build anything.

`tokamak --local-dir <directory> --bundle <path>` opens `<directory>/store`,
reads a private 64-hex-character `server.token`, binds an ephemeral loopback
port and publishes `server.json` after backend startup. Capability-protected
`/health`, `/shutdown` and `/ws` reject browser Origins. Discovery includes
the loaded bundle hash; the launcher refuses to reuse a different revision.
The capability is never included in discovery, URLs or command arguments.
Shutdown removes discovery only after storage has closed.

`tokamak --local-path` discovers the standard application directory without
opening storage. Desktop and server retain the existing application store.
Normal desktop exit/crash does not stop the server. There is no automatic
reconnect, mutation replay, crash supervisor or account-level remote access.
The original unauthenticated loopback CLI/library mode below remains for
existing tests and manual demonstrations. Do not expose it publicly.

## Library-first runner (TKM-7)

`Backend::start(BackendConfig { storage, bundle, javascript: PoolConfig }).await`
constructs storage and QuickJS workers together. Library tests can call
`backend.connect()` without a port. `Backend::server()` exposes metadata and sessions, not raw
storage. Worker counts/queue/heap/time limits reuse `runtime::PoolConfig`: they
are budgets, **not reserved cores or hard per-subsystem process memory limits**.
JIT stays off. There is no separate DB service, replication or global sync.

`Database::open` is the coherent storage boundary. It constructs exactly one
`Arc<surrealdb_core::kvs::Datastore>` with maintenance deferred, then awaits
`check_version`, `bootstrap`, `start_maintenance_tasks_checked`, and attaches the
existing transactional SDK through `Surreal::<Db>::unstable_from_datastore`.
SDK and core are exact-pinned to 4.0.0 because this public doc-hidden bridge has
no SemVer guarantee. QuickJS `ctx.db` still uses the same tracked adapter; no JS
inside SurrealQL, raw feature DB handle, second SDK attachment, fork or Wiretap.
The crate-private diagnostic datastore reference is not a feature capability.

Partial startup errors await cleanup and retain the original error (plus any
cleanup failure). The only SDK owner lives through all calls. Service close
stops admission, drains accepted calls, awaits SDK shutdown and drops retained
Datastore references before returning the disk-lock barrier. Close uses a separate
bounded one-slot control lane, never application-queue capacity. Disconnect
retires delivery/subscriptions, not already-admitted calls: queued mutations
still finish after their Session owner drops. This is the same coordinator/Tower
execution path, not another backend service or execution stack. Native active
transactions still reject close recoverably; cancelled database close retains
its owned shutdown future. Keep Tokio alive through awaited close; killing the
process/runtime is not graceful shutdown. Do not independently attach another
SDK client to the same datastore: session closure shuts the supplied store down.

### Shared protocol and in-process transport

`src/protocol.rs` is the only definition of Request and Event. Serde handles
JSON; maintained `ts-rs` generates committed `packages/sdk/src/protocol.ts`:

```sh
cargo run --locked -p server --features protocol-codegen --bin export-protocol
cargo run --locked -p server --features protocol-codegen --bin export-protocol -- --check
```

The second command rejects drift. Code generation is a build-only opt-in, not a
native runtime dependency. Wire IDs are nonnegative JavaScript safe integers;
SDK IDs are monotonic and never reused. Requests are tagged `query`, `mutation`,
`subscribe`, `unsubscribe`, with `{id,name,args}` (unsubscribe has only id).
Events are tagged `response`, `subscription`, `unsubscribed`. The first two have
`result: {Ok: value} | {Err: string}`: null success cannot be confused with error.
A mismatched query/mutation kind is rejected without executing the function.

`SessionSender` implements `tower::Service<Request, Response=()>`; this response
acknowledges **admission only**. Desktop forwards SDK `MessageConnection.send`
to this service and feeds the ONE `Session::recv` stream to its listener. The
native host must dispose/drop Session when the connection closes, including on
receive failure; retaining Session means retaining its subscriptions. No port,
HTTP stack, or per-call reply channel is involved in this embedding path.
`new TokamakClient(new InProcessTransport(nativeConnection))` and
`new TokamakClient(new WebSocketTransport(openSocket))` share all SDK correlation,
subscription, error, teardown and application code. No implicit retry/reconnect.

### Headless executable

```sh
moon run sdk:bundle -- packages/server/demo/feature
moon run server:check server:build
./target/debug/tokamak --data ./tokamak.db --listen 127.0.0.1:3000 \
  --bundle packages/server/demo/feature/dist/bundle.js --workers 2
# In another terminal (two SDK clients, add/list/live update):
proto run bun -- packages/server/demo/client.ts ws://127.0.0.1:3000/ws
```

`--bundle` is required. Defaults: `--data tokamak.db`, `--listen 127.0.0.1:3000`.
Additional budgets: `--queue`, `--heap-bytes`, `--call-ms`, `--load-ms`. The
WebSocket endpoint is `/ws`; its adapter forwards Tower requests and ordered
Events without another execution/data path. It limits connections to 64 and
input messages/frames to 1 MiB. A slow send times out after 5 seconds. Malformed
frames and admission overload close the connection rather than racing an
out-of-order transport error ahead of prior updates. The SDK bounds outstanding
calls/subscriptions to 128 and socket buffering to approximately 1 MiB. These
are queue bounds, not maximum feature result sizes or hard memory guarantees.

Ctrl-C/SIGTERM stops upgrades, cancels accepted socket I/O (including incomplete
HTTP upgrade headers), waits for Axum's owned HTTP tasks and upgraded connection
owners to finish, then awaits backend shutdown. Cancellation lives below HTTP
parsing: a handler timeout cannot cover a peer that never finishes its headers.
The outer serve future is still awaited, never abandoned to detach HTTP tasks. `websocket::serve` must be driven
to completion before closing the backend; dropping its future is not that
barrier. A lost stream can hide an already-committed mutation: never blindly
retry. No authentication/TLS/multiuser/reconnect support. Non-loopback listen
addresses are refused; **do not publicly expose this POC**.

### Package decisions

Firecrawl verified current upstream APIs and maintained releases on 2026-11-06:

- [Axum 0.8.9](https://docs.rs/axum/0.8.9/axum/): Tokio-maintained Tower routing,
  `WebSocketUpgrade`, `max_message_size`, `max_frame_size`, `send`/`recv`, and
  `serve(...).with_graceful_shutdown`. Defaults disabled; only `ws/http1/tokio`.
  It wraps the already-resolved tokio-tungstenite 0.29.0. Direct tungstenite was
  considered; Axum avoids hand-rolling HTTP upgrade/routing and composes Tower.
- [Tower 0.5.3](https://docs.rs/tower/0.5.3/tower/trait.Service.html): existing
  resolved dependency, defaults disabled; only the standard admission trait.
- [tokio-util 0.7.20](https://docs.rs/tokio-util/0.7.20/tokio_util/sync/struct.CancellationToken.html):
  already on the dependency graph; direct `rt` feature enables its maintained
  owned cancellation future. Firecrawl docs and pinned source verified wakeup/
  cancellation behavior. Axum's pinned `Listener` contract and graceful task
  completion source were checked before using the small cancellable TCP adapter.
  No second HTTP service implementation or generic lifecycle framework was added.
- [ts-rs 12.0.1](https://docs.rs/ts-rs/12.0.1/ts_rs/): maintained Rust/serde to TS
  generation, `serde-json-impl`; no second handwritten union or schema framework.
  Crates downloaded 76.5 KiB compressed for ts-rs + macros; this is not linked
  binary size. Its warning for `deny_unknown_fields` is benign: that validation
  affects serde admission, not the generated TypeScript shape.
- [SurrealDB attachment source](https://docs.rs/crate/surrealdb/4.0.0/source/src/engine/local/native.rs)
  and pinned local core/engine source verified exact initialization/shutdown.
  Existing SDK stable constructors remain represented by the compatible
  `Database::open(Storage)` API, but no longer hide datastore construction.

Native size is measured with `moon run :size` against the reachable headless
entry point now. Historical scaffold/probe measurements below are not marginal
adapter costs. Independent test-writing/review follows implementation.

### TKM-7 implementation evidence

On aarch64-apple-darwin / Rust 1.97.0:

- Exact `moon run server:check server:build` passed, including generated-protocol
  drift checking. `moon run sdk:check sdk:build` and `moon run sdk:test` passed
  (10 tests / 138 assertions). Existing `cargo test --locked -p server` passed
  all 20 native + 9 service tests after building the real SDK fixture.
- Real debug **and measured release** headless runners passed the two-client
  SDK add/list/live-update demo, SIGTERM shutdown, immediate disk reopen and
  persisted-data readback. Non-loopback binding was explicitly refused.
- Removed temporary probes ran the actual SDK client inside QuickJS with an
  injected native Session connection (no port): query/mutation/subscription and
  writer update-before-mutation-reply passed. Cancelled pending Backend close
  recovered through retry, and repeated close returned the settled result.
- Removed native diagnostic probes confirmed supplied-core read visibility of
  SDK commits, rollback, typed conflict, dropped Datastore weak-reference after
  shutdown, cancelled pending database close recovery, and disk reopen. Failed
  bundle startup preserved its error and released the disk for reopening.
  The direct-core diagnostic probe used an 8 MiB libtest thread stack, matching
  existing native data tests; default 2 MiB overflowed. No production thread
  stack or runtime implementation was changed. Core version/bootstrap failures
  were source-verified for awaited cleanup, not separately fault-injected.
- Rustfmt (changed Rust files) and `git diff --check` passed. No final tests were
  added and no render/runtime/ui or unrelated formatting was changed by TKM-7.
  Full-workspace validation remains for integration.

`moon run :size` after shutdown review fixes completed in 8m44s:
**39,542,352 bytes**, actual reachable headless binary (**+48 bytes** versus the
39,542,304-byte first implementation). Versus the inherited measured
286,080-byte scaffold: **+39,256,272 bytes**. Before-change attempts timed out during dependency builds;
the scaffold baseline is inherited, not a newly completed before-run. The prior
39,392,768-byte service probe has a different entry point/assertions and is not
a direct adapter-size comparison. Release binary SHA-256:
`077503cabbc437f3986a2035fdbf8238b882f7a9159f4e327309e75f0dc9c75c`.

Shutdown review follow-up probes passed against the measured release binary:
held-open partial HTTP headers exited 0 in 91 ms; an active 1.5-second mutation
with 64 queued queries exited 0 in 1,429 ms and persisted its row; eight queued
mutations after that active call exited 0 in 1,451 ms and persisted all nine rows.
Every case immediately reopened the same disk and read persisted state. Debug
probes passed too. Removed native Tower probes confirmed exact successful
admission, dropped-session queued writes, pending-close cancellation recovery,
and repeated close with a saturated application queue. All existing 29 native/
service tests passed; parent-owned independent regressions remain for integration.

Cleanup removed the obsolete app-queue `Command::Close` variant, replaced the
WebSocket-only watch signal with shared accepted-I/O cancellation, and removed
redundant startup double boxing. Local and WebSocket adapters still use one
Tower admission/function pipeline. The dedicated shutdown control lane and TCP
I/O adapter remain because saturation and pre-header shutdown need them; neither
is an alternate application execution path.

Local compressed crate sizes: Axum 180,525 bytes; Tower 110,488 bytes; ts-rs +
macros 78,316 bytes. These downloads are **not linked binary costs**. Debug links
retain the existing Apple large `__eh_frame` warning; release linking passed.

## Feature service (TKM-5)

`Server::load(Database, Arc<runtime::Pool>, Arc<runtime::Bundle>).await` loads
one real SDK-generated bundle at startup. `descriptor()` returns its schema
and function metadata; `functions()` lists `{name, kind, args}` values. The
bundle's new callable `describe` returns its existing `schema` and `metadata`
exports because Pool invokes functions only; there is no second manifest.
Feature handlers still enter only through `invoke({name,args}, host)`.
The TKM-7 runner above now composes this unchanged feature execution path.

## Service API and delivery contract

- `server.connect().await -> Session`; `session.sender() -> SessionSender` is
  clonable admission only. One independent task owns `session.recv().await`.
- Both handles offer `call(id, name, args)`, `subscribe(id, name, args)`, and
  `unsubscribe(id)`. Success means **admitted**, not committed. IDs are u64 and
  session-local. Use unique outstanding request IDs; reuse subscription IDs only
  after consuming `Unsubscribed`. Subscriptions accept registered queries only.
- `recv() -> Result<Option<Event>, Error>` is the **single ordered stream**:
  `Response {id, result: Result<serde_json::Value,String>}`,
  `Subscription {id, result}`, `Unsubscribed {id}`. Invalid registration emits
  `Response::Err` without replacing an existing subscription. These are Rust
  events, now also the generated JSON wire protocol. Adapters forward this
  stream in order, never split replies and updates into
  racing tasks. All affected subscription updates precede a mutation Response,
  including the writer's own updates. Identical JSON outcomes are suppressed.
- A deliberately serial coordinator owns every admitted invocation through
  commit, notifications, refresh, and reply. Disconnect/cancel cannot cut this
  lifecycle in half. This trades throughput/head-of-line latency for one small
  correctness rule. Process/runtime loss, non-conflict commit errors, or a lost
  stream after admission have **unknown outcomes**: do not blindly retry writes.
- Queries use actual read-only snapshots. Mutations share one owned transaction
  across awaits; errors (including caught host errors and abandoned in-flight
  SDK requests) roll back the entire call. Only typed definite conflicts replay
  the WHOLE handler in a fresh world/transaction, at most three total attempts.
- Per-run get/table-query dependencies include absent/empty/zero-limit reads.
  Subscriptions register before initial execution; new readsets install before
  draining intervening events. Overrun causes full invalidation. Failed runs
  conservatively watch all changed tables until recovery. One run at a time;
  four consecutively invalidated snapshots end the subscription explicitly
  rather than publishing a known-stale result or starving all commands.
- Bounds: 64 queued commands, 32 queued outputs/session, 64 sessions, 128
  subscriptions/session, existing 256-event DB ring. Admission returns
  `Overloaded` immediately. Full output disconnects the whole session; buffered
  events drain, then `recv` returns `SlowConsumer`. Its unacknowledged mutations
  may have committed. Drop closes reception and wakes cleanup without needing
  command-queue space; unsubscribe is ordered; `server.close().await` is the
  graceful database shutdown barrier. Keep the host Tokio runtime alive through it.
- SDK JSON is canonical. Native envelopes flatten to `_id`, `_creationTime`, and
  user fields, including business `id`/`data`. SDK arbitrary top-level filter
  keys, structural equality, safe-integer limits, and missing versus null require
  filtering ordered snapshot rows in Rust, not interpreting names as SQL paths.
  Native `data::Query` retains its narrower SQL-backed API below. No feature SQL.

## TKM-5 research and evidence

Firecrawl checked existing maintained releases, not a new framework/package:
[Tokio 1.54.1 bounded admission/weak senders](https://docs.rs/tokio/1.54.1/tokio/sync/mpsc/struct.Sender.html),
[broadcast lag](https://docs.rs/tokio/latest/tokio/sync/broadcast/index.html),
[SurrealDB 4.0.0 value conversion](https://docs.rs/surrealdb-types/4.0.0/surrealdb_types/enum.Value.html).
The cached public-SDK release source confirms `SurrealValue` for serde_json;
reuse it rather than write another codec. Only direct dependencies added are the
existing local runtime and already-locked serde_json 1.0.154. Surlvex functions,
subscriptions, and their tests were read for failure modes, never copied.

Temporary **real TS SDK-generated bundle** probes passed debug and release:
query/mutation/subscription, writer update-before-response, flattening,
structural equality on a dotted business key, limits above u32, rollback after
throw/caught host failure/unawaited operation/timeout, unrelated-table silence,
unsubscribe, close, and explicit slow-consumer disconnection. Debug memory and
release memory/disk passed. Actual default Pool worker stack passed with boxed DB
futures; no stack setting/runtime worker edit. Operations poll asynchronously on
JS workers; DB initialization/background-task ownership stays on the host runtime
(not the time-only workers). No detached DB operation tasks or blocking hostops.
Run `moon run server:check server:build server:test` to check the service and run
its independent acceptance suite. See [the service-test guide](tests/README.md)
for the real SDK bundle setup and the behavior each test exercises.

`moon run :size`: 286,080 bytes before/after (+0), **empty unlinked main only**.
Temporary reachable release service consumer: 39,392,768 bytes (+39,106,688 over
empty); it reaches actual bundle/QuickJS/service/both storage paths and includes probe
assertions. This is not an isolated marginal library cost, nor directly comparable
to the different TKM-3 probe workload. No claim that the service costs zero bytes.

## Native data API (TKM-3)

`server::data` is the native storage boundary used by the feature host adapter.
There is no transport, schema enforcement, migration, index, plugin namespace,
or application logic. The original data-layer details and measurements follow.

```rust
use server::data::{Database, Storage, Table, Object, Order};

// Inside the host's Tokio runtime:
let mut db = Database::open(Storage::Memory).await?;
// Or Storage::Disk(PathBuf::from("...")), a directory, not an endpoint URL.
let todos = Table::new("todos")?;
let mut changes = db.subscribe();
let mut tx = db.begin().await?;
let mut fields = Object::new();
fields.insert("id", "an ordinary business field");
fields.insert("done", false);
let id = tx.insert(&todos, fields).await?;
let own_write = tx.get(&id).await?;
let rows = tx.query(&todos).eq("done", false).order(Order::Desc).take(10).await?;
// Separate JS-driven calls retain this same tx; never a tx.client().
tx.commit().await?;
let footprint = changes.recv().await?;
db.close().await?;
```

- `get(&Id) -> Option<Document>`, `insert(&Table, Object) -> Id`.
- `patch(&Id, Object)`, `replace(&Id, Object)`, `delete(&Id) -> ()`.
  Patch merges top-level fields. Replace removes omitted fields. Both preserve
  identity and creation time, and reject missing records. Delete is idempotent.
- `query(&Table).eq(field, value)` combines equality filters with AND. Fields
  are single ASCII identifiers, not nested paths. Native `Value`/`Object` and
  `SurrealValue` are re-exported; the service host adapter owns JSON conversion.
- Queries default to creation-time ascending, then identity ascending. Descending
  reverses both keys. `limit(u32)` bounds `collect()`; `take(u32)` sets that bound;
  `first()` adds a bound of one without widening `limit(0)`. `collect()` without
  a bound reads all matching records. There are no pagination/index promises.
- `Document { id, creation_time, fields }` is typed Rust data. The adapter will
  flatten it to `{ _id, _creationTime, ...fields }`. Only `_id` and `_creationTime`
  are reserved application fields. Storage uses `{ id: native RecordId,
  _creationTime: integer epoch milliseconds, data: user_fields }`, so business
  fields named `id` and `data` are ordinary fields, not storage controls.
- Table names match `[A-Za-z][A-Za-z0-9_]*`; IDs are `table:key`, with opaque
  **string** keys matching `[A-Za-z0-9_-]+`. An all-digit key remains a string,
  not a SurrealQL integer. No arbitrary SQL record expressions are parsed.
- Table names, field paths, IDs, objects, filter values, and limits are bound.
  Query text contains only fixed templates, generated parameter positions, and
  closed order choices. `_id` equality binds a native record link; business
  `id` equality looks inside `data`. SQL keywords are safe table/field names.

## Transactions and change delivery

`begin()` opens a snapshot-isolated write transaction. `read_only()` opens a
real engine read-only transaction, with a wrapper guard too. These are not
serializable transactions: write skew remains possible. A transaction owns an
`Arc` to private database state and survives separate awaits without a database
lifetime. It can live in `Arc<tokio::sync::Mutex<Option<Transaction>>>` captured
by Send + Sync + 'static runtime ops. Commit/rollback consume it; no data
operations can escape through a public raw SDK handle.

Every returned operation error poisons that transaction, including validation
and statement errors. A later commit cancels it and returns `FailedTransaction`
rather than saving a partial call. Always call `rollback().await` after an
application error, even when no data operation failed. SDK drop rollback is a
safety net that runs asynchronously only with a live Tokio runtime.

`Error::is_retryable_conflict()` recognizes only the SDK's typed
`QueryError::TransactionConflict`; this layer never retries. The mutation
runner must replay the entire invocation, not just its final write or commit.
Other commit failures must not be blindly retried.

A successful write commit sends one `ChangeEvent { tables }` with deduplicated,
sorted tables. Reads, identical updates, missing deletes, rollback, poisoned
commit, and losing conflicts send nothing. A table written and then deleted in
the same transaction still belongs to its write footprint. No event is emitted
before commit. Receivers use a 256-event Tokio broadcast buffer: lag is explicit
and requires full invalidation, not silent continuation. Events are local,
ephemeral invalidations, not a crash-safe commit log or multi-process wiretap.
A caller must drive commit to completion; crash/cancellation during commit can
leave its result unknown and is not an exactly-once delivery guarantee.

`close(&mut self).await` rejects active transactions with `Error::Busy`, leaving
the database open so the caller can finish/drop transactions and retry. Once
shutdown starts, new `begin`/`read_only` calls return `Error::Closed`. The handle
retains the shutdown future: cancelling a close call does not discard its progress,
and retry awaits that same completion barrier before reporting success. No
shutdown task is detached by this layer. Successful close releases the SurrealKV
directory for immediate reopening. Repeated close returns the completed result,
including the same error if shutdown failed; subscribing while closing or closed
returns an already-closed receiver. Updates compare returned persisted fields with
the old fields before reporting changes, so storage-normalized no-ops (such as
adding a NONE-valued absent field) do not emit an event.

## Dependency research (2026-11-06)

Chosen public SDK: **surrealdb =4.0.0**, released November 3, 2026. Current docs,
release-tag source fetched with `opensrc`, and real memory/disk probes agree on
`begin`, `read_only`, transactional `query().bind`, `commit`, `cancel`, typed
conflicts, and shutdown. Query transport success alone is not statement success;
every response goes through `check()` before extracting data. `tx.client()`
explicitly executes outside the transaction and is never used here.

- [Rust transaction concepts](https://surrealdb.com/docs/reference/rust/concepts/transaction)
- [4.0.0 Transaction API](https://docs.rs/surrealdb/4.0.0/surrealdb/method/struct.Transaction.html)
- [4.0.0 begin/read-only source](https://github.com/surrealdb/surrealdb/blob/v4.0.0/surrealdb/src/method/begin.rs)
- [4.0.0 embedded transaction routing/commit source](https://github.com/surrealdb/surrealdb/blob/v4.0.0/surrealdb/engine-local/src/engine.rs)
- [4.0.0 feature declarations](https://github.com/surrealdb/surrealdb/blob/v4.0.0/surrealdb/Cargo.toml)
- [Embedded engine's mandatory core features](https://github.com/surrealdb/surrealdb/blob/v4.0.0/surrealdb/engine-local/Cargo.toml)
- [4.0.0 error details source](https://github.com/surrealdb/surrealdb/blob/v4.0.0/surrealdb/types/src/error.rs)
- [Tokio 1.54.1](https://docs.rs/tokio/1.54.1/tokio/) supplies the async runtime
  and broadcast channel, with no additional event dependency. The direct features
  are `rt-multi-thread`, `macros`, `sync`; SDK dependencies enable more transitively.

Only `kv-mem` and `kv-surrealkv` are selected on `surrealdb`, with default features
off. This disables the SDK's default remote WS/TLS selection, **not all database
subsystems**. Cargo's active native feature graph still includes core API, files,
search/fulltext/vector indexing, geometry, crypto, observability, encoding,
collation, maintenance, and other function families through the embedded engine.
TKM-3 used no direct core dependency. TKM-7 adds exact-pinned core only for
explicit datastore ownership; it does not remove these subsystems or fork them.

Old Surlvex dataapi/schema/server-change code was read for failure modes and
concepts only. This layer is written anew around the public SDK; it contains no
schema plumbing, call-token stack, or wiretap. TKM-7 adds the explicit datastore
startup/attachment boundary documented above.

## Size and temporary evidence

Measured on `aarch64-apple-darwin`, Rust 1.97.0, inherited release profile:
`opt-level=s`, LTO, symbols stripped, one codegen unit. Disk and memory remain
reachable through a runtime path argument. No root profile or moon task changed.

| Executable | Bytes | Difference from empty host |
| --- | ---: | ---: |
| Inherited empty `tokamak` baseline (`moon run :size`) | 286,080 | — |
| Minimal public-SDK consumer, both engines and transaction/query path | 38,359,216 | +38,073,136 |
| Initial data-API consumer, both engines and all CRUD/query paths plus probe assertions | 38,425,488 | +38,139,408 |
| Owned-transaction/static-callback consumer, both engines and CRUD/query paths | 38,392,400 | +38,106,320 |

The second and third measurements used a throwaway
`server/examples/tkm3_probe.rs`, built with
`cargo build --locked --release --package server --example tkm3_probe`, then
`stat -f '%z bytes %N' target/release/examples/tkm3_probe`. The API consumer called
`Database::open` from a runtime optional disk path; insert/get/patch/replace/delete;
AND equality on business `id` and `done`; `_id` equality; asc/desc; take/first/zero
limit/collect; read-only; rollback; failed-operation poisoning; same-record
conflicting commits; broadcast receive; close and disk reopen. It asserted
hostile-looking Unicode/SQL text and nested objects stayed data, immutable time,
field replacement, exact deduplicated post-commit table events, and no events
from rollback/no-ops/failures. Memory and fresh temporary disk runs passed.
The minimal SDK consumer additionally attempted an actual engine write in a
read-only transaction and checked its statement error. Probes are removed;
no permanent tests were written by the coder.

`moon run :size` after the change reports 286,080 bytes (+0) on the unchanged
empty `main`: LTO cannot establish the DB footprint from an empty entry point.
**Use the reachable-consumer measurements above, not the empty executable,
for the TKM-3 cost.** The final composed app will need a fresh measurement.

After removing the throwaway source, these acceptance checks passed:

- `moon run server:check`
- `moon run server:build`
- `moon run :size`
- `rustfmt --edition 2024 --check server/src/lib.rs`
- `git diff --check`

No final tests or full-workspace test suite were written/run by the coder.
The temporary API probe source's final formatted SHA-256 was
`6247f00af8f98e89436b06b28a00e72ea1fdb859fd2f31e9af2fa086266985d6`;
the measured API executable's SHA-256 was
`2297ce52b19d81ba96e55ca94665717cf8f0c687ba07d9754418fe8a7805e56f`.

After making transactions owned for 'static runtime callbacks, a second throwaway
`server/examples/tkm3_owned_probe.rs` compiled a Send + Sync + 'static closure
returning a Send + 'static future, capturing exactly
`Arc<tokio::sync::Mutex<Option<Transaction>>>`. The callback queried the actual
uncommitted database; the consumer also reached all CRUD paths, event delivery,
read-only transactions, and disk reopen. Debug and release executions passed in
memory and fresh temporary disk directories. They verified Busy leaves the owner
usable, close can be retried after commit/rollback/drop, closed begin/read_only
fail, a closed subscriber terminates, and repeated close succeeds. The probe
was removed, then all five acceptance/format checks above were rerun successfully.
Its different assertion workload means its size is not a direct optimization
comparison with the initial consumer. Debug linking emitted Apple's large
`__eh_frame` compact-unwind warning; release linking did not. No execution stack
policy was changed based on this probe.

Owned-probe formatted source SHA-256:
`925ff075b150b08e33daf04b9576b03b4e7cb54bcf869db12e030713375c317a`.
Owned-probe measured release executable SHA-256:
`e0f4f4a8f97a0e277d3872d04a49cdcefc592dbaa11534b0e9829880bd75f943`.
