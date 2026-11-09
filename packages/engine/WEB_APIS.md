# Action web APIs

Tokamak embeds QuickJS through `Engine`. Bun bundles JavaScript at build time;
neither Bun nor Node is used at runtime. Native web operations exchange owned
JSON and byte chunks through `OpRegistry`, so they do not depend on QuickJS.
`web::install` is the small engine-specific adapter.

## Surface

| API | Implementation and limits |
| --- | --- |
| `fetch` | Rust reqwest 0.13.5, HTTP(S), streaming upload/download, 64 KiB bridge chunks, one queued upload chunk. Permission `net:<hostname>` checked before opening **each** request, including redirects. Exact canonical URL hostname, no wildcard grants. URL credentials and other schemes rejected. |
| `ReadableStream`, `WritableStream`, `TransformStream`, readers/writers and queuing strategies | Vendored **web-streams-polyfill 4.5.1**, MIT, released 2026-11-06. Upstream `dist/polyfill.js` is 71,295 bytes; no runtime npm resolution. License alongside source. |
| `TextEncoder`, `TextDecoder`, `TextDecoderStream` | Small JS adapters; Rust UTF-8 encoder and encoding_rs decoder. Incremental decoding preserves split code points and BOMs; decoder supports fatal/ignoreBOM. |
| `AbortController`, `AbortSignal` | Small JS implementation, with reasons, `throwIfAborted`, `abort`, `timeout`, `any`. Abort wakes the native request/read/write future and drops its HTTP resources. |
| `Event`, `EventTarget`, `DOMException` | Minimal support for abort listeners, including once/removal. No DOM tree or event propagation. |
| `Headers`, `Request`, `Response` | Small JS adapters over the Rust transport and web streams. String, typed-array, ArrayBuffer, URLSearchParams and stream bodies; text/JSON/bytes/ArrayBuffer readers, clone, response JSON and redirect helpers. No multipart or Blob bodies. |
| `URL`, `URLSearchParams` | Rust url 2.5.8 parses/resolves/canonicalizes URLs. Small JS property/search-parameter adapter. Search params support duplicate keys and form encoding. |
| `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` | Tokio timers, numeric handles, function callbacks only. Cancel wakes the pending timer; no timer thread/task is detached. |
| `crypto.randomUUID`, `crypto.getRandomValues` | OS randomness through getrandom. UUID v4, integer typed arrays, 65,536-byte quota. No `crypto.subtle`. |

## Network authority

Grants are exact `net:<host>` entries, independent of port. Both grants and
request hosts use URL/IDNA canonicalization: lowercase ASCII/punycode, no trailing
dot, canonical IPv4 (including integer/hex/short forms), and bracketed IPv6.
IPv4-mapped IPv6 normalizes to IPv4. Userinfo, ports and URL delimiters are not
valid in grants; request URL credentials are rejected.

A hostname grant authorizes only public destination addresses. A custom reqwest
resolver filters the actual address iterator used to connect, on every request
and redirect; there is no separate check followed by another DNS resolution.
Mixed answers retain only public addresses. Private, loopback, link-local, CGNAT,
unspecified, multicast, reserved/documentation and transition ranges are excluded;
IPv6 is conservatively limited to global unicast outside special-purpose ranges.
This includes `169.254.169.254` and `fd00:ec2::254` metadata endpoints. Ambient
HTTP proxies are disabled so they cannot bypass this resolver.

Non-public access requires an explicit IP grant, e.g. `net:127.0.0.1`,
`net:192.168.1.10` or `net:[::1]`. `net:localhost` is a convenience for local
servers such as Ollama: it connects only to `127.0.0.1`/`::1`, without DNS or
hosts-file overrides. These grants do not authorize other hostnames that happen
to resolve to the same IP. No private-range or wildcard grants are supported.

The native resource table has a shared maximum of 64 HTTP exchanges, pending
timers and active incremental decoders per invocation. Returning or throwing
retires the lease and drops the world and its native futures. Readers apply
backpressure; `.text()`, `.json()`, `.bytes()` and `.arrayBuffer()` intentionally
consume the whole body and are subject to the JS heap cap. Unused bodies should
be cancelled. Redirects default to follow (20 hops), with a fresh permission
check each hop and credential-header stripping on origin changes. Replaying a
stream body across a preserving redirect is rejected; 301/302 POST and 303
switch to GET. `manual` and `error` redirect modes are supported.

This is a server-side API subset, not browser conformance. Header storage
combines repeated values; `getSetCookie` cannot preserve individual repeated
Set-Cookie values. The minimal event classes do not implement DOM propagation,
capture, listener signals or passive listeners. URLSearchParams malformed percent
sequences do not yet have the complete WHATWG replacement-character behavior.

Queries and mutations cannot fetch or use other external effects. Unsupported
APIs fail explicitly: Blob, File, FormData, WebSocket, XMLHttpRequest, Worker,
EventSource, TextEncoderStream and crypto.subtle. There is no process, require,
Node/Bun module loader, filesystem API, browser DOM, storage or ambient env.
Unknown globals are absent and normal JS access/calls throw ReferenceError or
TypeError. Bundles must contain their dependencies.

