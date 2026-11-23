import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentTurns } from "../../../e2e/fake-agent/agent-turn.mjs";
import { build, workspace } from "../../../e2e/fake-agent/harness.mjs";

export async function claudeSnapshots(h, hello) {
  const source = join(workspace, "plugins/code");
  build(source);
  await cp(join(source, "dist"), join(h.plugins, "code"), { recursive: true });
  const client = await h.connect(await h.serve("snapshots"), { local: true });
  const folder = await h.folder("claude-hello-snapshots");
  const git = (...args) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: folder,
      encoding: "utf8",
      env: { HOME: h.home, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  git("init", "--quiet");
  await writeFile(join(folder, ".gitignore"), "go\nclaude.pid\n");
  await writeFile(join(folder, "work.txt"), "before\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Initial");

  const turns = agentTurns({
    h,
    client,
    agent: { id: "claude", name: "Claude" },
    model: "sonnet",
    effort: "low",
  });
  const completed = await turns.run(folder, hello, {
    async during(turn) {
      await turn.firstText();
      await writeFile(join(folder, "work.txt"), "after\n");
      await h.gate(folder, "go");
    },
  });
  assert.equal(completed.text, "Hello Tokamak.");
  const ref = `refs/tokamak/threads/${completed.threadId.split(":")[1]}/turns/${completed.row._id.split(":")[1]}`;
  assert.equal(git("show", `${ref}/before:work.txt`), "before");
  assert.equal(git("show", `${ref}/after:work.txt`), "after");
}
