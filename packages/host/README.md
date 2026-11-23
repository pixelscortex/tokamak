# Plugin host

The plugin host runs a plugin's local functions on QuickJS on macOS and Linux.
Set `TOKAMAK_PLUGIN_RUNTIME=quickjs` to opt in. Bun is the default, and the
setting does not select a different runtime for server actions. The client
looks for `tokamak-plugin-host` next to its executable. For a development build,
run `cargo build --locked -p tokamak-plugin-host` and point
`TOKAMAK_PLUGIN_HOST` at the resulting executable if it lives elsewhere.

The host owns the JSON lines transport, admission, time and memory limits.
Bun bundles the shared SDK dispatcher into the host at build time; it is
not needed to run the executable. The desktop launcher uses the same process
group and guardian as Bun.

A root bundle runs in its own QuickJS runtime. A cancelled or expired call
interrupts the runtime and fails all other calls already started in it.
The process stays up, and calls that were still queued start in a fresh
runtime. QuickJS enforces a 32 MiB heap limit. An allocation error that
can be reported by the SDK fails its own call; another pending call can
still complete. If a heap failure prevents JS from even reporting a
result, the call deadline still applies. If the process exits, the local
part fails its pending calls and starts a new process on the next call.

This initial path cannot run programs or load another plugin's local
contract providers. The SDK passes live objects and synchronous functions
to providers; those values cannot be imported into a separate QuickJS
runtime. Supporting this without changing plugin behavior needs a bridge
that preserves callbacks, synchronous methods and object identity across
runtimes. The host refuses a cross-plugin lookup explicitly until that
bridge exists. Bun continues to support these contracts. To verify the
new host from the window, run the client with the setting and call a local
function that does not need programs or providers.

LLRT supplies the native modules, including HTTP/1.1 fetch with rustls and
WebPKI roots. It does not export `cp`, `realpath` or `unlink` from
`node:fs/promises` at the pinned revision. The host adds them using the
system filesystem APIs. The copy wrapper handles regular files and
directories with `recursive`, `force`, `errorOnExist` and
`preserveTimestamps`; it does not implement Node's symlink or filter
options. The host also supplies timers and `TextEncoder.encode()`.

See [Dependencies](DEPENDENCIES.md) for versions and licenses.
