import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { prepareChatSandbox } from "./chat-sandbox";

process.chdir(resolve(import.meta.dirname, ".."));
await mkdir("app/.dev", { recursive: true });
const directory = await mkdtemp(resolve("app/.dev/browser-"));
const env = {
  ...process.env,
  TOKAMAK_PLUGIN_DIR: `${directory}/plugins`,
  TOKAMAK_FIXTURE_SOURCE: `${directory}/fixture`,
  TOKAMAK_SERVER_DIR: `${directory}/local`,
  TOKAMAK_ALLOWED_ORIGINS: `http://127.0.0.1:${process.env.TOKAMAK_E2E_PORT ?? "1420"}`,
  VITE_TOKAMAK_HTTP: "http://127.0.0.1:43123",
  VITE_TOKAMAK_TOKEN: randomBytes(32).toString("hex"),
};
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}
try {
  await mkdir(env.TOKAMAK_SERVER_DIR, { mode: 0o700 });
  await writeFile(`${env.TOKAMAK_SERVER_DIR}/server.token`, env.VITE_TOKAMAK_TOKEN, { mode: 0o600 });
  await cp("app/tests/fixtures/integration", env.TOKAMAK_FIXTURE_SOURCE, {
    recursive: true,
    filter: (source) => !source.split("/").includes("dist"),
  });
  run("cargo", ["build", "--locked", "-p", "server", "--bin", "tokamak", "--jobs", "2"]);
  run("proto", ["run", "bun", "--", "app/scripts/integration-fixture.ts"]);
  // Adds ACP and a scripted agent; the server then never sees this machine's real agent CLIs.
  const sandbox = await prepareChatSandbox(directory);
  Object.assign(env, { CHAT_SANDBOX_HOME: sandbox.env.HOME, CHAT_SANDBOX_PATH: sandbox.env.PATH });
  run("proto", ["run", "bun", "--", "run", "--cwd", "app", "build"]);
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
