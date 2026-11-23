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
cargo build --locked -p server -p tokamak-plugin-host --bin tokamak-server --bin tokamak-plugin-host --jobs 2
target/debug/tokamak-server --plugins path/to/plugins --local-dir path/to/private-server
```

Legacy `--local-dir` mode requires a private `server.token`. Never pass a token
in arguments. The app ships Chat, AI, Code,
Claude, Codex and Password sign-in as its starter set.
`--plugins` and legacy `--bundle` are mutually exclusive.

```sh
target/debug/tokamak-server plugin create plugins/acme.notes
TOKAMAK_SERVER_DIR=path/to/private-server target/debug/tokamak-server plugin list
TOKAMAK_SERVER_DIR=path/to/private-server target/debug/tokamak-server plugin reload acme.notes
```

Create writes a descriptor, a sample query and a skill file in a new folder.
Run `proto run bun -- install` in the checkout to link the SDK before building it.

To target a running desktop Runner, point `TOKAMAK_SERVER_DIR` at its private
data directory. The CLI finds the address in `runner.json` and reads
`runner.control`. The Runner rotates the credential on every start and removes
both files on clean exit. This credential can only list and reload plugins; it
cannot read workspace data or UI assets, open a socket, or stop the Runner.
The CLI falls back to legacy server discovery when there is no `runner.json`.

The CLI validates loopback discovery, uses bearer authentication, disables
proxies and redirects, and does not replay requests. The server exposes:

- `GET /plugins`: live manifest/function metadata and generation revision.
- `GET /plugins/{id}/{revision}/assets/{name}`: declared UI files from the verified snapshot.
  Never arbitrary files, backend source, capability tokens or generated backend API.
- `POST /plugins/{id}/reload`: validate and reload the configured installation
  in capability-protected local mode.

## Loading and reload contract

Static validation resolves one version per ID, host API compatibility, required
and present optional dependencies, conflicts and cycles **before evaluating any
module**. Rust's maintained `semver` implements range semantics. A `depends`
target must exist; an absent `optional` target is fine, but a present incompatible
version is an error.

The private server directory stores `plugin-install-order.json` as a list of
plugin IDs in installation order. Plugins with no history are ordered after
their dependencies, choosing the lowest plugin ID when more than one can come
next. Later scans preserve recorded order, remove absent plugins, and append
new IDs. The catalog exposes each plugin's zero-based position as `installOrder`.
The window uses it to choose the first installed replacement for an element.

The catalog reserves `tokamak.host` for core metadata and `auth` for caller
identity. A plugin manifest cannot use either ID.

Tokamak has **no product limits**: installed plugins, dependencies, contributions,
capabilities, labels and artifact totals have no count or size quotas. Large
catalogs are paged and large UI assets are streamed, rather than refused.

Artifact SHA-256 hashes detect incomplete builds. Paths and asset symlinks cannot
escape the artifact directory. Declared files are hashed/copied with a 64 KiB
buffer into private temporary files, owned by the immutable generation and deleted
when its last reference retires. Snapshots consume disk rather than retaining all
artifact bytes or open file descriptors in RAM. HTTP UI downloads stream 64 KiB
chunks; native/WebSocket UI downloads use UTF-8-safe pages of at most 8 KiB.
Neither transfer has a total-size ceiling. These are corruption/mixed-build
checks, not signatures. Manifests are parsed through a buffered reader, with no
128 KiB manifest limit. Catalog JSON is serialized once per generation and served
in 8 KiB pages, with no aggregate catalog ceiling. Metadata and evaluated modules
still require memory proportional to their contents; there is no fixed RSS promise.

**Backend engineering exception:** QuickJS must compile the whole backend module;
its API cannot stream compilation across independent chunks. Source maps likewise
build a complete in-memory index. Backend code and its source map each have a
512 MiB input safety bound, with a diagnostic explaining how to split the backend
into plugins. Other declared files (including backend API declarations and all UI
assets) have no per-file bound. The engine's configurable per-invocation heap and
time budgets still apply (`--heap-bytes`, `--load-ms`, `--call-ms`); large backends
may require raising them. Streaming UI transport does not make JavaScript
compilation itself incremental in the client engine. Client windows have no
fixed heap quota; the former 64 MiB window ceiling does not limit UI bundles.

Reload is serialized with admitted calls: old calls finish their commit/rollback
first. The full candidate installation resolves and is inspected before one
generation swap. Failed reload leaves old code, subscriptions and data usable.
Successful reload dirties all subscriptions; removed or changed-kind queries
produce explicit subscription errors. The named ID must be present in the old or
new installation; dependent callers reload together. This is not stateful HMR.
On Unix, unchanged files reuse verified snapshots only when canonical path,
device/inode, size, mtime and ctime still match. Changed files are rehashed, so an
unchanged manifest cannot conceal an in-place write or atomic replacement.
Platforms without reliable change/identity metadata conservatively rehash all
files. This fast path trusts local filesystem metadata, not hostile build tools
with kernel-level ability to forge ctime. Unchanged parsed backend bundles, inspection results
and already validated permission grants are reused. Dependency ordering uses an
iterative graph walk, avoiding native stack depth proportional to plugin count.
Discovery's `bundleHash` identifies startup; `/plugins` reports the live revision.
Legacy `Server::descriptor()` is a startup snapshot; use `Server::plugins()` for
ordered live plugin metadata.

## Calls, data ownership and capabilities

Generated API references for explicitly declared plugins carry names such as
`acme.notes/notes:list`; references never import server handlers into the client.
Inside a handler, `ctx.use(otherApi).notes.list({})` invokes the host. A caller
must declare the target in `depends` or `optional`. Re-export callable
definitions from `src/server/api.ts` to publish those references to dependent
plugins. For an extension point where the owner discovers implementations,
declare a typed `contract` and use `provide` in the implementing plugin.

Use `internalQuery`, `internalMutation`, or `internalAction` for a function
that only the owning plugin's server code can call. Import its reference from
`src/server/_generated/internal`. Internal functions cannot be re-exported or
called by other plugins. The server also refuses direct calls and subscriptions
from clients, including the owning plugin's own window.

| Calling context | Nested calls                                       |
| --------------- | -------------------------------------------------- |
| Query           | `ctx.runQuery`                                     |
| Mutation        | `ctx.runQuery`, `ctx.runMutation`                  |
| Action          | `ctx.runQuery`, `ctx.runMutation`, `ctx.runAction` |

`ctx.runAction` can invoke another action. Like the other nested calls, it
enforces dependency, interface, and export rules. Actions have no `ctx.db`;
each query or mutation an action starts uses its own transaction. In single-bundle
mode, actions retain their existing nested query and mutation support. Nested
calls from queries or mutations and `ctx.runAction` require packaged plugins.

Every callee gets its own namespace and the host supplies the caller's identity.
Queries and mutations called by an outer mutation share its transaction. A
mutation returning `fail(kind, data)` rolls back its writes and returns the
typed failure. A nested mutation rolls back only its own writes, including
those of its callees. If the caller handles the failure, its writes can still
commit. If it returns the failure, its writes roll back too. An action returning
`fail` does not undo mutations it already called; actions are not transactional.
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
Grant records use deterministic native record keys, so version lookup does not
scan the ledger or execute SurrealQL predicates. The internal keyed CREATE is
not an upsert and is not exposed through the JavaScript database API.

**Network access belongs to actions only.** A `net:<host>` declaration is an
exact-host grant for `fetch` inside `action` functions; there is no `net:*`
wildcard (see `packages/engine/WEB_APIS.md`). Actions run on a separate worker
lane and reach data only through `ctx.runQuery` / `ctx.runMutation`. Queries and
mutations cannot call actions or `fetch`, so they gain no external effects that
could repeat during transaction retries. Reload cancels old-generation actions.
An action result is one wire response under the same inclusive 1 MiB limit: an
oversized result fails only that call. No Node/Bun runtime, plugin grant prompt,
marketplace, signing, Wasm or untrusted sandbox ships here.

## Caller identity

The core query `auth:caller` takes `{}` and returns the current connection's
`{ user, device }`. Clients can call it once or subscribe to changes. The SDK
exports it as `authCaller` and uses it for the window's live `auth.me()`. It
works even when no plugins are installed.

On a shared server, `POST /members/{id}/role` requires the owner's token. Send
`{"role":"admin"}` or `{"role":"member"}` to change an active member's role.
The route cannot assign the owner role or change the existing owner's role.

On a shared server, the window's **Settings → Devices** page uses
`GET /devices/live` (Server-Sent Events over a fetch with an Authorization
header). Each update lists the devices the
caller can manage, including their names, members, online status and last seen
times. A device is online while it has an open socket. Last seen updates are
saved about once a minute and at shutdown.
`POST /devices/{id}/revoke` signs out that device. Send the caller's key in
`Authorization: Bearer <key>`. Owners can sign out anyone's issued devices,
admins can sign out their own and ordinary members' devices, and members can
sign out their own devices. A forbidden sign-out returns HTTP 403.
The server closes the device's sockets with code 4001 and rejects the key on
reconnect. The bootstrap owner key stays available for recovery.

Shared startup keeps device sign-in available if a plugin fails to initialize.
The server logs every skipped plugin and its error, and `GET /plugins` includes
a `skipped` map from plugin IDs to error messages.

The core issues a device key only after successful sign-in resolves to an
active member. The server stores its SHA-256 digest and logs only the member
and device IDs. The window sends keys in request headers, including the
browser WebSocket handshake.

On a shared server, **Settings → Members** follows `GET /members/live` for
the active list and each member's role. Owners and admins can add accounts
with `POST /members` and `{method, fields}`, reset a password with
`POST /members/{id}/reset-password` and `{password}`, and remove a member
with `POST /members/{id}/revoke`. Use bearer authentication on each route.
The owner can manage admins and members; admins can manage ordinary members.
Nobody can remove the owner or reset their password through Members. Reset
revokes all the member's issued keys and closes their sockets with code 4001
before it changes the password. If revocation fails, the password is unchanged.
If the provider refuses the password after revocation, the devices stay signed out.
They sign in with the temporary password and must choose their own before getting
a new device key. Removing a member disconnects every device, refuses all their
keys and clears their `keep: "me"` state.
Legacy owner-issued invite keys still work.

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

The connected UI session also exposes `plugins` and revision-checked,
UTF-8-chunked `pluginasset` requests. Successful generation swaps emit
`pluginchanged` with the new catalog before refreshing existing subscriptions.
See [the client host contract](../runtime/PLUGINS.md) for the wire shape and lazy
module lifecycle. The authenticated HTTP asset/control endpoints remain usable.

### Action environment grants

An installed plugin action can call `await ctx.env("NAME")` only with the exact
`env:NAME` permission in its manifest. An undeclared read is refused; a declared
but unset value returns `null`. Queries and mutations have no environment API.
The host resolves its process environment first, then `.env.local` beside the
installation directory (for the workspace `plugins/`, this is the workspace
root). Local values are read without changing the process environment or adding
secrets to catalog metadata. Malformed dotenv errors never include file contents.
Changing permissions on an installed plugin requires a version bump as usual.

### Contract routing and plugin-only functions

A server contract's private methods are registered as server functions with
the provider's database, grants and the authenticated caller. Only the plugin
which defined the contract may list or invoke those registrations. A reload
rebuilds the active registrations; an optional provider stays installed when
its contract owner is absent. The client catalog only carries registrations
needed by the local part. The catalog verifies the provider's declaration hash
against the owner's. The declaring plugin can mark a local contract with
`dataMethods: true` or a nonempty list such as `dataMethods: ["info"]`.
For those methods, the window authorizes the provider and method using the
catalog, and the QuickJS Runner routes the JSON arguments and result between
the two plugin processes. The provider handles the call with the caller's
signed-in member and device. Live methods, including turn start and turn
hooks, run in the caller's realm and can pass objects with callbacks. Bun
continues to use the caller's worker for all local contract methods.

The QuickJS Runner reuses one verified snapshot of each live provider per
caller realm. When that provider's local bytes change, windows switch to a
new realm and the old one is retired once no connected window uses it. Its
modules and background work end with the process. A reload with identical
local bytes and live providers keeps the existing process.

A function wrapped in `pluginOnly(...)` has an explicit cross-plugin export
in `pluginFunctions` if re-exported by the public server module. It is
accessible to the owning plugin and authorized server dependents. It never
appears in client function metadata and cannot be called or subscribed to by
a window. A contract method gets its own private address even if the
implementation also has another address. The existing interface provider
registry remains separate.

The core owns `auth.method`. A sign-in plugin declares `depends: ["auth"]`
and provides the key from `plugin:auth/contracts`, with `signIn` defined as
an internal action. It supplies a `form` of text, email, or password fields
and can name the login field with `loginField` (otherwise the first text or
email field is used). A provider can also offer an internal `setupOwner`
action with its own `setupOwnerForm`. Its result is an account ID and an
optional display name. Only the core binds accounts to members and issues
device keys. Plugins depend on `auth`, never on one of its providers. For a
separate installation, set `TOKAMAK_PLUGIN_DIR` or Vite's `pluginCatalog`
option so the build can check provider manifests there.

A provider can opt into Members through `createAccountForm` and the
`createAccount({memberId, fields})` internal action. Return
`{accountId, displayName}` and mark the credential temporary in the provider.
Register `onMember(auth.memberRemoved, handler)` to delete the account by
`memberId`. If the core cannot save a new member, it runs the provisioning
plugin's cleanup before returning the error.
An optional `resetPassword({accountId, password})` internal action marks the
bound account's replacement credential temporary. Both require
`changePassword({accountId, fields, newPassword})`, which verifies a temporary
credential again and atomically replaces it. Both password actions return the
same `{accountId}` on success. Return `{accountId, passwordChangeRequired: true}`
from `signIn` after verifying a temporary credential. The core sends
`403 PasswordChangeRequired` without a device key; resubmit the original
sign-in request with `newPassword` to complete sign-in. Changes are made by
the installed provider through the contract, with roles and bindings
controlled by the core.

On a shared server, public `GET /auth/methods` lists the available forms,
without private action addresses. Public `POST /auth/sign-in` takes
`{method, fields, deviceName}` and returns `{device, key}`. Failures after
provider execution trigger bounded backoff by login and remote address; a
throttled attempt returns `429` and `Retry-After`. The server uses the socket
peer address by default. If your proxies append their direct peers to
`X-Forwarded-For`, set `TOKAMAK_TRUSTED_PROXY` to their exact IP addresses,
separated by commas. The server checks forwarded hops from right to left and
uses the first untrusted address. Sign-in allows one attempt at a time per
IPv4 address or IPv6 /64, which also determines the address backoff bucket.

Bearer-only `POST /auth/owner` takes the bootstrap key and `{deviceName, setup?}`
and returns a revocable device key. With `setup: true`, it also returns any
available `setupMethods`.
The same device can submit `{method, fields}` to `POST /auth/owner/setup`
during its setup window. When no provider offers setup, the owner keeps using
the bootstrap key to obtain device keys. The old
`POST /members/{id}/devices` route is retired and returns 404.

The core resolves each request against the active catalog. Before sign-in,
`ctx.auth` throws, including inside nested calls. Only private
queries and mutations of that provider are available to its anonymous action.
Actions have native Argon2id `ctx.crypto.hashPassword`, `verifyPassword`, and
`verifyAndRehashPassword`. The latter returns `{ valid, replacementHash? }`;
after successful verification, save a replacement only if the old hash
is still current.
