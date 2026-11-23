# Tokamak Runner

The Runner combines a workspace server and the local runtime in one program. It
owns the server's action process and starts a local plugin process when a client
opens a worker socket. The window still resolves contracts and forwards calls
to the workspace it is connected to, so a shared workspace can use the Runner
on the person's own machine.

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
