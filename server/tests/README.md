# TKM5 service acceptance

Run from the workspace root:

```sh
proto run bun -- server/tests/build-feature.mjs
proto run bun -- test server/tests/build-feature.test.mjs
CARGO_BUILD_JOBS=2 moon run server:check
CARGO_BUILD_JOBS=2 moon run server:test
CARGO_BUILD_JOBS=2 moon run server:build
```

`service.rs` also builds the feature once per test process, so direct Cargo test
runs cannot silently consume an obsolete bundle. Every build copies source
fixtures into a fresh, exclusively owned `server/target/tkm5-feature-*` directory
and uses the **actual SDK bundler/type checker**. Deleted fixture modules cannot
survive into the next build, and concurrent processes never share output.

The standalone command prints the retained feature directory on its last line;
inspect `dist/bundle.js`, `dist/bundle.js.map`, and `_generated/api.ts` there and
remove that directory when finished. `service.rs` instead passes `--load`: the
builder prints the ESM/source map as a JSON payload on its last stdout line, then
removes its own directory before exiting. The tests load those contents into
shared immutable memory for real QuickJS; they never delete a shared output
path. Copy/check/build failures also remove only the failed build's directory.
The regression command checks real `describe()` metadata after source deletion,
concurrent child-process builds and independent cleanup, plus failure cleanup.

Disk scenarios use unique directories under
ignored `server/target/tkm5-databases` and remove them after awaited shutdown.
There are no added dependencies or enlarged native stacks.

## Deterministic concurrency evidence

The coordinator serializes admitted commands, including refreshes and mutation
responses. Service commands therefore cannot race each other inside a handler;
asserting parallel handlers would test a different concurrency contract.

The public `Pool::with_engine` boundary permits a test-only observing wrapper
around **real `QuickJsEngine`**. Channel barriers pause immediately before JS
execution (after the service opens the transaction) or immediately after engine
retirement (before service commit/readset installation). The wrapper never
replaces an operation, database, JS result, error, or event. Retained public
native transactions supply real external commits at those barriers:

- Query snapshot remains unchanged after a racing committed native write.
- Startup subscription registration and a newly acquired dynamic read table
  cannot lose a write during query completion; queued commands do not create a
  second concurrent run of the subscription.
- More than 256 real commit events overflow the database broadcast receiver,
  forcing full invalidation even when the relevant table's event was lost.
- Native write conflicts force whole-handler replay, then successful commit or
  bounded exhaustion. Both memory and disk check this with real transactions.

Responses, unsubscribe acknowledgements, engine checkpoints and completed
commits are barriers; no test uses sleeps to infer silence or ordering. Tests
have outer timeouts and gates have bounded waits. Slow-consumer testing fills
real bounded queues and requires an explicit failure, not silent event loss.

An unawaited operation that **already completed** before retirement may commit
successfully, but its table footprint must be published. An operation still
pending at retirement cannot later write through a detached callback. The test
checks rollback after timeout, committed footprints matching storage, and
unchanged storage across subsequent command/lifecycle barriers; it does not
mistake missing JavaScript `await` syntax for evidence that an operation was
still pending.
