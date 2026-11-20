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
Field schema assertions are not evaluated. Plugin schemas install declared
ordinary/unique indexes on physical tables in the plugin's DataSpace. Indexed
JS queries track whole tables conservatively, including empty/limited results;
unindexed equality queries retain their existing precise dependencies.

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

## Plugin schemas and queries

The SDK bundle's `describe()` carries `{schema: {tables: {<name>:
{description, indexes: [{name, fields, unique}]}}}, functions: [...]}`.
The public builder packages that bundle unchanged: the manifest identifies and
hashes its backend entry, rather than duplicating evaluated schema metadata.
The loader validates declarations and installs indexes before publishing a
plugin generation, in the same transaction as grant records. Aggregate metadata
keys schemas by plugin ID, keeping logical table names separate. The legacy
single-bundle loader applies the same registry in its selected DataSpace.
Field descriptions travel as metadata; writes do not enforce them (TKM-92).

Repeated identical declarations are no-ops. At startup and reload, the server
fills new indexes from stored rows, replaces changed definitions under the same
name, and deletes undeclared indexes, including those on undeclared tables in
the plugin's namespace. Legacy bundles without a namespace only remove indexes
on their declared, unnamespaced tables. These changes preserve rows and do not
trigger a schema reset.

The server completes index changes in the schema transaction before publishing
the new plugin version. Colliding writes receive a retryable conflict. Failed
loads discard partial changes, leaving the old indexes and rows in place. A
unique backfill that encounters duplicates reports the index and conflicting
value. A failed reload of an active plugin leaves the old version installed.
At startup the server skips the affected plugin and anything that requires it,
including transitive dependents. Optional dependencies do not cause skips. Each
reload retries skipped plugins, so a repair to stored rows takes effect even
without a new build. The reload result reports any remaining skips and reasons
under `skipped`.

`db.query` retains `{table, where, order, limit}`. Indexed requests additionally
carry `index: {name, eq: [{field, value}], range: [{field, operator, value}]}` and
require `where: []`. Range operators are `gt`, `gte`, `lt`, `lte`, with at most one
lower and one upper bound on the next field after the ordered equality prefix.
Native query execution validates catalog existence and field order even for a
zero limit. Indexed limits saturate at the native `u32::MAX` scan ceiling.
Unindexed queries retain their JSON equality and creation-time ordering.

### Known limits

- A reload runs on the server's single command loop. While backfill runs, other
  requests wait and are answered after the reload finishes. They are delayed,
  not lost.
- At startup each plugin's schema, indexes, and grants commit in its own
  transaction. A fatal error in a later plugin leaves earlier plugins' changes
  committed. Each plugin's transaction is all-or-nothing, and index changes do
  not touch rows.
- Large tables can make loading slow because the transaction holds index writes
  in memory.

## Rust indexes

Define indexes inside a write transaction:

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
Native `eq` uses strict value equality for both access paths, without regex
matching or other SQL coercions. Operands of `eq`, `gt`, `gte`, `lt` and `lte` must
be JSON-like, recursively, with finite numbers; NONE remains the missing-value
sentinel, distinct from null. Regexes, closures, record IDs and other non-JSON-like
values return `Error::Invalid` and poison the transaction at query execution.
An unknown index or invalid bound also poisons the transaction, including
limit-zero queries; all operands are validated before any empty-query shortcut. Index definitions are idempotent only when their fields and uniqueness
match. A new or changed definition indexes all existing rows inside the write
transaction under the exclusive catalog gate. A duplicate during backfill
returns `Error::BackfillUniqueViolation { index, value }`.
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
call-owned transaction. This protects index definitions and backfills from concurrent
writes without making independent record inserts conflict. Read-only snapshots
need no guard. A cancelled commit caller cannot release the gate early or advance
an epoch ahead of storage publication. Rollback discards catalog, index and record
writes without advancing epochs.

The exact 4.0.0 storage APIs are internal: factory/sequences ownership, catalog
providers, record envelopes/key encoding, IndexEnv/IndexOperation and
IndexKeyspace must be reviewed together on an upgrade. The idx feature selection
follows the proven 4.0.0 probe (`vector-index` enabled); TokamakDB exposes and
runs only ordinary/unique b-tree operations. Full-text and
CJK features are disabled. There is no storage-version migration in this layer.
