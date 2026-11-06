# SDK acceptance tests

Run `moon run sdk:check sdk:test sdk:build`. Tests use Bun's built-in runner and
checker; there are no test dependencies. `acceptance.test.mjs` invokes the real
`moon run sdk:bundle -- sdk/tests/fixtures/feature`, imports the result, checks
its map and generated references, then compiles positive/negative UI consumers.
Each negative line must have its own compiler diagnostic (no `@ts-expect-error`).
Temporary checker/probe inputs are isolated copies under `sdk/tests/.tmp-*` and
removed even on failure; only the real feature's ignored `dist/` and
`_generated/` outputs remain. Portability probes run the real SDK checker on a
copy, never poison live runtime source. No tests read or modify `spikes/`.

Review regressions additionally require bundle/consumer agreement on the default
extensionless source-import contract, preservation of inherited feature aliases,
and rejection of type-only imports that smuggle DOM declarations into runtime.
The ambient-isolation probe includes an actual `.ts` test with DOM declarations
in the package checker, not an excluded JavaScript test. Subscription regression
coverage requires acquiring and invoking transport cleanup before propagating a
synchronous initial UI callback failure, then suppressing reentrant/late events.

`transport.test.mjs` adds TKM7 failure-boundary checks for actual SDK message
transports: out-of-order correlation, null success versus error, subscription
registration/rerun failure, observer exceptions, idempotent teardown, capacity
release, malformed WebSocket frames, and socket backpressure. Fake connections
are used only to force these boundary failures; real native/WS/backend parity
and two-client live updates run under `moon run server:test` using the identical
public `TokamakClient` workflow in `server/tests/sdk-transport-driver.mjs`.

The recording host deliberately does not implement storage or sort rows in JS.
It verifies the canonical host operation names, JSON payloads, AND filters,
creation-time ordering instructions, and terminal limits. Actual persistence,
transactionality, ordering execution, and QuickJS embedding belong to host tests.
Subscription ordering belongs to the injected transport: the client must preserve
its delivery order, propagate errors, and suppress queued/late delivery after
idempotent teardown, not invent sequence IDs or reorder events.
