# Store boundary

This module is the concrete storage facade: ownership/lifecycle, transactions,
documents, constrained query plans, change footprints and plugin namespaces.
TokamakDB opens SurrealDB's storage backends directly and uses its catalog,
record and b-tree index APIs. It has no SurrealQL parser, planner, SDK client,
node bootstrap or maintenance task. `Object`, `Value` and `SurrealValue` are
reexported from `surrealdb-types`; conversion to internal storage values is
explicit. Documents accept JSON-like values; NONE object fields are omitted.
Plugin authors receive only the portable SDK.
There is no raw-SQL or native-client capability in feature code.

Do not add an unused generic `Store` trait with one implementation. A future
backend must preserve the existing CRUD/query/read-only/poisoning/commit/close
contract and pass the conformance scenarios in `tests/data.rs` and the actual
SDK scenarios in `tests/service.rs`. Today those run on real memory/SurrealKV
stores, not a mock adapter.

## Plugin data

The kernel selects `DataSpace::plugin(id)`; request arguments cannot choose it.
Table names are encoded with an injective hex plugin prefix. SDK IDs are
`plugin.id/table:key`, preserving logical table names and preventing ambiguous
cross-plugin references. Legacy unqualified IDs remain for POC regressions.
Other-plugin qualified IDs are denied and poison the whole call, even when JS
catches the error. Public plugin APIs, not direct table reads, provide interop.
Rust/native owners are trusted and can construct spaces; this is not an OS or
malicious-native-code sandbox.

## Reactive dependencies

Reads track whole tables, exact IDs (including missing IDs), or conjunctions of
JSON equality clauses (including empty query results). Post-commit footprints
contain both old/new row images, so moves and deletes invalidate correctly.
Numeric equality and missing-versus-null follow the SDK's existing semantics.
Schema assertions are not evaluated. Rust callers can define named indexes;
this does not introduce a plugin schema registry or change the JS API.

Record notifications retain at most 64 changes / 32 KiB encoded images. Larger
transactions fall back to broad changed-table invalidation. Read tracking falls
back to tables after 256 fine dependencies / 64 KiB, and individual filters
above 8 KiB are broad. Broadcast lag also invalidates conservatively. These are
retained-notification/tracking bounds, not total-process allocation/RSS limits.
Mutation snapshots can transiently allocate during conversion. Rollback and
failed commits still publish no notification. Once a commit is polled, an owned
Tokio task completes it and publishes its footprint exactly once on success, even
if the caller drops its waiting future. Epochs advance only after storage success;
the task retains the database and catalog gate until then. Rollback cleanup also
runs to completion after caller cancellation. The Tokio runtime must remain alive
until these tasks finish; close returns Busy while they retain the database.

## Rust indexes

Define indexes inside a write transaction before inserting table rows:

```rust,ignore
transaction.define_index(&messages, "by_channel_time", &["channel", "time"], false).await?;
let rows = transaction.query(&messages)
    .with_index("by_channel_time")
    .eq("channel", "room1")
    .gte("time", 15i64)
    .lt("time", 30i64)
    .order(Order::Desc)
    .take(10).await?;
```

Equalities follow the index's leading field order. At most one lower and one
upper bound constrain the next field. Indexed queries walk field/ID order;
unindexed queries scan IDs, filter in Rust, then sort by creation time and ID.
An unknown index or invalid bound poisons the transaction, including limit-zero
queries. Index definitions are idempotent only when their fields and uniqueness
match. New definitions on tables with rows are rejected: no backfill is run.
All document mutations maintain every table index in the same transaction.
Every mutation (insert, keyed insert, patch, replace, delete and index definition)
is guarded before doing work: an error, panic or cancellation before successful
completion poisons the transaction. Later operations and commit reject it with
FailedTransaction, and commit discards all staged changes, including partial index
writes. This also covers plugin-space writes, which use the same native methods.
Dropping an unpolled operation stages nothing. Dropping a read leaves the
transaction usable because reads stage no record, index or catalog writes;
returned read errors still poison it.
Array values occupy one index entry, preserving equality on the entire array.
The catalog uses the internal trailing `Part::Flatten` marker to suppress
IndexOperation's default array fan-out; no expression evaluator is involved.
Unique failures return `Error::UniqueViolation { index }` and poison the call.

A process-local catalog gate keeps definitions stable through a writer's
outcome. Ordinary writers hold shared guards; index definitions require an
exclusive guard and a snapshot that predates no committed writes. Conflicts
return the same typed retryable storage error instead of waiting on another
call-owned transaction. This protects empty-table definitions from concurrent
inserts without making independent record inserts conflict. Read-only snapshots
need no guard. A cancelled commit caller cannot release the gate early or advance
an epoch ahead of storage publication. Rollback discards catalog, index and record
writes without advancing epochs.

The exact 4.0.0 storage APIs are internal: factory/sequences ownership, catalog
providers, record envelopes/key encoding, IndexEnv/IndexOperation and
IndexKeyspace must be reviewed together on an upgrade. The idx feature selection
follows the proven 4.0.0 probe (`vector-index` enabled); TokamakDB exposes and
runs only ordinary/unique b-tree operations. Full-text and
CJK features are disabled. There is no storage-version migration in this layer.
