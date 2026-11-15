# Backend readability verification

Baseline (workspace Clippy, all features, libraries and binaries):

- `too_many_lines`: 13 warnings.
- `excessive_nesting`: 29 warnings.
- Oxlint: 48 warnings, no errors.
- jscpd: 6 clones, including 4 Rust clones (32 duplicated Rust lines).

The explicitly excluded `app/` and `packages/render/` manifests still need
`[lints] workspace = true` from their owning agent. The other five workspace
members inherit the advisory Rust lints. Moon advisory tasks allow failure.

Final checks (all exit 0):

| Check | Result |
| --- | --- |
| `cargo check --workspace` | Passed |
| `cargo test -p server` | 145 passed, 0 failed, 1 ignored |
| `cargo test -p engine` | 21 passed, 0 failed, 2 ignored |
| `cargo clippy --locked --workspace --lib --bins --all-features` | Passed; warnings only |
| Oxlint | 48 warnings, 0 errors (48 before) |
| jscpd | 4 clones / 30 duplicated lines (6 / 48 before) |

Clippy `too_many_lines`: **13 → 5**. `excessive_nesting`: **29 → 20**.
No warnings from either readability lint remain in the refactored files.
Counts use the same workspace/all-features/library/binary scope before and after.
All three configured Moon tasks also ran successfully at baseline.

The ignored server test is the manual OpenRouter smoke run. Engine marks two
subprocess entry points ignored in its main test harness; the watchdog/interrupt
tests execute those entry points in subprocesses.
No tests were added or removed; plugin unit tests moved to `plugins/tests.rs`.
Rustfmt ran directly on touched Rust files with `skip_children=true`, never across
the workspace. Test bodies were preserved apart from the required import/module
scope changes.

Deliberate omissions:

- The two excluded workspace manifests need lint inheritance from their owner.
- The remaining Rust clones are imports in excluded render files and a capability
  file check shared in concept by the independent runtime client and server CLI.
  Sharing the latter would require coupling their dependency graphs or introducing
  a common crate for a short check; their error text also intentionally differs.
- Existing bridge, worker-pool, action registry, schema, query, server CLI and
  client transport code outside the requested splits retain their advisory
  warnings. The unchanged web JavaScript adapter and vendored streams stay intact.

Changes preserve the public API paths. Required/optional dependency iteration,
semver matching, manifest parsing/discovery, startup error cleanup, storage
transaction construction and invocation retry loops now have shared helpers.
All refactored Rust files are below 400 lines.

Commits by step:

1. `a66020e chore: add advisory readability and duplication checks`
2. `69d8dc7 refactor(server): split service coordination by responsibility`
3. `af93d70 refactor(server): separate plugin manifests assets and loading`
4. `58ebf51 refactor(server): extract database host operation handlers`
5. `25d24c5 refactor(server): isolate transaction indexes and record operations`
6. `893e880 refactor(engine): separate fetch timers decoding and network policy`
7. `696b868 refactor: share backend validation cleanup and invocation helpers`
8. Final spacing, comment and verification commit (this document).

Full file trees; parenthesized numbers are physical line counts.

```text
packages/server/src/
  actions.rs (110)
  backend.rs (69)
  bin/
    export-protocol.rs (24)
  data/
    README.md (135)
    changes.rs (212)
    mod.rs (185)
    query.rs (253)
    space.rs (81)
    storage.rs (141)
    transaction/
      indexes.rs (172)
      records.rs (231)
    transaction.rs (264)
    types.rs (303)
  environment.rs (21)
  host/
    database_operations.rs (134)
    database_queries.rs (183)
  host.rs (244)
  lib.rs (21)
  main.rs (269)
  plugins/
    artifact.rs (80)
    assets.rs (200)
    catalog.rs (125)
    dependencies.rs (79)
    grants.rs (130)
    loading.rs (131)
    manifest.rs (164)
    mod.rs (70)
    tests.rs (167)
  protocol.rs (102)
  schema.rs (146)
  service/
    action_coordination.rs (88)
    command_loop.rs (94)
    delivery.rs (86)
    invocations.rs (42)
    mod.rs (183)
    plugin_control.rs (170)
    requests.rs (84)
    server.rs (90)
    session.rs (201)
    startup.rs (201)
    subscriptions.rs (146)
  websocket.rs (332)
packages/engine/src/web/
  decoding.rs (49)
  fetch.rs (234)
  mod.rs (202)
  network.rs (138)
  surface.js (395)
  timers.rs (42)
  urls.rs (54)
  vendor/
    README.md (10)
    streams.LICENSE (22)
    streams.js (8)
```
