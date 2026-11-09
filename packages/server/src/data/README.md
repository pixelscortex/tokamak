# Store boundary

This module is the concrete storage facade: ownership/lifecycle, transactions,
documents, constrained query plans, change footprints and plugin namespaces.
SurrealDB initialization, attachment, SDK transaction types and all statement
construction remain here. Native compatibility types are still reexported for
the original conformance tests; plugin authors receive only the portable SDK.
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
No indexes/schema enforcement are introduced.

Record notifications retain at most 64 changes / 32 KiB encoded images. Larger
transactions fall back to broad changed-table invalidation. Read tracking falls
back to tables after 256 fine dependencies / 64 KiB, and individual filters
above 8 KiB are broad. Broadcast lag also invalidates conservatively. These are
retained-notification/tracking bounds, not total-process allocation/RSS limits.
Mutation snapshots can transiently allocate during conversion. Rollback and
failed commits still publish no notification.
