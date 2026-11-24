# Server acceptance

Run from the workspace root:

```sh
proto run bun -- packages/server/tests/build-feature.mjs
proto run bun -- test packages/server/tests/build-feature.test.mjs
CARGO_BUILD_JOBS=2 moon run server:check
CARGO_BUILD_JOBS=2 moon run server:test
CARGO_BUILD_JOBS=2 moon run server:build
```

`service.rs` also builds the feature once per test process, so direct Cargo test
runs cannot silently consume an obsolete bundle. Every build copies source
fixtures into a fresh, exclusively owned `packages/server/target/tkm5-feature-*` directory
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
ignored `packages/server/target/tkm5-databases` and remove them after awaited shutdown.
There are no added dependencies or enlarged native stacks.

## Agent turns on both local runtimes

The Claude, Codex, AI, chat and code acceptance tests use a real server and
database. The test launcher uses the Rust runtime selector: unset means
QuickJS on macOS and Linux, where an empty value is an error. Windows ignores
`TOKAMAK_PLUGIN_RUNTIME` and uses Bun. On macOS and Linux, set the variable to
`bun` to exercise the temporary fallback. See the
[plugin runtime guide](../../sdk/README.md#plugin-runtimes) for the differences.

Run the Linux Rust CI sequence locally with `bash .ci/check.sh rust` on macOS
or Linux. The Runner and full host use `target`; the Server and actions-only
host use `target/cloud`. The test matrix is:

| Build and runtime      | Suites                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Runner / Bun           | Claude and Codex replays, Code snapshot and change tests, workers, Bun supervisor units and graceful Runner shutdown                 |
| Runner / QuickJS       | Runner and worker tests, full host protocol and program tests, AI and agent replays, Chat and Code; local functions on both runtimes |
| Both QuickJS builds    | Server units and CLI, actions, plugins, routing, service and workers                                                                 |
| Cloud Server / QuickJS | Actions-only host, identity and sign-in, data, cancellation, indexes, schemas and SDK transport                                      |

The routing test uses a separate Runner for the machine's local functions and
runs the shared workspace against both `tokamak-server` builds. To run just
the cloud case, first build both binary pairs:

```sh
cargo build --locked -p tokamak-runner -p tokamak-plugin-host
cargo build --locked --no-default-features -p server -p tokamak-plugin-host --target-dir target/cloud
TOKAMAK_TEST_RUNNER_HOST="$PWD/target/debug/tokamak-plugin-host" \
  TOKAMAK_TEST_RUNNER_BIN="$PWD/target/debug/tokamak-runner" \
  cargo test --locked --no-default-features -p server --target-dir target/cloud --test runner_routing
```

Bun writes the Claude and Codex reference files to a shared temporary directory.
QuickJS requires those files and compares the final text, thinking, usage,
session, state, tasks, plan and ordered reports. The local functions suite also
runs a server, a local function and an action with the setting unset and an
empty PATH.

## Codex replay

`CARGO_BUILD_JOBS=2 cargo test --locked -p server --test codex_turns` builds
and installs the Codex provider in a real server and drives it through the
client's local worker against sanitized app-server replays. It runs in CI and
does not require a Codex executable or login. See the
[Codex test instructions](../../../plugins/codex/README.md) for the separate
opt-in real program check and the replay privacy scan.

## TKM7 transport and ownership acceptance

`sdk_transport.rs` runs the same `TokamakClient` workflow in
`sdk-transport-driver.mjs` through two real native sessions (a test-only stdio
message bridge, no listener) and two real WebSockets connected to the shipped
headless binary. It covers query/mutation kind enforcement, error correlation,
whole-call rollback, writer update-before-reply, second-client live updates,
unsubscribe, local-only CLI/library binding, failed-bundle cleanup, cancelled
and concurrent/repeated shutdown, idle upgraded sockets at SIGTERM, persistence
and immediate disk reopen. A counting wrapper around real QuickJS additionally
proves that native owner drop and peer WebSocket close stop executing subscription
queries; merely suppressing late UI callbacks would not satisfy that assertion.

`shutdown-driver.mjs` adds real-CLI shutdown regressions. Its slow mutation
awaits an insert, then occupies normal QuickJS synchronously for 1500ms. The
saturation test sends it before 64 queued queries plus an overflow sentinel on
one FIFO WebSocket; connection refusal before handler retirement is observable
admission-pressure evidence. SIGTERM must still exit successfully and the row
must survive reopening. A no-queue control uses the same handler and storage.
The partial-upgrade test holds incomplete HTTP headers open, then completes a
separate SDK upgrade/query as accept-loop progress evidence. Shutdown must finish
within three seconds and allow reopening without first releasing the raw peer.
An additional under-capacity CLI case sends one active slow mutation and one
or eight queued fast mutations. A marked protocol Ping/Pong after their FIFO
text frames proves adapter admission progress before the slow handler replies;
SIGTERM must preserve all rows even when it exits successfully. A deterministic
native counterpart gates real QuickJS after its first awaited write, obtains
successful `SessionSender.request` admission for eight queued mutations, then
compares retained-session and dropped-session shutdown. Disk reopen checks all
nine writes rather than relying on replies whose receiver has disappeared.
Both drivers clean up child processes, sockets, streams and owned storage on
failure; neither changes production stack sizes or implementation code.

`internal/datastore_owner.rs` is a **private child module** of `data`, enabled
only for unit tests. It compares native reads/writes on the retained explicit
Datastore with public adapter transactions, tests invisibility before commit and
after rollback, native/SDK typed conflicts, and uses a weak owner reference to
require actual ownership release at awaited close. Diagnostic native writes do
not publish tracked events. No raw capability is exported to feature code and
no second SDK attachment is made. Only this native SQL diagnostic follows the
existing data-test enlarged-stack convention; all Backend/QuickJS tests retain
normal production-sized host/worker stacks.

The normal `server:check` dependency executes generated protocol drift checking.
The native bridge serializes the actual Rust protocol events, so SDK/native/WS
interoperability does not depend on a second hand-maintained test protocol.
The driver requires Bun and, for headless shutdown coverage, Unix SIGTERM.
All builds and data directories belong to the local worktree; no parent target
or live application storage is modified.

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

## TKM-45 action regressions

`actions.rs` builds isolated plugin artifacts with the public builder through
`build-actions.mjs`, then runs `actions-driver.ts` over the same real SDK native
session bridge pattern as TKM7. The contract and same-connection lane tests
also run through the real loopback WebSocket adapter/SDK transport. The driver is checked against the builder's
fresh generated API before being bundled. No JavaScript executes in Bun except
build tooling, the transport client, and the local mock; handlers run in QuickJS.
The pinned AI SDK test dependencies are build/test-only root dev dependencies.

Run `CARGO_BUILD_JOBS=2 cargo test --locked -p server --test actions`. Its ten
regressions cover:

| Spec                                                              | Runnable test(s) in `actions.rs`                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1. Action kind, separate transactions, short budget, typed client | `action_kind_and_independent_transactions_outlive_normal_budget`                                             |
| 2. Same-connection progress while an action awaits a timer        | `pending_action_does_not_block_same_connection_transactions`                                                 |
| 3. Effect/permission checks, incremental bodies, redirect checks  | `fetch_checks_effects_permissions_streaming_and_redirects`                                                   |
| 4. Native disconnect on abort                                     | `abort_disconnects_http_before_action_returns`                                                               |
| 5. Advancing action time, frozen nested time, unseeded randomness | `action_clock_advances_but_nested_transactions_freeze_time`, `action_random_ignores_transaction_replay_seed` |
| 6. Private cross-plugin queries and mutations                     | `actions_enforce_cross_plugin_exports`                                                                       |
| 7. Pinned AI SDK against local OpenAI-compatible SSE              | `pinned_ai_sdk_streams_multiple_deltas_offline`, `pinned_ai_sdk_abort_disconnects_mid_stream`                |
| 8. Unsupported API error                                          | `missing_web_api_fails_loudly`                                                                               |

HTTP mocks bind `127.0.0.1:0`. Each response chunk/delta waits for a consumer
acknowledgement before the next is sent, so buffering the entire body cannot
pass. Abort tests keep the action alive on another request until the mock sees
the original HTTP disconnect; teardown cannot substitute for cancellation.
The mock uses a literal placeholder credential and never contacts a provider.
A fixed public replay input tests that fresh action worlds do not seed
`Math.random`; nested transaction tests separately require a frozen clock.
Two nested queries bracket a committed mutation and must see different snapshots.
The contract scenario's normal call budget is 150 ms, compared with a 600 ms action await. A
1,000 ms timer bounds the same-connection ordering check. All waits have outer
bounds and child processes/artifacts/sockets have failure cleanup.

Fails-without verification (2026-11-09): every new test failed under a relevant
temporary product mutation. All 15 targeted mutation/test runs exited 101 with
`test result: FAILED`; all product sources were then restored byte for byte.
No mutation is part of the committed tests.

| Temporary disabled behaviour                               | Regression/failure observed                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Arm a 150 ms action deadline                               | Contract: 600 ms action rejected with `runtime call exceeded its wall-clock budget`                                          |
| Expose a database on the action context                    | Contract: `noDb` was `false`, expected `true`                                                                                |
| Await an action on the serialized coordinator              | Lane: `query and mutation must finish before the action timer`; actual settled `true`                                        |
| Remove the native network permission gate                  | Fetch: `denied fetches must send no request`; actual `['/denied']`, expected `[]`                                            |
| Disable the transactional web-effects guard                | Fetch: expected `fetch is forbidden in queries and mutations`, received a generic missing-response error                     |
| Skip the redirected hostname by retaining the granted host | Fetch: missing expected `net:localhost` rejection                                                                            |
| Omit native HTTP cancellation from abort                   | Both direct and AI SDK abort tests: observed `timeout: HTTP disconnect while action is still alive`, expected `disconnected` |
| Install deterministic transaction inputs in actions        | Clock: before/after remained equal; random: identical eight-draw sequences with the same replay seed                         |
| Omit transaction determinism                               | Nested clock: before/after differed by 23 ms                                                                                 |
| Remove cross-plugin export enforcement                     | Exports: missing expected `privateRead is not exported by b` rejection                                                       |
| Close each response body after its first chunk             | Fetch: only `first`; AI SDK: only `one`, instead of three ordered chunks/deltas                                              |
| Replace unsupported API errors with constructor stubs      | Missing API: generic JSON-result error instead of the named unsupported `WebSocket` error                                    |

Final validation on top of `fccfe96e3e7ad346106756a832f635e42affc149`:

| Command/environment                                 | Result                     |
| --------------------------------------------------- | -------------------------- |
| `CARGO_BUILD_JOBS=2 moon run :check :test :e2e`     | 28 tasks completed, 3m 28s |
| Same command with `CLAUDECODE=1 AI_AGENT=1`         | 28 tasks completed, 2m 45s |
| `cargo fmt --all -- --check` and `git diff --check` | Passed                     |

The injected `NODE_REPL_TOOL_OVERRIDES` value contained invalid UTF-8. It was
unset for the runs because proto/Cargo build scripts cannot read that entry.
No environment workaround is shipped. No product bug was exposed, and no
product code changes remain.

## TKM-45 fix regressions

The `web_fix_*` tests in `actions.rs` extend the same isolated public-builder,
real engine/server and SDK transport harness. `fixtures/actions/a/src/server/web.ts`
contains the action probes, and `actions-driver.ts` owns the loopback HTTP peers.
Run the focused suite with:

```sh
CARGO_BUILD_JOBS=2 cargo test --locked -p server --test actions web_fix_
```

| Review finding                         | Regression coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Connected-address network authority | `web_fix_network_checks_resolved_addresses_and_canonical_hosts`: granted names resolving to loopback, private, metadata and IPv4-mapped IPv6; redirected loopback denial; explicit localhost/IP access; integer, hex, shortened and mapped address spellings.                                                                                                                                                                                                                                                                                 |
| 2. Prompt native disconnect            | `web_fix_abort_disconnects_while_javascript_is_busy`, `web_fix_{return,throw,cancel}_disconnects_with_worker_idle`: the peer observes EOF while the pool remains allocated, before any next job can drive teardown.                                                                                                                                                                                                                                                                                                                           |
| 3. Native slot reclamation             | `web_fix_decoder_{readable_cancel,writable_abort,transform_error,invalid_input}_releases_slots`, `web_fix_timer_clear_error_and_timeout_release_slots`, `web_fix_{cancelled,errored}_body_readers_release_slots`, `web_fix_{denied,preaborted}_upload_cancels_native_source`, `web_fix_early_response_cancels_native_upload_source`: 130 cycles per path within one action, followed by working timers and decoders. Return/throw retirement also repeats 130 times with abandoned readers, incremental decoders, timers and timeout signals. |
| 4. Body ownership                      | `web_fix_request_and_response_bodies_cannot_be_reused`: POST Request consumption/TypeError, direct-reader disturbance after releasing the lock, rejected reads/clones and preserved pre-read request/response clones.                                                                                                                                                                                                                                                                                                                         |
| 5. Live search parameters              | `web_fix_retained_search_params_remain_live`: retained identity, duplicate values, search/href replacement, reverse edits, empty search and form encoding.                                                                                                                                                                                                                                                                                                                                                                                    |

The network regression compiles `fixtures/actions/resolver.c` into an owned test
artifact and interposes OS name lookup only in its child process (macOS/Linux).
The child verifies the numeric answers before running acceptance. This exercises
the resolver actually used by reqwest, needs no external DNS/internet and changes
no system files. A connect observer records and blocks attempts to the private
and metadata test addresses, preventing generic connection errors from passing
the rejection assertions or sending packets outside the machine. The log must
stay empty. All other names/connections behave normally. The existing native compiler
is used; no package/dependency or runtime hook is added.

HTTP waits are bounded by four seconds. The busy-JS abort probe occupies JS for
500ms; its peer must record disconnect before that interval ends. Cancellation
uses the public action pool lifecycle and keeps the cancelled pool alive until
EOF, independently of pool/runtime destruction. Reader-error tests gate a
truncated HTTP body on a second request. Upload tests transfer a real open fetch
body into denied, pre-aborted and early-completed POSTs, then observe all source
connections closing. Each mock/artifact/process is owned by the current test.

Fails-without evidence for the seven review fixes (all targeted runs exited 101):

| Temporarily reversed runtime fix              | Failing regression/output                                                                                                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `f6d6917` resolved-address gate               | Network: `AssertionError: Missing expected rejection` for the granted loopback-resolving hostname.                                                                               |
| `e4ffb90` native retirement/background driver | Return and throw: `timeout: HTTP disconnect after retirement 0 with idle worker`; cancellation: `HTTP stayed open after cancellation while worker idle`. All three tests failed. |
| `6c40823` slot cleanup                        | All four decoder tests and the timer test: `web resource limit exceeded (64)`.                                                                                                   |
| `e4b1d58` body disturbance/transfer           | Bodies: `fetch did not consume original Request`.                                                                                                                                |
| `154e93a` retained search parameters          | Params: `search replaced params identity`.                                                                                                                                       |
| `95c1ce6` upload source cleanup               | All three upload tests: `web resource limit exceeded (64)`.                                                                                                                      |
| `d900054` independently driven native I/O     | Busy abort: `HTTP closed at 1794221673519, JS ended at 1794221673519`; disconnect failed to precede the end of JS.                                                               |

The two reader tests are additional controls for behaviour already present
before these fixes: they still passed with `6c40823` reversed. To prove they
also bite, that reversal plus temporarily omitting the JS native `cancel` call
made **both** fail with `web resource limit exceeded (64)`. This distinguishes
existing JS cleanup from the added independent native error cleanup rather than
claiming the fix introduced both paths. All temporary product changes were
restored; none belongs to the test commit. No product bug was exposed.

The expanded suite runs 27 tests concurrently. Only the deadline contract
scenario uses the artificial 150ms transaction budget; other scenarios use the
normal one-second budget so contention does not turn the nested-clock probe
into an unrelated deadline test. The first full run exposed that harness
contention (26/27 passed, all 17 new tests passed); no product bug was found.

Validation base: `d900054c43b271e7edb63b5c68d44a5edfb1d5f7`.
The normal `CARGO_BUILD_JOBS=2 moon run :check :test :e2e` run completed all
28 tasks in 9m 29s (including first-run native dependency checking). The actions
binary passed all 27 tests, including these 17 new regressions. The invalid-UTF-8
`NODE_REPL_TOOL_OVERRIDES` entry was unset for validation, as in prior runs.
The same command with `CLAUDECODE=1 AI_AGENT=1` completed all 28 tasks in
3m 23s; all 27 action tests passed again. `cargo fmt --all -- --check`,
`git diff --check`, and a zero product-source diff also passed.

## Chat and agent turns

Use `.ci/check.sh rust` for the offline suites, including Chat threads, agent
turns, liveness, code snapshots, and the Claude and Codex replays.
