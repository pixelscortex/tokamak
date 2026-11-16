# Client realm isolation: design and vertical slice

Status: experimental, opt-in test host only. **Normal application plugin loading
still uses the shared-context `ModuleRegistry` and is not isolated.** This is the
explicitly permitted design + working vertical slice, not a finished security
boundary for production plugins.

## Why this is a rendering change

`new Function` plus a frozen `globalThis` facade cannot isolate code in the same
context. The current SDK also deliberately shares Solid owners, context provider
identity, component functions and native node objects. Moving only factory
execution into another context would retain direct references to shell objects
and shared intrinsics. Moving all these mechanisms requires a coordinated
component, lifecycle and error protocol.

## Mechanism implemented

One window retains one QuickJS runtime/GC and one Blitz document. The shell has
its context; each loaded plugin in the slice gets a `JS_NewContext` with fresh
globals and intrinsics. The same bootstrap is evaluated independently to provide
local Solid, renderer, UI and SDK modules. Only the shell branch mounts the shell.
Plugins get no native socket, clipboard or timer capability in this slice.

Rust owns the context references. Calls run on the UI thread under the existing
rquickjs runtime lock; a narrowly scoped `Ctx::from_raw` enters another context
without reacquiring its non-reentrant async lock. Context references remain owned
until window teardown. Only owned JSON strings return across that entry; no
rquickjs `Value`, `Function`, object or Solid owner crosses contexts.

The wire codec copies JSON-compatible data and represents functions as native
call grants. A realm can publish its own functions or forward grants it already
has. Rust translates grants for each recipient. Guessing another realm's name or
local function ID confers no authority. Only the shell can create contexts,
evaluate artifacts, provide imports and retrieve public module exports. Native
callback authority captures the caller in Rust, independent of mutable JS globals.
Promises are bridged through granted resolve/reject callbacks. Server references
carry a string name and are rebuilt with the destination SDK's own symbol.

### Rendering and events

Each renderer has its own local node IDs. Rust maps `(realm, local ID)` into the
shared document's handle space. A foreign ID never resolves in that map. Root IDs
for cross-realm mounts are minted by Rust and only permit insertion of owned
children, not attributes, detachment or replacement of the mount itself. A plugin
has no alias for the shell's document root. Node objects cannot be serialized.

A remote component produces an owned `display:contents` mount element in the
calling renderer. Rust connects a fresh render root in the component's realm to
that point. It processes creation batches before dependent mounts. Scalar prop
snapshots are tracked by a source effect and applied to a stable destination props
proxy, rather than remounting the component. Callable prop values become grants;
the real chat composer `insertText` and server-send path exercise these calls.

Native events are split into consecutive segments by node owner and delivered
in bubbling order to the corresponding renderer. Cancellation and propagation
state survive context boundaries; foreign targets use an opaque zero target.
Layout reports are filtered and IDs translated for the owning context. Blitz
continues to own native focus, selection, input and caret geometry.

Mutation batches retain native source attribution. The existing wire topology
validator still stages each whole batch before applying it. Invalid plugin node
references or invalid native batches retire that plugin's render admission, while
shell batches retain the existing document-failure behavior. Retired realms are
excluded from subsequent input and layout delivery.

### Slots, public exports and services

Each realm uses its own `ExtensionProvider`, `ClientContext`, `RouterContext` and
`ShortcutContext`. The host supplies copied service objects with call grants.
The isolated registry loads only each plugin's own factory in its context;
imports of other plugins receive copied public values and granted public functions.
A fill is mounted inside the declaring plugin's mount point, using its own runtime.
The shell service wrapper restricts client requests to the calling plugin's server
namespace. Shortcut registrations return proxied cleanup functions.

Objects exposed publicly are copied snapshots, not shared mutable module state.
Publishing a function intentionally grants access to its public behavior. A
plugin's private registry, globals and closed-over state are never transferred.

## Work required before enabling production isolation

1. Complete cross-realm component ownership: `wrap` must pass a render capability
   for `Original` that preserves the originating provider/owner; `replace` must
   retain deterministic ordering and per-layer fallback. The slice's remote mount
   boundary currently logs failures and renders empty content. Existing wrap and
   replacement tests continue to exercise the legacy implementation only.
2. Add source subscriptions for reactive accessor/function reads (including router
   location, draft reads and public function exports), extension catalog changes,
   and generation changes. Scalar props already have snapshot updates; reading a
   remote accessor currently returns a synchronous snapshot without subscribing
   the caller's Solid computation.
