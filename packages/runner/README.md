# Tokamak Runner

The Runner combines a workspace server and the local runtime in one program. It
owns the server's action process and up to 128 QuickJS local plugin processes. The plugin processes
run caller actions and their contracts, including calls forwarded by a window
connected to a shared workspace.
Each local process starts on its first call and stays up until its build is
retired, it exits, or the Runner shuts down. The registry distinguishes a
plugin's ID and its two local bundle hashes. Windows that use the same build
share a process. The window reports its workspace address without credentials
so the Runner can tell which installation superseded a build.

The agent, turn hook, and thread deletion contracts in the Tokamak plugins
use plain-data calls. Reloading an agent or Code does not restart ai or
clear its session grants. Turn controls look up the active turn in ai's
regular process. Hook calls have no agent channel; their caller can cancel a
pending discovery or call by operation ID. That drops the nested work and
uses the same host invocation cancel as when the whole turn is lost.

When a window sees a replacement for a plugin's own QuickJS build, it sends
retirement to the old connection and gives its admitted root calls up to five
seconds to settle. The SDK exposes this notification as `ctx.retiring`. AI
uses it to interrupt running turns and reap their programs before releasing
their threads. If a turn call cannot settle by the deadline, the window closes
the old connection and records the reload as the reason the turn ended.
Code and agent reloads do not retire AI's root calls.

An idle build that the same workspace supersedes can stop as soon as the
replacement is acquired. Otherwise the Runner sweeps known superseded builds
on a two-second timer once the last window and call release them, with at least
two seconds of idle time. At capacity it evicts the least recently used
unleased process; the limit is reported only when all slots are leased.
Closing a window cancels its calls; an unchanged process stays up across
reconnects.

A window is a trusted Runner client. It checks `local.contract.call` against
the signed-in workspace's catalog: who owns the contract, whether the
provider declared access to the owner, and whether the contract declares
`dataMethods: true`. The Runner verifies the installed artifact ID and hashes
and refuses a build that declares or provides a local contract without the
plain-data marker. Rebuild older provider artifacts whose manifests lack the
marker. A call to the same plugin uses its already-running build and the same plain-data dispatch. A plugin
process can act only as its own plugin. Workspace operations in the provider still go through the
calling window, with that window's signed-in member and device.

An agent turn opens one linked plain-data call from ai to its agent. It pins
the two invocations that already know the window's identity. Reports and
questions return to that exact ai invocation; steer, stop and force stop
reach the agent invocation that owns the CLI, even while its build drains.
One Runner admits up to 64 concurrent turns, with at most 32 on any one
agent host. Of the 128 invocation slots on a host, this leaves at least 64
on the manager and 96 on an agent for short calls. Peer messages don't use
invocation slots. Reports and questions wait for space in the bounded pipes
and operation queues; each turn can have one report and one question in
flight. If a turn can't start because a limit is reached, the thread asks
the user to wait for a turn to finish, naming the agent when only its host
is full. The SDK coalesces pending reports and accounts for at most 768 KiB
per turn (24 MiB for 32 turns); exceeding that bound fails only the noisy turn.

On Force stop, the agent SDK seals and drains its reports. The manager
allows up to 750 ms for the drain, then asks the host's Rust control thread
to kill only that invocation's program groups and closes the channel. This
works even while provider JavaScript is stuck. If the JavaScript watchdog
later resets the stuck realm, other invocations in that same host also fail;
other plugin hosts keep running.
On macOS, the Runner serializes creation of the control socket pair with
child launches, including plugin process guardians and device name lookup, until
both descriptors have close-on-exec set. Linux sets it atomically. Only the
intended host receives its end, and it restores close-on-exec before it can
start any programs.

When ai's host exits, the Runner cancels the linked agent starts, open questions, and
any pending hook calls. A window that stays connected waits for the Server's
liveness sweep (45 seconds without a heartbeat, checked every 5 seconds).
A relaunched window can release an orphan earlier via its startup recovery.
When an agent host exits, only starts on that host fail,
with the host's name.

Install the Runner on desktops, real machines and sandboxes. For Docker or a
cloud host, use the [Server build](../../README.md#build-for-a-machine-or-the-cloud).
Keep the Runner's full plugin host separate from the Server's actions-only host.
On macOS and Linux, the Runner checks for `local` in the output of
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
workspace at `/ws` and for the plugin process socket at `/local-worker`. Ctrl+C stops
the Runner. See [Plugin host](../host/README.md) for runtime details and Windows support.

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
`tokamak:tkm-243-checks`. The measurement script is maintained with the plugin
suites in [tokamak-plugins](https://github.com/pixelscortex/tokamak-plugins).

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

## Connect a headless Runner to a shared server

On macOS or Linux, start the Runner with a server origin and a private file
containing a device key:

```sh
tokamak-runner --server https://workspace.example.com \
  --key-file /path/to/device.key --plugins /path/to/plugins --data /path/to/runner-data
```

Use the server's HTTPS address (plain HTTP is accepted only for loopback
development). The Runner opens the connection itself and does not listen on a
port. Put the key on one line in a regular file with mode `600`. The command
line contains only its path. Do not use the server's recovery key as the Runner
key.

Use the workspace's existing sign-in method to issue a dedicated device key:
submit the same fields as the sign-in form to `POST /auth/sign-in`, with the
provider's `method`, its `fields`, and a `deviceName` for the Runner. For an
owner, `POST /auth/owner` with the owner recovery credential and
`{"deviceName":"Headless Runner"}` issues the same kind of device key. Save
only the response's `key` in the private file; the response returns it once.
Do not print the response or put either credential in shell arguments. Use
one device key per Runner. Signing that device out revokes the key and stops
the Runner from reconnecting.

For a plugin-managed machine, put its key in the same private key file. No
sign-in or machine id is needed on the Runner. The owning plugin can revoke
that key, and uninstalling the plugin revokes it too; the Runner then stops
reconnecting. The plugin's machine management API is available under
`@tokamak/sdk/unstable` and may change.

Install the full Runner build of every plugin this machine serves in
`--plugins`, including `manifest.json`, `local-entry.js`, and `local.js`.
Reinstall the build after every plugin update. The cloud package omits Runner
bundles and automatic delivery is separate work. A missing or mismatched build
returns `runnerArtifactMismatch`. In a caller action, `ctx.env` comes from the
Runner's own environment.

For a connected Runner, the server drives the action's hooks and named points
using the same call budget as its nested calls. It runs each stage with the
hook plugin's artifact and grants. A Runner that cannot execute the stages
returns `hookRunnerUnavailable`; the error names the hook plugin. A plugin-owned
machine never receives another plugin's hook code. The server rejects that
placement with the same typed error before invoking the action.

For `on: "caller"`, the server uses the connected Runner for the exact device
in the caller's call note. A desktop without a connection for its device can still use the
window route. A browser without a Runner for its device gets `noMachine`.
The newest connection using a device key takes over; the old Runner exits
if it receives the takeover notice. Connection loss fails active calls with
`machineLost`; the Runner retries with backoff and does not replay calls.

Plain HTTP is available only for loopback IP addresses and `localhost`,
which the Runner resolves directly to loopback addresses. Other origins
require TLS. Set `TOKAMAK_MACHINE_HEARTBEAT_INTERVAL_MS` (default 5000) and
`TOKAMAK_MACHINE_HEARTBEAT_LIMIT_MS` (default 15000) on the Runner and server
to tune heartbeat timing. Use positive values with the interval below the limit.