## Dependency choice

The npm registry was checked on 2026-11-09. The streaming smoke uses **ai
7.0.166** and **@ai-sdk/openai 4.0.111**, bundled for the browser target. The
current streams polyfill is maintained, dependency-free and already implements
backpressure, teeing and cancellation. Writing these algorithms by hand would
add substantial correctness risk. Its pinned npm integrity is
`sha512-pFmV/G8K9uKW3I3xx3vqpKYLBer7K1wZej5uU66zhtjzG1bfE6e+OHNxhmGb9UsXe+geX4/lndxJDgs7wbYO9g==`.

`abort-controller` 3.0.0 was last released in 2019 and depends on
`event-target-shim`; it lacks the modern static signal/reason helpers used by
current SDKs. Small local abort classes avoid adding that outdated contract.
Encoding and URL parsing use maintained Rust libraries rather than duplicating
Unicode/URL algorithms in JavaScript.

LLRT was inspected as the fallback: crates.io `llrt_modules` **0.8.1-beta**
(released 2026-07-28) depends on **rquickjs 0.11**, incompatible with our pinned
**0.14.0**. Published compressed crate sizes are 42,064 bytes for modules,
74,290 for llrt_stream_web, 43,047 for llrt_fetch and 12,835 for llrt_url, before
transitive dependencies or compiled code. Its default surface includes Node
modules. Direct llrt_fetch adoption would also require replacing/intercepting
its transport to enforce our per-request permission check. No piece proved
impractical with the selected JS/Rust approach, so no LLRT code is vendored;
there is no claimed LLRT binary-size measurement.

## Phase 1 evidence

Throwaway sources, mock server and logs live in ignored `spikes/tkm-45/`.
The Rust runner installs the surface into rquickjs **0.14.0**, evaluates the
browser bundle, calls its async export and forwards deltas through a native
callback. The Python mock sends OpenAI chat-completion SSE chunks every 200 ms.

On aarch64 macOS, three callback tokens arrived at 06:46:36.606981,
06:46:36.805187 and 06:46:37.007857 UTC. The callback aborted after token three;
the mock logged `DISCONNECT` at 06:46:37.416115 UTC. Without `net:127.0.0.1`,
the SDK reported `fetch permission denied: requires net:127.0.0.1`, with zero
tokens and no additional mock request. No OPENAI_API_KEY or ANTHROPIC_API_KEY
was set; a real-provider call was not run.

QuickJS `JSMemoryUsage.malloc_size` (64 MiB configured cap): bare context
**100,744 bytes**; installed web surface **613,464** (+512,720); AI SDK bundle
loaded **6,845,760**; after the three-token abort **7,312,920**. These are the
engine's allocator counts, not whole-process RSS; TLS/native buffers and Rust
resource tables live outside the JS heap and have separate resource/chunk caps.

A separate throwaway proof streamed three request-body chunks to the mock at
150 ms intervals (5 bytes each), decoded the 15-byte JSON result, exercised
incremental UTF-8/BOM handling, stream transforms, clones, timer cancellation,
intervals, signal composition, UUIDs and integer-array randomness. A redirect
from allowed `127.0.0.1` to ungranted `localhost` was rejected before the target
request. Across separate processes holding 50 worlds, bare RSS was 16,384 KiB
and web-enabled RSS 52,496 KiB: approximately **722 KiB added per world**,
including native/runtime overhead (allocator and OS dependent).

Release binary (workspace size-oriented profile, stripped LTO, aarch64 macOS):
baseline `5f3b3be` **39,923,312 bytes**; Phase 1 web-enabled binary **40,253,904 bytes**;
added **330,592 bytes** (0.83%). The baseline was built from original
server/engine sources in an ignored minimal workspace with the original lock
versions; the changed binary used the normal workspace release build.

## Action scheduling and Phase 2 evidence

The SDK exports `action({...})` and schema-bound `createFunctions(...).action`.
Generated `api.*` references carry the action kind; `client.action(...)` uses the
same correlated response protocol over native and WebSocket transports. Actions
receive `runQuery`, `runMutation` and `providers`, with no `db` or `use` property.
A forged nested-call kind is checked again in Rust. Cross-plugin calls use the
existing dependency/interface/export resolver and the target's data space.

The server admits actions to a **separate two-thread pool**, with 32 queued jobs
and at most 34 outstanding completion tasks. Query/mutation requests stay on the
serialized coordinator. Nested calls rejoin that coordinator with their own
transaction and normal writer/subscription barrier. The action never owns a
database/transaction handle and is never automatically replayed. The configured
JS heap cap applies to both lanes. `ActionEngine` never sets a clock deadline or
wraps evaluation in a timeout; this includes module initialization. Both load and
call time budgets are ignored on the action lane. Queries and mutations retain
their existing budgets and cannot obtain network authority.

Deterministic time and `Math.random` are opt-in through `OpRegistry`. The server
opts in for queries and mutations, including `runQuery`/`runMutation` from an
action, and reuses those inputs across conflict retries. Nested transactional
plugin calls retain the fixed clock and derived random streams. Actions keep the
real clock, native `Math.random`, and OS-backed crypto randomness; timers advance
normally. Inspection and other engine calls do not opt in automatically.

