# Tokamak CLI

Run from a checkout with the pinned Bun:

```sh
proto run bun -- run --silent tokamak --help
proto run bun -- run --silent tokamak plugin build /path/to/my-plugin --json
proto run bun -- run --silent tokamak plugin add /path/to/my-plugin
proto run bun -- run --silent tokamak plugin list --json
proto run bun -- run --silent tokamak plugin logs my-plugin --errors --json
proto run bun -- run --silent tokamak plugin remove my-plugin
```

`build` runs the artifact build once, defaults to the current folder, and
doesn't need a server. `add` reads the plugin's static identity from `plugin.ts`
(or the build's `package.json` convention), and doesn't build it. `add` and
`remove` only edit the index; the local server picks up membership changes on
its next start. Both commands serialize index updates with an exclusive owner
file: a dead owner can be removed, and a live owner is never displaced. An
update that cannot get the lock within 15 seconds fails. Indexed builds must use
`<folder>/dist`; both build and add reject a Vite configuration that changes
that location.

The app data folder contains `plugin-index.json`, a JSON object mapping each
plugin id to its absolute source folder, for example:

```json
{ "my-plugin": "/path/to/my-plugin" }
```

At startup the local server loads each indexed folder's `dist` artifact in
addition to its `--plugins` folder. A built indexed plugin wins when both
sources contain the same id; startup logs which copy it replaces. A missing
index is empty. Unreadable or malformed indexes are logged and ignored; bad
entries are logged and skipped, leaving any copy from `--plugins` available.

`list` asks the running local server for its catalog. The CLI discovers it through
`server.json` and authenticates with `server.token` in the app data folder. Set
`TOKAMAK_SERVER_DIR` to use a different app data folder, including for tests.
For a server at a specific address, set `TOKAMAK_SERVER` and `TOKAMAK_TOKEN`,
or supply `--server <address>` with `TOKAMAK_TOKEN`. The flag takes precedence.
Local discovery checks the process and compares the authenticated health
identity to the discovery file. The CLI never starts a server.

`plugin logs <id>` reads a local file, including when the server is stopped if
the plugin is indexed. For a plugin outside the index, the CLI checks the
running server's catalog. `--errors` shows only entries whose level is `error`.

The server writes one JSON object per line to `<OS temp>/tokamak/logs/<id>.log`.
Each entry has `time` (Unix epoch milliseconds), `source` (`server` or
`window`), `level` (`log`, `info`, `warn`, `error`, or `debug`), and `text`.
Thrown server errors include the function name in `text`. A reload clears that
plugin's file. Set `TOKAMAK_PLUGIN_LOG_DIR` to override the folder for both the
server and the CLI; tests should set it to a folder they own. Window reports
accept at most 8,192 UTF-8 bytes of text; including JSON escaping and metadata,
a stored window entry is under 49,300 bytes. The server accepts eight window
reports per plugin per 10-second period; excess requests return HTTP 429.
This limit does not apply to server console output or function errors.

With `--json`, stdout contains one JSON value and human text goes to stderr.
Without it, normal output goes to stdout and errors go to stderr. Exit status is zero on success and
nonzero on failure. The CLI never prompts. Success has `ok: true` and:

| Command         | Additional result fields                                       |
| --------------- | -------------------------------------------------------------- |
| `plugin build`  | `id`, `outputFolder`                                           |
| `plugin add`    | `id`, `folder`, `restartRequired: true`, `precedence: "index"` |
| `plugin remove` | `id`, `restartRequired: true`                                  |
| `plugin list`   | `plugins`: an array of `{ id, version, fromIndex }`            |
| `--help`        | `help`                                                         |

Failures return `{ ok: false, error: { message, next } }`. Artifact build and
configuration failures include `error.diagnostics`, an array with a full
`message` and, when available, `file` (absolute), `line`, `column`, and `code`.

To add a command, create a file under `src/commands/` that satisfies `Command`,
then register it in `src/commands.ts`. The entry point handles flags, help,
output and exit codes. The CLI test walks the registry to check that contract.

A command that needs its own flags declares them in `flags`, for example
`flags: { errors: { summary: "Show only errors." }, out: { value: "path", summary: "Where to write the file." } }`.
A flag with `value` takes one value; a flag without it is a switch; `short` adds a
one-letter form. The command receives them as `options.flags`. Help lists them, and a
flag the command did not declare is an error. `--json` and `--help` are shared.
Set `usesServer: true` to accept the shared `--server <address>` option and show
it in that command's help.

Run the CLI tests with the real server:

```sh
cargo build -p server --bin tokamak-server
proto run bun -- test packages/cli/tests
```
