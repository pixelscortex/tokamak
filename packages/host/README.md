# Plugin host

The plugin host runs a plugin's local functions on QuickJS on macOS and Linux.
Set `TOKAMAK_PLUGIN_RUNTIME=quickjs` to opt in. Bun stays the default. The client looks for
`tokamak-plugin-host` next to its executable. For development, run
`cargo build --locked -p tokamak-plugin-host` and set `TOKAMAK_PLUGIN_HOST`
if the executable lives elsewhere.

Bun bundles the shared SDK dispatcher at build time; the host does not need
Bun to run. The desktop launcher starts the host in its own process group
with a guardian. The host kills that group on stdin EOF or shutdown.

The host accepts up to 128 concurrent local calls and uses back-pressure
when its input queue fills. A local call has no wall-clock limit. Cancelling
a call aborts its JavaScript signal, rejects its pending host operations and
discards late output from that call. Other calls and module state continue.
If JavaScript runs without yielding for five seconds, QuickJS interrupts it.
Only then does the host reset the runtime: started calls fail and module state
is lost, while queued invocations run in the new runtime.

Each host runs one QuickJS runtime and realm for its owning plugin. It loads
verified provider bundles returned by the desktop's `local.contracts`
operation in that same realm. Providers can receive live objects and call
functions directly. Imports from other paths are refused; providers and the
owning plugin use the same built-in allow list. Programs (`proc` and
`withPrograms`) are unavailable on this runtime.

The QuickJS heap defaults to 256 MiB. Override it with the positive integer
`TOKAMAK_PLUGIN_HOST_HEAP_MIB`. The launcher passes that setting to the host.
A reportable allocation failure is returned to its invocation. If memory
runs so low that QuickJS cannot run the rejection handler, the call can
still be cancelled. Process exit fails outstanding calls, and the next call
starts a new process.

The filesystem module supports Node-style error codes and string, file URL
and byte-array paths. `cp` copies symlinks by default and supports
`dereference`, `recursive`, `force`, `errorOnExist` and
`preserveTimestamps`. It does not support `filter` or `verbatimSymlinks`.
The host supplies up to 4,096 live timers with `ref()` and `unref()` handles
(both are no-ops). Its console supports common Node formatting, traces and
object inspection; log messages are cut off at 8,192 characters.

LLRT supplies Buffer, web streams, the abort and URL APIs, text encoders and
decoders, and HTTP/1.1 fetch with rustls and WebPKI roots. This host does not
supply `structuredClone`: LLRT implements it privately in its full VM rather
than in a standalone module.

## Action process

With the same setting, the server starts one action process on the first action
call. It runs the same executable in `--actions` mode. The process has a
separate QuickJS runtime and watchdog per plugin, and no file or program
capability. The server still owns every database and identity operation and
provides the manifest's network grants. The action process uses the engine's
web implementation, including DNS and redirect checks. Default bundles get a
fresh realm and web resource lease per call. Bundles built for Bun retain one
realm and web resource table per plugin; reload retires both.

Build artifacts include a separate transaction bundle so the server does not
evaluate the action module, even to inspect metadata. Rebuild older default
artifacts or standalone features before enabling QuickJS. The server uses the
configured engine heap limit (64 MiB by default) for each plugin runtime.
Actions can await for up to one hour. Five seconds without yielding interrupts
the affected runtime. Process exits fail outstanding actions and subsequent
calls restart it after delays of 250 ms, 500 ms, and so on, capped at 30 seconds.
One completed call after 60 seconds of uptime resets the delay. Server shutdown
stops the process and the launcher also contains it if the server dies.

See [Dependencies](DEPENDENCIES.md) for versions and licenses.
