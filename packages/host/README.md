# Plugin host

The plugin host runs a plugin's local functions on QuickJS on macOS and Linux.
Set `TOKAMAK_PLUGIN_RUNTIME=quickjs` to opt in. Bun stays the default; the
setting does not select a runtime for server actions. The client looks for
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
owning plugin use the same built-in allow list.

Local functions can start up to 256 live programs per host with `proc` and
`withPrograms`. Programs get their own process groups. On macOS and Linux a
guardian in each group watches a private pipe held by the host. Closing it
sends TERM to the group, followed by KILL after 250 ms. The pipe closes even
when the host is killed with SIGKILL. A scope can send KILL immediately to
its own groups. The launcher holds a separate liveness pipe for its guardian
in the host group, so abrupt launcher exit also stops the host and its
programs.

The host reads program output on demand and delivers buffered lines in
batches. An unread stream backs up into the program's pipe. Lines exceeding
1 MiB cause that stream to fail. Its pipe stays open and unread until the
program stops.

The host caps queued stdin at 64 MiB per program. A write beyond the limit
throws `Program input queue exceeds 64 MiB` and leaves the program running.
Bun buffers without this limit; the host cap prevents plugins that write
faster than the program reads from growing the queue without bound.

The QuickJS heap defaults to 256 MiB. Override it with the positive integer
`TOKAMAK_PLUGIN_HOST_HEAP_MIB`. The launcher passes that setting to the host.
A reportable allocation failure is returned to its invocation. If memory
runs so low that QuickJS cannot run the rejection handler, the call can
still be cancelled. Process exit fails outstanding calls, and the next call
starts a new process.

Local functions get `process.platform` (`darwin` or `linux`), an empty
`process.versions` (no `node` entry), and `process.env`, an ordinary object
with a snapshot of the short launch environment. On Bun, setting
`process.env.X` affects programs started later. On the plugin host, it only
changes the snapshot. Pass `env` to `ctx.proc` to set a program's environment.

The filesystem module supports Node-style error codes and string, file URL
and byte-array paths. `cp` copies symlinks by default and supports
`dereference`, `recursive`, `force`, `errorOnExist` and
`preserveTimestamps`. It does not support `filter` or `verbatimSymlinks`.
The host supplies up to 4,096 live timers and immediates with `ref()` and
`unref()` handles (both are no-ops). Immediates have their own scheduler step
after pending promise jobs and arrived input. Its console supports common Node formatting, traces and
object inspection; log messages are cut off at 8,192 characters.

LLRT supplies Buffer, web streams, the abort and URL APIs, text encoders and
decoders, and HTTP/1.1 fetch with rustls and WebPKI roots. This host does not
supply `structuredClone`: LLRT implements it privately in its full VM rather
than in a standalone module.

See [Dependencies](DEPENDENCIES.md) for versions and licenses.
