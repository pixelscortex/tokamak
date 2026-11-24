// Stand-in executable on the harness PATH. The production provider still
// launches "claude" exactly as it does when the real executable is installed.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const status = await readFile(join(process.env.HOME, "claude-status"), "utf8").catch(() => "");
if (args[0] === "--version") {
  console.log(status === "old" ? "Claude Code v2.1.329 (test build)" : "2.1.330 (Claude Code)");
} else if (args[0] === "auth") {
  assert.equal(args[1], "status");
  const loggedIn = status !== "signed-out";
  const expirations = {
    "expired-iso": "2000-01-01T00:00:00Z",
    "expired-ms": 946684800000,
    "expired-seconds": 946684800,
  };
  const loginExpiresAt = expirations[status] ?? null;
  console.log(
    JSON.stringify({
      loggedIn,
      authMethod: loggedIn ? "claude.ai" : "none",
      apiProvider: "firstParty",
      loginExpiresAt,
    }),
  );
  process.exitCode = loggedIn ? 0 : 1;
} else {
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  assert.ok(args.includes("-p"));
  assert.equal(flag("--input-format"), "stream-json");
  assert.equal(flag("--output-format"), "stream-json");
  // Model discovery does not select a thread folder. The Runner can start
  // from any directory, including one whose name starts with "claude-".
  let replay = args.includes("--strict-mcp-config") ? "claude-info" : basename(process.cwd());
  if (replay.startsWith("claude-resistant-")) replay = "claude-resistant";
  if (replay.startsWith("claude-hello-")) replay = "claude-hello";
  if (replay === "claude-remember-snapshots") replay = "claude-remember";
  if (replay === "claude-hello" && flag("--resume")) {
    assert.equal(flag("--resume"), "ed0f9193-a023-4ab1-a74c-a8bba2877dc3");
    replay = "claude-resume";
  }
  if (replay === "claude-remember" && flag("--resume")) {
    assert.equal(flag("--resume"), "be26420d-2d98-4819-8c04-82b6f107764d");
    replay = "claude-remember-resume";
  }
  if (replay === "claude-hello") await writeFile("claude.pid", String(process.pid));
  if (replay === "claude-lost" && !flag("--resume")) replay = "claude-history";
  if (replay === "claude-info") assert.equal(JSON.parse(flag("--settings")).fastMode, true);
  if (replay !== "claude-info") {
    assert.ok(args.includes("--include-partial-messages"));
    assert.ok(args.includes("--replay-user-messages"));
    assert.equal(flag("--thinking-display"), "summarized");
    assert.equal(flag("--permission-prompt-tool"), "stdio");
    const ask = [
      "claude-permit",
      "claude-refuse",
      "claude-cancel",
      "claude-cancel-continues",
      "claude-remember",
      "claude-remember-resume",
      "claude-plan",
      "claude-scope",
      "claude-stop-asking",
      "claude-withdraw-question",
    ].includes(replay);
    assert.equal(flag("--permission-mode"), ask ? "manual" : "bypassPermissions");
  }
  const runner = fileURLToPath(new URL("../../../e2e/fake-agent/program.mjs", import.meta.url));
  const child = Bun.spawn([process.execPath, runner, "--replay", replay], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await child.exited);
}