Explicit shutdown/reload uses a cancellation token, independent of time limits.
It wakes idle I/O/timers and interrupts busy JS, retires capabilities and drops
the world before joining workers. Reload cancels the old pool before publishing
the new installation; old-generation nested commands are also rejected. Accepted
nested mutations finish their commit/rollback and barrier even if the action
stops waiting. Ordinary client disconnect does not retract accepted work.

The ignored `server-proof` executable exercised the public plugin builder,
generated API, real QuickJS action engine, embedded database and session protocol:

| Acceptance | Observed proof |
| --- | --- |
| AI SDK inside an action | Three token mutations produced three subscription callbacks at about 386, 642 and 899 ms; the final action result was `{count:3, aborted:true, rows:3}` after `runQuery`. |
| Abort closes HTTP | The local SSE mock logged `DISCONNECT` after the action's controller aborted. The consumer breaks after abort because the AI SDK may already have buffered additional deltas. |
| Missing permission | A second plugin artifact with no grants rejected its action with `fetch permission denied: requires net:127.0.0.1`; no request reached the mock. |
| Query/mutation fetch | Both SDK definitions failed with `fetch is forbidden in queries and mutations`; neither could start HTTP. |
| Separate lane | Both action workers awaited 1,500/1,600 ms timers; a query completed in 134 ms, before either action, and both actions later succeeded beyond the normal one-second budget. |
| No transaction held | The action context had no `db`; all three writes used `runMutation`. Closing with a live 1,800,000 ms timer succeeded in 8 ms instead of returning the database's Busy error. |
| No idle deadline | A direct pool proof ignored a configured 10 ms call budget and completed a 153 ms await. The server proof exceeded the default one-second budget. The source has no time check on this lane; the 30-minute timer was cancelled explicitly, not waited out. |
| Explicit lifecycle stop | Cancelling a pool running `while(true){}` completed in under 1 ms in the throwaway proof. |
| Typed/client API | Throwaway strict type checks rejected action `db`, query-as-mutation references and actions through transactional contexts. `client.action` emitted an `action` request with `proof/ops:noDb` and correlated its response. |

For browser-targeted third-party declarations, action authors can opt into the
SDK's type-only `@tokamak/sdk/web` entry. It provides standard DOM declaration
libraries, which are a **typing superset**, not a runtime compatibility promise.
The portable SDK's own source checker still allows only ES2022. The AI SDK's
Node HTTP/Buffer and JSON Schema type references need build-only `@types/node`
and `@types/json-schema`; no Node module is present in the browser bundle or
loaded by QuickJS. Console, process/env, filesystem and all other non-listed APIs
remain absent. Configure the AI SDK's error callback when handling provider
errors rather than depending on a console global.

Current limitations include the documented web subset rather than full WHATWG
conformance, JSON byte-array marshalling overhead, and native TLS/HTTP buffers
outside QuickJS's allocator (request/decoder/timer counts and bridge chunks are
bounded separately). Event listener errors propagate after all registered
listeners have run, so an application exception cannot suppress HTTP abort.
The mock covers OpenAI chat-completion SSE; real-provider/TLS behavior and other
AI SDK modalities were not exercised without keys. Final regression tests are
intentionally left to the separate test-writer.

Final action-enabled release, rebuilt after the scheduling/reload changes:
**40,320,144 bytes**, compared with **39,923,312 bytes** baseline: **+396,832 bytes
(+0.99%)**. This is the complete action + web API cost, separate from
the Phase 1 surface-only comparison above.

Final-source allocator recheck: bare **100,744**, surface
**615,416**, SDK loaded **6,847,536**, after abort
**7,314,696 bytes**. Separate 50-world processes measured 16,368 KiB
bare RSS and 52,992 KiB with APIs, or **732.48 KiB added per world**; the modest
variation from Phase 1 reflects allocator/OS variability and the final adapters.

An additional real WebSocket proof drove `TokamakClient(WebSocketTransport)`
against the public server adapter: an action and concurrent query shared one
socket, the query completed in **149 ms**, the idle action returned after
**1,502 ms**, and the SDK streaming action returned three persisted rows with
`aborted: true`. The controller used Bun only as throwaway build/test tooling;
all action execution and outbound provider HTTP ran in QuickJS/Rust.

## Workspace verification

`CARGO_BUILD_JOBS=2 moon run :check :test :e2e` passed all 28 tasks in
3 minutes 30 seconds. `cargo fmt --all -- --check` and `git diff --check`
also passed. The runner's injected environment included invalid UTF-8 values;
an ignored launcher removed only those entries before executing the commands,
because Cargo dependency build scripts and proto otherwise panic reading them.
No environment workaround is shipped.

Existing test support was kept compiling with the new action request variant.
The build tests' existing scratch helper also received a counter suffix: parallel
tests could share a timestamp on this platform and overwrite each other's files.
No final action regression tests were added; all new behavioral probes remain
in the ignored spike directory for the separate test-writer's handoff.
