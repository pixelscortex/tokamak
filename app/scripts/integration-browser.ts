import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { startRunner } from "../../e2e/fake-agent/start-runner";

const root = resolve(import.meta.dirname, "../..");
const directory = resolve(process.env.TOKAMAK_SERVER_DIR ?? `${root}/app/.dev/integration/browser`);
const plugins = resolve(process.env.TOKAMAK_PLUGIN_DIR ?? `${root}/app/.dev/integration/plugins`);
const suffix = process.platform === "win32" ? ".exe" : "";
const binaries = resolve(root, "target/debug");
const build = spawnSync(
  "cargo",
  ["build", "--locked", "-p", "tokamak-runner", "-p", "server", "-p", "tokamak-plugin-host"],
  { cwd: root, stdio: "inherit" },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const runner = await startRunner({
  binary: resolve(binaries, `tokamak-runner${suffix}`),
  plugins,
  directory,
});
try {
  // The CLI reads discovery and the scoped control credential, as it does for --reload.
  const listing = spawnSync(resolve(binaries, `tokamak-server${suffix}`), ["plugin", "list"], {
    env: { ...process.env, TOKAMAK_SERVER_DIR: directory },
    encoding: "utf8",
  });
  if (listing.error) throw listing.error;
  if (listing.status !== 0) throw new Error(listing.stderr.trim());
  if (!listing.stdout.includes('"integration-fixture"'))
    throw new Error("Build the integration fixture first");

  const vite = spawn("proto", ["run", "bun", "--", "run", "dev"], {
    cwd: resolve(root, "app"),
    env: {
      ...process.env,
      VITE_TOKAMAK_HTTP: runner.endpoint.http,
      VITE_TOKAMAK_TOKEN: runner.endpoint.token,
    },
    stdio: "inherit",
  });
  const stop = () => vite.kill();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
  try {
    const browserExited = new Promise<number>((accept, reject) => {
      vite.once("error", reject);
      vite.once("exit", (code) => accept(code ?? 0));
    });
    process.exitCode = await Promise.race([browserExited, runner.exited.then((code) => code || 1)]);
  } finally {
    stop();
  }
} finally {
  await runner.stop();
}
