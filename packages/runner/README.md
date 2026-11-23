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
memory, with no discovery file, environment variable or command-line argument.
Closing the pipe requests graceful shutdown. On Unix a guardian also watches
its own pipe from the desktop and kills the process group if the desktop dies.
Plugin and program groups have their own guardians. On Windows the desktop
starts the Runner in a job that kills its process tree when the app's job handle
closes. When the Runner exits unexpectedly, the app starts a replacement with a
new port and secret.
