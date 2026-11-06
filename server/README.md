# Feature service (TKM-5) and embedded data

`Server::load(Database, Arc<runtime::Pool>, Arc<runtime::Bundle>).await` loads
one real SDK-generated bundle at startup. `descriptor()` returns its schema
and function metadata; `functions()` lists `{name, kind, args}` values. The
bundle's new callable `describe` returns its existing `schema` and `metadata`
exports because Pool invokes functions only; there is no second manifest.
Feature handlers still enter only through `invoke({name,args}, host)`.
`main` remains empty; native application/transport composition is TKM-7.

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
  events, not a new JSON wire protocol; TKM-7 maps them to injected SDK transport.
  It MUST forward this stream in order, not split replies and updates into
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
No private/internal SurrealDB crate, fork, or patch is used to remove them.

Old Surlvex dataapi/schema/server-change code was read for failure modes and
concepts only. This layer is written anew around the public SDK; it contains no
schema plumbing, internal datastore API, call-token stack, or wiretap.

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
