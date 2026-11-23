# Plugin host

The plugin host runs local functions and server actions on QuickJS by default
on macOS and Linux. `TOKAMAK_PLUGIN_RUNTIME=bun` is a temporary fallback that
will be removed. An empty value is an error on macOS and Linux. Windows ignores
the variable and uses Bun. See the SDK's
[plugin runtime guide](../sdk/README.md#plugin-runtimes) for plugin compatibility.
The Runner looks for `tokamak-plugin-host` next to its executable. For development, run
`cargo build --locked -p tokamak-plugin-host` and set `TOKAMAK_PLUGIN_HOST`
if the executable lives elsewhere.

Bun bundles the shared SDK dispatcher at build time; the host does not need
Bun to run. The Runner starts the host in its own process group
with a guardian. The host kills that group on stdin EOF or shutdown.

The host accepts up to 128 concurrent local calls and uses back-pressure
when its input queue fills. A local call has no wall-clock limit. Cancelling
a call aborts its JavaScript signal, rejects its pending host operations and
discards late output from that call. Other calls and module state continue.
If JavaScript runs without yielding for five seconds, QuickJS interrupts it.
Only then does the host reset the runtime: started calls fail and module state
is lost, while queued invocations run in the new runtime.

Each host runs one QuickJS runtime and realm for its owning plugin. It loads
verified provider bundles returned by the window's `local.contracts`
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

## Action process

The cloud Server ships the same executable name built with
`--no-default-features`. That variant accepts only `--actions` and
`--inspect-actions`. It shares the action engine and protocol with the full
host. The local dispatcher, filesystem modules, program launcher and JavaScript
`process` global aren't compiled into it.

When QuickJS is selected, the server looks for `tokamak-plugin-host`
at startup, next to its executable unless `TOKAMAK_PLUGIN_HOST` overrides that
path. It starts one action process in `--actions` mode on the first action call.
The action process has no file or program capability.

Queries, mutations, and the top-level code of modules they import run in the
server, including modules shared with actions. The transaction companion lets
the server inspect function metadata without loading action definitions, helpers,
or imports used only by actions. At each startup, the plugin host evaluates each
plugin's action bundle once in a separate inspection process, up to eight at a
time, and reports results in plugin order. Reload checks the replacement bundle.
Inspection runs with no permissions, no network access, and no host operations.
A bundle that needs the network to load fails this check. Evaluation errors
follow the same startup and reload policy as transaction bundle errors. Rebuild
older default artifacts that have actions and standalone features before
enabling QuickJS.

The action process uses the engine's web implementation and the manifest's
`net:` grants, including for `runtime: "worker"` plugins whose fetches Bun
did not check. Worker plugins have no `process` or `process.env`; use
`await ctx.env(name)` with the manifest's `env:<name>` grant.
Each action call starts on its own OS thread with its own QuickJS runtime,
heap, watchdog, and fresh module state. The dispatcher and native web I/O share
a Tokio executor. Dropping the runtime ends all JavaScript jobs and releases the
call's timers, requests, and memory after success, failure, cancellation,
deadline, or reload. This includes `runtime: "worker"` plugins, which keep
module state between calls on Bun.

All plugins' actions share one process. The runtime boundary isolates calls,
including concurrent calls of the same plugin. The server trusts the action
process to label host operations with the right call, and each call's runtime
can only send operations for its own call ID. A memory-safety bug in QuickJS
could let one call reach other plugins' network permissions and in-flight
calls in the action process. Action JavaScript does not expose the server
process itself to such a bug. The server still authorizes database, identity,
and other host operations.

The heap limit defaults to 64 MiB per call; set `TOKAMAK_ACTION_HEAP_MIB` to a
positive integer to change it. The process-wide worst case is 128 running calls
times the per-call limit (8 GiB by default), reached only if every call fills
its heap. On Linux the allocator may keep some freed memory per thread.

The server admits up to 64 calls per plugin and 128 in total. Admitted calls
start without a queue. Anonymous sign-in bypasses the per-plugin call limit
and counts toward the total. It has four slots across all plugins; a fifth
request is refused as busy. A `runtime: "worker"` plugin that could run up to
128 calls in its own Bun worker can run up to 64 with QuickJS. Pending host
operations are limited to 128 in total, with separate limits of 64 per plugin
for signed-in and anonymous calls. Nested calls count
against the plugin being called. Log output has a per-plugin budget and reports
dropped lines when it resumes.

Each call compiles its action bundle again, as the server's engine did for
default actions. In a release build on an Apple M4 Pro, 100 sequential trivial
calls took 0.569 s (5.69 ms per call). The same 100 calls with a 1.30 MB bundle
of 9,976 distinct functions took 12.343 s (123.43 ms per call). These timings
include the action process pipe round trip.

Most calls have a one-hour deadline. Anonymous sign-in uses the existing engine
timeout (one second by default, with a five-second minimum in debug builds).
This budget includes starting the runtime and compiling and evaluating the
bundle. Five seconds without yielding interrupts only the offending call, and
heap exhaustion only fails the call that ran out of memory.

The server pings every 10 seconds. After 30 seconds without a reply it sends
a fresh probe and allows another interval for a pending pong before killing
the process group. A panic aborts the action process; exit or loss of the
heartbeat fails outstanding calls. The next call restarts the process after
back-off from 250 ms up to 30 seconds. At least 60 seconds of uptime resets the
back-off, even if no call completed. Server shutdown stops the action process,
and the guardian also contains it if the server dies.

See [Dependencies](DEPENDENCIES.md) for versions and licenses.
