import { cp, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { build, bunPath, workspace } from "../../../../e2e/fake-agent/harness.mjs";

const quoted = (text) => "'" + text.replaceAll("'", "'\\''") + "'";

/** Production agent bundles and deterministic stand-ins for the two CLIs. */
export async function prepareReplayAgents(scratch) {
  const plugins = join(scratch, "plugins");
  const home = join(scratch, "home");
  const bin = join(scratch, "bin");
  await Promise.all([mkdir(home), mkdir(bin), mkdir(plugins)]);
  for (const id of ["chat", "ai", "claude", "codex"]) {
    const source = join(workspace, "plugins", id);
    const cached = process.env.TOKAMAK_AGENT_FIXTURES && join(process.env.TOKAMAK_AGENT_FIXTURES, id);
    if (cached && (await Bun.file(join(cached, "manifest.json")).exists())) {
      await cp(cached, join(plugins, id), { recursive: true });
    } else {
      build(source);
      await cp(join(source, "dist"), join(plugins, id), { recursive: true });
    }
  }
  const bun = quoted(bunPath());
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh
exec ${bun} ${quoted(join(workspace, "plugins/claude/tests/replay.mjs"))} "$@"
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "codex"),
    `#!/bin/sh
case "$1" in
  --version) echo 'codex-cli 0.170.0' ;;
  app-server)
    if [ "$PWD/home" = "$HOME" ]; then tape=info; else
      tape="\${PWD##*/}"
      printf '%s' "$$" > codex.pid
    fi
    exec ${bun} ${quoted(join(workspace, "e2e/fake-agent/program.mjs"))} --replay "codex/$tape"
    ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  return {
    plugins,
    env: { HOME: home, PATH: [bin, "/usr/bin", "/bin"].join(delimiter), TOKAMAK_PLUGIN_RUNTIME: "quickjs" },
  };
}
