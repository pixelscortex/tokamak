# Native plugin installation (M1.2)

The server can load a directory of built plugin projects, or directories
containing their artifacts. This is a trusted personal-plugin system, not a
malicious-code sandbox.

## Build and run

Declare static metadata through `definePlugin` (or pass its descriptor to
`tokamak({ plugin: ..., ui: false })` in `vite.config.ts`). The maintained
Vite/Solid compiler and SDK builder generate `dist/manifest.json`, code, maps
and typed API references. Do not author the artifact manifest by hand.

```sh
proto run bun -- packages/build/src/build.ts path/to/plugins/notes
cargo build --locked -p server --bin tokamak --jobs 2
target/debug/tokamak --plugins path/to/plugins --local-dir path/to/private-server
```

The local directory requires the same private `server.token` as the desktop
launcher. Never pass the token in arguments. The launcher still defaults to the
single application bundle until the client-plugin loader is integrated in M1.3.
`--plugins` and legacy `--bundle` are mutually exclusive.

```sh
TOKAMAK_SERVER_DIR=path/to/private-server target/debug/tokamak plugin list
TOKAMAK_SERVER_DIR=path/to/private-server target/debug/tokamak plugin reload acme.notes
```

The control CLI validates loopback discovery, uses bearer authentication, disables
proxies and redirects, and does not replay requests. Control endpoints are only
registered in capability-protected local mode:

- `GET /plugins`: live manifest/function metadata and generation revision.
- `POST /plugins/{id}/reload`: validate and reload the configured installation.
- `GET /plugins/{id}/assets/{name}`: declared UI files from the verified snapshot.
  Never arbitrary files, backend source, capability tokens or generated backend API.

## Loading and reload contract

Static validation resolves one version per ID, host API compatibility, required
and present optional dependencies, conflicts and cycles **before evaluating any
module**. Rust's maintained `semver` implements range semantics. A `depends`
target must exist; an absent `optional` target is fine, but a present incompatible
version is an error.

Artifact SHA-256 hashes detect incomplete builds. Paths and asset symlinks cannot
escape the artifact directory. Files are bounded, verified and retained in memory
as an immutable generation. These are corruption/mixed-build checks, not signatures.
The loader allows at most 64 plugins and 64 MiB of retained artifact bytes;
this is not a hard RSS limit (QuickJS worlds and decoded code allocate separately).

Reload is serialized with admitted calls: old calls finish their commit/rollback
first. The full candidate installation resolves and is inspected before one
generation swap. Failed reload leaves old code, subscriptions and data usable.
Successful reload dirties all subscriptions; removed or changed-kind queries
produce explicit subscription errors. The named ID must be present in the old or
new installation; dependent callers reload together. This is not stateful HMR.
Discovery's `bundleHash` identifies startup; `/plugins` reports the live revision.
Legacy `Server::descriptor()` is a startup snapshot; use `Server::plugins()` for
ordered live plugin metadata.

## Calls, data ownership and capabilities

Generated API references for explicitly declared plugins carry names such as
`acme.notes/notes:list`; references never import server handlers into the client.
Inside a handler, `ctx.use(otherApi).notes.list({})` invokes the host. A caller
must declare the target as a dependency, or consume an interface it provides.
Declare `exports: "./api.ts"` and re-export public backend definitions from that
module. The build records their backend names in the artifact; undeclared functions
are private to other plugins. Omitting `exports` exposes nothing. This check also
applies to calls through provider references; own calls and client calls are unchanged.
`ctx.providers<ProviderApi>("interface")` enumerates all matching installed
implementations, whose references can then be bound with `ctx.use`.

Every callee gets its own namespace and host-owned identity. Nested mutations
share the outer database transaction; all writes commit together or none do.
Native failures poison the whole transaction even if plugin code catches them.
Queries cannot call mutations, including queries invoked within a mutation.
Read dependencies accumulate transitively for subscription invalidation.

Backend queries and mutations fix one host timestamp and random seed per logical
invocation, before any conflict retries. `Date.now()`, `new Date()` and `Date()`
use that time; explicit date arguments still work. `Math.random()` uses a seeded
PRNG. Retries reuse both inputs, and nested calls share the timestamp with random
streams derived deterministically from their call order. The UI runtime keeps its
live clock and randomness. Clock-dependent queries do not automatically refresh
as time passes; subscriptions rerun when their data dependencies change.

Delegation evaluates self-contained modules in the same invocation world, heap
and time budget; it never awaits a second worker from a bounded worker pool.
One-worker operation is tested. Results cross as JSON-compatible values, not
JavaScript capabilities. Call-path cycles fail; engine limits also cap delegation
at 16 levels / 256 calls per root invocation. This shares a JS realm between
trusted plugins and is not a realm-isolation security guarantee.

Own-space data access is implicit. Foreign-space data access is denied; public
plugin APIs are the mediation boundary. Interface/dependency declarations mediate
calls. Declared capabilities are auto-granted and logged once per plugin version,
with records in the reserved `tokamak.host` namespace. Changing permissions
requires a version bump; the system does not silently extend an existing grant.
No user plugin can install as `tokamak.host`.
Grant records use deterministic native record keys, so version lookup does not
scan the ledger or execute SurrealQL predicates. The internal keyed CREATE is
not an upsert and is not exposed through the JavaScript database API.

**Network execution is not implemented in M1.2.** A `net:host` declaration is
metadata, not a working fetch API. Actions, actual network capability enforcement
and denied/allowed fetch tests belong to M2.1; queries and mutations must not
gain external effects that could repeat during transaction retries. No Node/Bun
runtime, plugin grant prompt, marketplace, signing, Wasm or untrusted sandbox ships
here.

## Evidence

`cargo test --locked -p server --test plugins --jobs 2` builds real SDK plugins
through the public artifact command. It tests one-worker nested calls, atomic
rollback after caught callee failure, scoped IDs, query-to-mutation denial, call
cycles, two interface providers, transitive subscriptions, edited-code reload,
failed-reload preservation, permission-change rejection and subscription refresh.
It also runs the real standalone binary/control CLI against isolated disk storage,
checking authentication, Origin rejection and backend-source non-exposure.

`plugins::tests` covers static resolver failures, traversal/symlink/hash checks
and immutable UI snapshots. Engine module tests cover shared-worker delegation
and caught/abandoned child error observation. These are self-authored tests,
not an independent review or proof of hybrid sync/long-running AI.
