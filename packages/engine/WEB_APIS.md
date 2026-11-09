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

On aarch64 macOS, three callback tokens arrived at 08:46:36.606981,
08:46:36.805187 and 08:46:37.007857 UTC. The callback aborted after token three;
the mock logged `DISCONNECT` at 08:46:37.416115 UTC. Without `net:127.0.0.1`,
the SDK reported `fetch permission denied: requires net:127.0.0.1`, with zero
tokens and no additional mock request. No OPENAI_API_KEY or ANTHROPIC_API_KEY
was set; a real-provider call was not run.

QuickJS `JSMemoryUsage.malloc_size` (64 MiB configured cap): bare context
**100,744 bytes**; installed web surface **613,464** (+512,720); AI SDK bundle
loaded **6,845,760**; after the three-token abort **7,312,920**. These are the
engine's allocator counts, not whole-process RSS; TLS/native buffers and Rust
resource tables live outside the JS heap and have separate resource/chunk caps.
