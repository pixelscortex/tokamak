import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { build as buildPlugin, buildAgentPlugins } from "./fake-agent/harness.mjs";

process.chdir(resolve(import.meta.dirname, ".."));
await mkdir("app/.dev", { recursive: true });
const directory = await mkdtemp(resolve("app/.dev/browser-"));
const env = {
  ...process.env,
  TOKAMAK_PLUGIN_DIR: `${directory}/plugins`,
  TOKAMAK_FIXTURE_SOURCE: `${directory}/fixture`,
  TOKAMAK_OTHER_DRAFT_SOURCE: `${directory}/other-draft`,
  TOKAMAK_E2E_WEB_ROOT: `${directory}/web`,
  TOKAMAK_E2E_EXTRA_PLUGINS: `${directory}/extra-plugins`,
  // The preview serves this build throughout the suite, even if app/dist is rebuilt.
  TOKAMAK_E2E_PREVIEW_DIR: `${directory}/preview`,
  TOKAMAK_SERVER_DIR: `${directory}/local`,
  TOKAMAK_ALLOWED_ORIGINS: `http://127.0.0.1:${process.env.TOKAMAK_E2E_PORT ?? "1420"}`,
  VITE_TOKAMAK_HTTP: "http://127.0.0.1:43123",
  VITE_TOKAMAK_TOKEN: randomBytes(32).toString("hex"),
  TOKAMAK_E2E_HOSTED_TOKEN: randomBytes(32).toString("hex"),
};
function run(command: string, args: string[], processEnv: NodeJS.ProcessEnv = env) {
  const result = spawnSync(command, args, { env: processEnv, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}
try {
  await mkdir(env.TOKAMAK_SERVER_DIR, { mode: 0o700 });
  await writeFile(`${env.TOKAMAK_SERVER_DIR}/server.token`, env.VITE_TOKAMAK_TOKEN, { mode: 0o600 });
  for (const [fixture, destination] of [
    ["integration", env.TOKAMAK_FIXTURE_SOURCE],
    ["other-draft", env.TOKAMAK_OTHER_DRAFT_SOURCE],
  ]) {
    await cp(`app/tests/fixtures/${fixture}`, destination, {
      recursive: true,
      filter: (source) => !source.split("/").includes("dist"),
    });
  }
  run("cargo", [
    "build",
    "--locked",
    "-p",
    "server",
    "-p",
    "tokamak-runner",
    "-p",
    "tokamak-plugin-host",
    "--jobs",
    "2",
  ]);
  run("proto", ["run", "bun", "--", "app/scripts/integration-fixture.ts", "--with-basic-auth"]);
  // A desktop page (browser/desktop.ts) runs Chat, AI and the fake agents through the Runner.
  await buildAgentPlugins(directory, (id) => `${env.TOKAMAK_PLUGIN_DIR}/${id}/dist`);
  buildPlugin(resolve("plugins/code"));
  await cp("plugins/code/dist", `${env.TOKAMAK_PLUGIN_DIR}/code/dist`, { recursive: true });
  // The Profiles screens (screens.spec.ts) run on a copy of the plugins with these
  // (claude and codex for the company logos)
  // added, so the other screens keep the rail they are drawn with. Only this test
  // copy of agent-proxy may reach the fake companies on 127.0.0.1.
  for (const id of ["agent-proxy", "ai-profiles", "claude", "codex"]) {
    buildPlugin(resolve("plugins", id));
    await cp(`plugins/${id}/dist`, `${env.TOKAMAK_E2E_EXTRA_PLUGINS}/${id}/dist`, { recursive: true });
  }
  const proxyManifest = `${env.TOKAMAK_E2E_EXTRA_PLUGINS}/agent-proxy/dist/manifest.json`;
  const manifest = JSON.parse(await readFile(proxyManifest, "utf8"));
  manifest.plugin.permissions.push("net:127.0.0.1");
  await writeFile(proxyManifest, JSON.stringify(manifest));
  Object.assign(env, { TOKAMAK_E2E_BUN: process.execPath });
  const build = ["run", "bun", "--", "run", "--cwd", "app", "build"];
  run("proto", [...build, "--outDir", env.TOKAMAK_E2E_WEB_ROOT], {
    ...env,
    VITE_TOKAMAK_HTTP: undefined,
    VITE_TOKAMAK_TOKEN: undefined,
  });
  run("proto", build);
  run("proto", [
    "run",
    "bun",
    "--",
    "x",
    "playwright",
    "test",
    "--config",
    "e2e/playwright.config.ts",
    ...process.argv.slice(2),
  ]);
} finally {
  await rm(directory, { recursive: true, force: true });
}
