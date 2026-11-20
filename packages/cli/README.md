# Tokamak CLI

Run from a checkout with the pinned Bun:

```sh
proto run bun -- run --silent tokamak --help
proto run bun -- run --silent tokamak plugin build /path/to/my-plugin --json
proto run bun -- run --silent tokamak plugin add /path/to/my-plugin
proto run bun -- run --silent tokamak plugin list --json
proto run bun -- run --silent tokamak plugin logs my-plugin --errors --json
proto run bun -- run --silent tokamak plugin remove my-plugin
proto run bun -- run --silent tokamak plugin reload my-plugin --json
proto run bun -- run --silent tokamak doctor --json
proto run bun -- run --silent tokamak report --out diagnostics.md
```

`build` runs the artifact build once, defaults to the current folder, and
doesn't need a server. `add` reads the plugin's static identity from `plugin.ts`
(or the build's `package.json` convention), and doesn't build it. `add` and
`remove` edit the index. Run `tokamak plugin reload [id]` to build and apply indexed plugins, or omit the id to also apply removals. Both commands serialize index updates with an exclusive owner
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
identity to the discovery file. Loopback requests connect directly, ignoring
proxy settings. Only `tokamak server start` starts a server.

From a checkout, build the plugins and the server executable:

```sh
proto run bun -- run tokamak plugin build plugins/chat
proto run bun -- run tokamak plugin build plugins/acp
cargo build --locked -p server --bin tokamak-server
proto run bun -- run tokamak server start
```

Build each plugin you install in the plugins folder. The CLI and desktop app
share the data folder, discovery files, and startup lock. Both reuse a running
server when its server build id and plugins folder match. If they differ, the
CLI asks you to stop the running server before starting a different one.
`TOKAMAK_PLUGIN_DIR` selects the plugins folder for both launchers.

Use `tokamak invite <name>`, `tokamak members`, and `tokamak revoke <id>` as
the owner. A local invite grants access to the local workspace as a member.
Running agents through the desktop app stays with the owner. A shared server
invite is a join link. Keep invites private. With `--json`, an invite is
printed only in the stdout JSON.

`server status` reports `running: true, responsive: false` when discovery
points to a live process that does not answer its health request.

`plugin logs <id>` streams this installation's log in order. The plugin is
known if it is indexed, loaded by the running server, or has a local log file.
`--errors` shows only entries with level `error`. Malformed records are skipped
and counted. Use the CLI on the machine that runs the server to read its files.

Logs live at `<OS temp>/tokamak/logs/<key>/<id>.log`. The key is the first 16
hex digits of SHA-256 of the canonical app data folder path (the storage folder
for a server without an app data folder). Set `TOKAMAK_PLUGIN_LOG_DIR` to
override the entire log folder for both the server and CLI; tests should use a
folder they own.

Each JSON Lines record has `time` (Unix epoch milliseconds), `source`
(`server` or `window`), `level` (`log`, `info`, `warn`, `error`, or `debug`),
`kind` (`console`, `exception`, `validation`, `cancellation`, or `dropped`),
and `text`. Function errors include the function name and available stack.
A successful reload replaces the log for each changed build, starting with
its load output. Unchanged plugins and refused reloads keep their logs. A log
stops accepting records after 10 MiB or when its writer falls behind. One marker
records the drop, and the next successful replacement starts a fresh file.

Window reports are limited to 8,192 UTF-8 bytes and eight reports per plugin
per 10 seconds, with one marker per period for excess reports. Reports from a
previous plugin revision are discarded.

With `--json`, stdout contains one JSON value and human text goes to stderr.
Without it, normal output goes to stdout and errors go to stderr. Exit status is zero on success and
nonzero on failure. The CLI never prompts. Success has `ok: true` and:

| Command         | Additional result fields                                           |
| --------------- | ------------------------------------------------------------------ |
| `plugin build`  | `id`, `outputFolder`                                               |
| `plugin add`    | `id`, `folder`, `reloadRequired: true`, `precedence: "index"`      |
| `plugin remove` | `id`, `reloadRequired: true`                                       |
| `plugin list`   | `plugins`: an array of `{ id, version, fromIndex }`                |
| `plugin logs`   | `entries`: matching records, and `skipped`: malformed record count |
| `invite`        | `invite`: token or join link                                       |
| `members`       | `members`: active `{ id, name, role }` entries                     |
| `revoke`        | `revoked`: member id                                               |
| `server start`  | `address`, `pid`, `buildId`, `reused`                              |
| `server status` | `running`; when true: `responsive`, `address`, `pid`, `buildId`    |
| `server stop`   | `stopped`: whether a running server was stopped                    |
| `doctor`        | `rows`: an array of readiness checks                               |
| `report`        | `path`: the absolute path of the written report                    |
| `--help`        | `help`                                                             |

Failures return `{ ok: false, error: { message, next } }`. Artifact build and
configuration failures include `error.diagnostics`, an array with a full
`message` and, when available, `file` (absolute), `line`, `column`, and `code`.
Import failures can point to a bundled dependency. Lockfile disagreements point
to the lockfile.

Reload returns `plugins`, `removed` (ids removed from the running index), and
`skipped` (a map of unrequested plugin ids to reasons). Each plugin result has
`id`, `buildId` (SHA-256 of the built manifest, or null when no build was made),
and `status`: `loaded`, `unchanged`, `build-failed`, `load-failed`, or
`unknown`. Failed or uncertain entries carry `error.message` and may include
`error.diagnostics`. The CLI locks each source folder through build and
submission. Any unrelated installed manifest errors found after a removal are
listed under `warnings` without failing the command. If a reload reply is lost, it asks the server which build is
running; when that cannot be confirmed, run `tokamak plugin list`.

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
