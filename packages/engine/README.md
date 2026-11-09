# Shared JavaScript engine

`engine` owns engine setup, JSON conversion, host capabilities, and bounded
backend scheduling. It has no database, SDK function-kind, transaction, transport,
or UI framework concepts.

## Backend contract

Construct `Bundle::new(esm_source, optional_source_map)` once and share it with
`Arc`. The source must be a single bundled ESM file; no filesystem, package,
network, or dynamic native module loader is installed. A malformed source map is
an input error rather than silently losing developer locations.

```rust,ignore
let mut ops = engine::OpRegistry::new();
ops.register_async("data.get", move |args| {
    let transaction = transaction.clone();
    async move { transaction.get(args).await }
})?;
let pending = pool.submit(bundle.clone(), "invoke", serde_json::json!({
    "name": "todos:list", "args": {}
}), Arc::new(ops))?;
let result = pending.await?;
```

The selected export receives **one JSON value and one host object**:

```js
export async function invoke(request, host) {
  return await host.op("data.get", request.args);
}
```

`host.op(name, args)` returns a JSON value immediately for sync registrations and
`Promise<JSON value>` for async registrations. Unknown ops throw. Host errors
throw/reject with their message, so JS can catch them. Rust owns serialization:
JS wrappers should not stringify arguments or results. Conversion follows
`JSON.stringify` semantics (including `toJSON`, omitted object properties, and
nonfinite numbers becoming null); undefined top-level results, BigInt and cycles
produce errors. Exports may return a JSON value or an actual JS Promise. The SDK
can dispatch its function registry in `invoke({name,args}, host)` without the
runtime knowing its format.

Registries are immutable once shared. Make a **per-call** registry capturing that
call's host state, such as its transaction and readset; this avoids ambient
"current transaction" globals. Finish/commit or roll back that state in the server
after awaiting the result. Registration rejects duplicate and empty op names.

## Authority and lifecycle

Each backend invocation creates a fresh QuickJS runtime/context, loads the ESM
module, calls its export, and drops the entire world **before replying**. This is
a deliberate POC tradeoff: every call pays module initialization/parsing cost;
module globals are not persistent state. There is no deploy/swap protocol or
compiled-module cache to coordinate across workers. Share the source and parsed
source map, not JS handles.

The host object is injected only into the export, never exposed globally during
module loading. Its Rust closure captures a unique invocation lease, with a fixed
deadline and one-way retirement. It does not look up the worker's current lease.
Old closures therefore cannot gain a new call's authority. Checks occur before
argument conversion, before entering the host, before polling an async op, and
after it resolves. The lease retires on success, error, timeout, panic, or dropped
invocation future. Fresh worlds additionally eliminate detached continuations,
even after successful calls.

Async host futures are polled locally by rquickjs and dropped with the world.
They are not detached Tokio tasks. **Host code must be cancellation-safe and
cooperative:** sync callbacks and async future constructors must be short and
nonblocking, future polls must yield, and callbacks must not spawn untracked
side-effecting tasks. JS interrupts cannot preempt Rust or roll back external
side effects; server-owned transactions provide rollback. Dropping a pending
reply does not cancel the admitted call (external cancellation is out of scope).

## Bounds and shutdown

Defaults: two workers, 32 waiting jobs, 64 MiB JS heap per worker, one second to
load and one second to call. Queue time does not consume execution budgets. Queue
capacity excludes jobs already received by workers. `submit` never waits for
room: a full queue returns `Error::Overloaded`. `PendingCall` can be awaited on any
executor; each worker has a local Tokio executor with time enabled.

The heap cap is installed before allocating standard globals. Load and call each
have both a QuickJS wall-clock interrupt and a Rust timer. The former interrupts
executing bytecode; the latter handles never-settling JS/host promises. A post-poll
clock check also rejects synchronous work finishing after its deadline. The world
is discarded on every outcome, so a limit failure cannot poison the next call.
Dropping the pool closes admission, refuses queued work and joins active workers.
As with execution, shutdown relies on host callbacks obeying the cooperative
contract. JS limits do not bound Rust input/source/map allocations or process RSS.

## Thread-affine UI path

`QuickJsContext::new(heap_bytes)` supplies the same capped QuickJS setup without
a pool. It exposes `context()` for local `with`/`async_with` work and `runtime()`
for local promise driving. `set_deadline` arms the same interrupt for UI startup
or events. `install_ops(ctx, registry, &invocation)` constructs the same host
object for a local context; retire/drop the `Invocation` before publishing its
result. Invocation leases cannot be reactivated. UI code owns persistent JS
roots and their disposal; it must release roots before dropping its context and
supply an async timer when awaiting promises. No cross-thread JS feature is
enabled. `Engine` is only the backend JSON invocation boundary, not an attempt to
force a persistent UI document into backend concurrency/lifecycle rules.

## Errors and source maps

Errors distinguish invalid input, overload, closed workers, load/call timeout,
engine failure, and JS exceptions. JS messages and stacks are retained; generated
`tokamak-bundle.js` frames are translated with the bundle's Source Map v3 map,
normalizing its UTF-8 byte columns to Source Map v3 UTF-16 columns. QuickJS-NG
0.16.2 has mixed column origins: normal lexer locations are zero-based on line 1
(clamped to one) and one-based after LF, while parser errors and `TOK_IDENT`'s
`scope_get_var` locations are explicitly one-based on every line. A runtime stack
does not identify the instruction that supplied a column. We map **both**
engine-supported offsets that fall on valid UTF-8 boundaries, then deduplicate
their source locations. If they disagree (even just in column), the diagnostic
retains the original generated frame and lists explicitly **ambiguous source
locations**. If one candidate is unmapped, that uncertainty is listed as well;
it is not silently discarded in favor of the other candidate. Missing stack
columns are labeled approximate. We do not infer instruction kinds from
user-controlled error messages or parse JavaScript ourselves.

