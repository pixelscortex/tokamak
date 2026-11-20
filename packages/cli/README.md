# Tokamak CLI

Run from a checkout with the pinned Bun:

```sh
proto run bun -- run --silent tokamak --help
proto run bun -- run --silent tokamak plugin build /path/to/my-plugin --json
proto run bun -- run --silent tokamak plugin add /path/to/my-plugin
proto run bun -- run --silent tokamak plugin list --json
proto run bun -- run --silent tokamak plugin remove my-plugin
proto run bun -- run --silent tokamak doctor --json
proto run bun -- run --silent tokamak report --out diagnostics.md
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

With `--json`, stdout contains one JSON value and human text goes to stderr.
Without it, normal output goes to stdout and errors go to stderr. Exit status is zero on success and
nonzero on failure. The CLI never prompts. Success has `ok: true` and:

| Command         | Additional result fields                                       |
| --------------- | -------------------------------------------------------------- |
| `plugin build`  | `id`, `outputFolder`                                           |
| `plugin add`    | `id`, `folder`, `restartRequired: true`, `precedence: "index"` |
| `plugin remove` | `id`, `restartRequired: true`                                  |
| `plugin list`   | `plugins`: an array of `{ id, version, fromIndex }`            |
| `doctor`        | `rows`: an array of readiness checks                           |
| `report`        | `path`: the absolute path of the written report                |
| `--help`        | `help`                                                         |

Failures return `{ ok: false, error: { message, next } }`. Artifact build and
configuration failures include `error.diagnostics`, an array with a full
`message` and, when available, `file` (absolute), `line`, `column`, and `code`.

`doctor` checks the CLI, the running Bun against the checkout's pin, git, the plugin
build tools and the local server, in that order. Each row contains `name`,
`state` (`"ready"` or `"not ready"`), and `detail`. A row that is not ready
also contains one `fix` (a command or a URL). When any row is not ready,
the command exits 1 and returns `{ ok: false, error: { message, next }, rows }`
with all five rows.

`report` writes a Markdown file with the doctor table, local server details
and loaded plugins, the plugin index, the OS and architecture, and up to
200 lines from at most the last 1 MiB of `server.log`. It omits unrecognized
log lines and index paths outside the home folder, shortens home paths to `~`,
and redacts known credentials and credential-looking values. Review the file
before sharing it. It works with the local
server stopped. The file is named `tokamak-report-<date-time>.md` in the current
folder unless you supply `--out <path>`. The command prints the path, never
overwrites a file and uploads nothing. A default name collision gets a unique
suffix. Both commands check the local server in the app data folder; they
reject `--server` and ignore `TOKAMAK_SERVER`. Discovered local connections never
use an HTTP proxy.

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
