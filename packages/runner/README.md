# Tokamak Runner

The Runner combines a workspace server and the local runtime in one program. It
owns the server's action process and up to 128 QuickJS local plugin processes.
Each local process starts on its first call and stays up until its build is
retired, it exits, or the Runner shuts down. The registry distinguishes a
plugin's ID and its two local bundle hashes. It also separates realms that
need different builds of live providers. Windows that use the same build and
live profile share a process. The window reports its workspace address
without credentials so the Runner can tell which installation superseded a
build. A live provider change sends new calls to a fresh realm. The original
realm retains its admitted calls and verified provider files. For ai this
now applies only to live turn hooks. Until hooks also move across processes
(TKM-248), turn controls use the active turn's workspace and turn ID to find
its original realm. Quit controls also include turns in draining realms.
An agent build change does not change ai's realm.

An idle build that the same workspace supersedes can stop as soon as the
replacement is acquired. Otherwise the Runner sweeps known superseded builds
on a two-second timer once the last window and call release them, with at least
two seconds of idle time. At capacity it evicts the least recently used
unleased process; the limit is reported only when all slots are leased.
Closing a window cancels its calls; an unchanged process stays up across
reconnects. With the Bun fallback, each worker socket still owns its process.

A window is a trusted Runner client. It checks `local.contract.call` against
the signed-in workspace's catalog: who owns the contract, whether the
provider declared access to the owner, and whether the method appears in
`dataMethods`. The Runner verifies the installed artifact ID and hashes
before starting a process or making a provider snapshot available to a live
realm. It permits operations to claim only the process's own plugin ID or an
ID for which that process received a verified live snapshot. The provider
checks its registration and re-checks that the requested method is declared
for plain data. Workspace operations in the provider still go through the
calling window, with that window's signed-in member and device.

An agent turn opens one linked plain-data call from ai to its agent. It pins
the two invocations that already know the window's identity. Reports and
questions return to that exact ai invocation; steer, stop and force stop
reach the agent invocation that owns the CLI, even while its build drains.
Each host admits at most 32 linked starts in either role, within its normal
128 calls. Messages use a bounded queue without admitting new invocations.
When ai's host exits, the Runner drops and cancels the linked starts. When an
agent host exits, only starts on that host fail, with the host's name.

Install the Runner on desktops, real machines and sandboxes. For Docker or a
cloud host, use the [Server build](../../README.md#build-for-a-machine-or-the-cloud).
Keep the Runner's full plugin host separate from the Server's actions-only host.
On macOS and Linux, a QuickJS Runner checks for `local` in the output of
`tokamak-plugin-host --capabilities` before it starts listening.

To run a workspace from a terminal:

```sh
cargo build --locked -p tokamak-runner -p tokamak-plugin-host
mkdir -p /path/to/workspace
(umask 077; openssl rand -hex 32 > /path/to/workspace/runner.token)
target/debug/tokamak-runner --plugins /path/to/plugins \
  --data /path/to/workspace/store --token-file /path/to/workspace/runner.token
```

The Runner prints its WebSocket address. It defaults to `127.0.0.1:3000`;
use `--listen 127.0.0.1:0` for a free port. Non-loopback addresses are refused.
For HTTP, send the token as a Bearer credential. Browser WebSocket clients
offer `tokamak` and `tokamak.bearer.<token>` as subprotocols, both for the
workspace at `/ws` and for the worker socket at `/local-worker`. Ctrl+C stops
the Runner. See [Plugin host](../host/README.md) for runtime selection, including
the Bun fallback and Windows.

The desktop starts the Runner on a free loopback port with a new 256-bit secret
on a private stdin pipe. It reads readiness from stdout. The secret lives in
memory and never appears in discovery, the environment or arguments. The
Runner holds an exclusive store lock and publishes `runner.json` and a separate
`runner.control` credential in its private data directory. The credential is
for listing and reloading plugins only. Both files are private, are replaced
on every start, and are removed on a clean exit.
Closing the pipe requests graceful shutdown. On Unix a guardian also watches
its own pipe from the desktop and kills the process group if the desktop dies.
Plugin and program groups have their own guardians. On Windows the desktop
starts the Runner in a job that kills its process tree when the app's job handle
closes. When the Runner exits unexpectedly, the app starts a replacement with a
new port and secret. An occupied store is a terminal startup error. Started by
the desktop, the Runner takes over a store held by a Tokamak server after
verifying the server's identity and waiting for its shutdown to release the
ownership lock. Started by hand, it never stops another process: it reports the
store as in use and names the holder.

### Linux memory measurement

The original measurement ran on Linux arm64 in the local Docker image
`tokamak:tkm-243-checks`. Reproduce it from a committed checkout by overlaying
the source onto `/src` in that image and building in release mode:

```sh
git archive HEAD | docker run -i tokamak:tkm-243-checks bash -c '
  set -e
  tar xf - -C /src
  cd /src
  CARGO_BUILD_JOBS=4 cargo build --locked --release -p tokamak-runner -p tokamak-plugin-host
  proto run bun -- packages/runner/tests/measure-linux-memory.mjs target/release/tokamak-runner
'
```

The script uses an empty workspace and 100 synthetic plugins with identical
trivial local code. A host is warmed once: its first invocation completes
(including the window's auth reply), then it sits idle. The script waits 200 ms
before sampling one host and 400 ms before sampling 100. It reads
`/proc/<pid>/smaps_rollup` for each child, sums proportional set size (PSS),
and reports host and guardian memory separately. PSS apportions shared pages
among the processes that map them; RSS charges each process for every page it
maps. The marginal figure subtracts the one-host PSS from the 100-host PSS and
divides by 99.

A separate run starts the real `ai`, `claude` and `codex` bundles using replay
executables on PATH. It opens the agent row so the two provider processes
each describe their provider and answer `info`. The script waits
400 ms after the row returns and reports each host's PSS separately. Neither
measurement includes the Runner or the agent executables.