Source locations remain best-effort engine metadata, not a guarantee of an exact
failing TS expression. For example, object-shorthand lookups can inherit an
earlier instruction's location; no column conversion or source map can recover a
location the engine never recorded. Ambiguous alternatives are useful diagnostic
leads, not claims that one candidate is the precise failure site.

These conventions were checked against [the lexer and parser source](https://github.com/quickjs-ng/quickjs/blob/v0.16.2/quickjs.c)
and actual Bun-minified/unminified TS bundles containing Unicode. The engine is
pinned because this normalization must be reverified on upgrades. Unrelated
script frames and unmapped positions remain generated rather than inventing a
location. Only the first 64 frames / 32 Ki characters of stack are reported.

## Dependencies checked for TKM-2

Researched with Firecrawl; rquickjs implementation was read through the `opensrc`
skill. Versions resolved in `Cargo.lock`:

| Package | Evidence and selection |
| --- | --- |
| [rquickjs 0.14.0](https://docs.rs/rquickjs/0.14.0/rquickjs/) / [maintainer repository](https://github.com/DelSkayn/rquickjs) | Current stable bindings, bundled **QuickJS-NG 0.16.2** (verified in `rquickjs-sys`'s `quickjs.h`). `AsyncRuntime::set_interrupt_handler`, `set_memory_limit`, `AsyncContext::async_with`, `Module::declare/eval`, `MaybePromise::into_future` and `Promise::wrap_future` provide the needed primitives. Enable only default std + futures, not full-async, loader, dyn-load, macros or parallel. Registry archives: facade 37,226 bytes, core 148,150, sys including C engine 2,125,745. |
| [sourcemap 9.3.2](https://github.com/getsentry/rust-sourcemap) / [API](https://docs.rs/sourcemap/9.3.2/sourcemap/) | Maintained Sentry Source Map v3 implementation; use `SourceMap::from_reader` and `lookup_token`, not a handwritten VLQ decoder. Default features disabled. It still brings URL/IDNA dependencies; size is not assumed free. Archive 49,259 bytes. |
| [serde_json 1.0.154](https://docs.rs/serde_json/1.0.154/serde_json/) / [repository](https://github.com/serde-rs/json) | Maintained standard JSON value parser/writer, avoiding extra engine/serde adapter crates. Archive 158,079 bytes. |
| [Tokio 1.54.1](https://docs.rs/tokio/1.54.1/tokio/) / [repository](https://github.com/tokio-rs/tokio) | Maintained executor/timers and oneshot replies, using only rt/time/sync. No full runtime/network stack. Archive 983,384 bytes. |

Archive sizes are downloaded package sizes, **not linked binary contributions**.
The unchanged empty server does not link `runtime`; its `moon run :size` result
cannot establish the runtime's cost. A temporary reachable consumer is needed to
measure that cost until the server integration exists.

## Coder verification (not final tests)

Acceptance commands: `moon run runtime:check`, `moon run runtime:build`, and
`moon run :size`. Also checked `cargo clippy --locked -p runtime --lib -- -D warnings`.
No final tests were written or run; that remains a separate workflow step.

A temporary example, run with `cargo run --locked -p runtime --example tkm2_probe`
and with `--release`, exercised JSON sync/async exports and ops, missing ops and
exports, non-JSON results, thrown/mapped errors, load syntax errors, infinite
module initialization, pending top-level await, an endless call, an endless
microtask chain, over-cap ArrayBuffer allocation, pending JS/host promises,
successful calls after failures, host-future disposal, bounded admission,
two-worker concurrency, active/queued shutdown, and stale sync/async bridges in a
reused context. Real Bun source maps mapped a Unicode TS bundle's error to
`original.ts:4:13` with and without minification. The temporary sources/bundles
were removed; these probes are evidence, not a retained regression suite.

On aarch64-apple-darwin, Rust 1.97.0, unchanged workspace release profile:

- Empty server via `moon run :size`: **286,080 bytes before and after**, delta 0.
  It still does not link runtime; this is not a zero-cost-runtime claim.
- Temporary **reachable runtime smoke consumer** (pool, engine, host ops,
  source-map parsing, thread-affine context and assertions): **1,421,200 bytes**,
  or **1,135,120 bytes above the empty host**. This is a different executable and
  includes the probe's code, not a precise standalone runtime contribution or a
  change to the project's release-size tooling.

## Scope boundary

This is for trusted POC features, not third-party isolation. No web APIs, frozen
clock/randomness, external cancellation, streaming, fairness by plugin or plugin
permissions are added. Broad interruption guarantees for catastrophic regexes and
long native operations remain TKM-13 work; the bytecode-loop and heap-cap recovery
behavior here does not establish a process security sandbox.

## Actions and web APIs

`ActionEngine` implements the same `Engine` trait. `Pool::new_actions` creates
an independent, bounded lane (the server uses two workers and 32 queued calls).
The server propagates the configured JS heap cap; action load/call time budgets
are ignored. Action invocation leases have an explicit absent deadline, and
QuickJS interruption checks only lifecycle cancellation. No elapsed-time timer
runs on this path. Query/mutation scheduling and deadlines remain on `Pool::new`.

The native capabilities use owned JSON/byte chunks through `OpRegistry` and are
engine-independent; only installation and promise conversion know QuickJS.
See [WEB_APIS.md](WEB_APIS.md) for the API subset, permission/cancellation rules,
polyfill provenance, go/no-go evidence and measurements. Pure APIs also install
in transactional worlds so action dependencies can be inspected at startup;
fetch, timers and OS randomness reject there. Render contexts opt in explicitly.