3. Define typed component descriptors rather than classifying public uppercase
   exports as components; preserve context for hook-style exports such as
   `useComposer`, and explicitly handle children/render callbacks.
4. Retire individual mount grants, endpoints, provider roots, detached nodes and
   context generations on unload/reload. Currently contexts and grant tables live
   until window teardown; repeated reload of the same plugin is unsupported. A
   rejected realm's existing rendered content is frozen until its parent removes
   it. Native context creation failures also need prompt individual retirement.
5. Install per-context async/promise error attribution and propagate factory,
   event and detached async errors to the correct host/module/layer boundary.
   Complete failing-fill and wrap/replace fallbacks in isolated mode.
6. Route clipboard/timer completion IDs per realm, bound protocol/grant growth and
   recursive calls, harden malformed tagged payload validation, and audit shared
   runtime deadline/heap exhaustion behavior. The current runtime-wide heap cap
   and microtask budget remain shared. This slice is not a general hostile-code
   resource sandbox.
7. Exercise isolated hot reload, lazy imports, sibling-view shortcuts, navigation,
   drafts and every existing extension regression before switching the normal
   entry from `ModuleRegistry` to `IsolatedModuleRegistry`. Build a smaller plugin
   bootstrap instead of copying the complete shell bundle into every context.
8. Isolate styles: the shared document's global stylesheets and plugin-created
   style elements can affect foreign subtrees. Define host-enforced stylesheet
   ownership/scoping before admitting untrusted plugin styles in production.

## Validation and cost

`client_realm_slice_blocks_escapes_and_keeps_chat_sending` loads the production
shell and real chat artifact plus a separate hostile filler. It attempts both
`Function("return this")()` and indirect eval at load and inside the fill, patches
Array/Promise/JSON functions, mutates an imported module object, attempts foreign
DOM lookup, guesses a call grant and tries host-only registry administration.
The shell retains its original globals and intrinsic functions. The filler inserts
text through the composer grant and native Enter sends it through chat's API and
renders the persisted message (the fixture uses an offline failing ACP adapter).
A forged root mutation then retires the hostile renderer; chat sends another
message. `client_realm_shared_control_reproduces_escape` runs the same artifact
with the shared loader and asserts `ESCAPED`, proving the fixture detects the
original vulnerability.

Run the cost measurement explicitly:

```sh
cargo test --locked -p tokamak-app --test plugins client_realm_cost -- --ignored --nocapture --test-threads=1
```

The benchmark alternates five measured shared/isolated window startups after one
warmup for each mode, against the same local plugin server. It measures native
window-document creation through chat thread selection and filler readiness,
excluding compilation and server startup. Heap values are QuickJS's
`memory_used_size`, not process RSS; they exclude Rust/Blitz/GPU allocation and
are sampled without forcing GC. Context bootstrap logs separately measure the
incremental runtime heap and elapsed time for fresh context + bootstrap execution.
Both modes use the same bootstrap and artifacts, isolating realm/protocol cost;
the shared control represents the old loader, rather than a separate binary of main.

An uncontended local run after the correctness gates produced:

| Measurement                  |   Shared loader | Separate contexts |
| ---------------------------- | --------------: | ----------------: |
| Median startup, five samples |      107.679 ms |        119.851 ms |
| Median ready QuickJS heap    | 2,122,146 bytes |   3,559,651 bytes |

The two plugin contexts plus proxy/render bookkeeping added 1,437,505 bytes at
readiness. Fresh context + bootstrap alone added 636,111 bytes for the hostile
plugin and 640,204 bytes for chat, taking 6.35–7.05 ms per context. These are local
debug-build measurements, not a production performance guarantee. Shared startup
samples were `[108464, 108838, 107614, 107679, 104963]` microseconds; isolated
samples were `[120240, 119735, 119851, 116958, 122558]` microseconds.

Completed gates: `bun run check`; the complete `app/tests/run.sh` suites (15
native, 19 plugin and 2 socket tests passed, with the benchmark normally ignored);
and the render library, `native_solid`, `launch_failure`, `promise_hooks` and
`find_interrupt` suites. The ignored cost benchmark was run explicitly and passed.
Existing extension tests pass through the legacy loader; this does not establish
isolated wrap/replace, drafts or shortcut parity.
