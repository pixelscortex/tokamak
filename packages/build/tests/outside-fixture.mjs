import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const workspace = resolve(import.meta.dir, "../../..");

export async function withPlugin(check) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "tokamak-outside-"));
  try {
    const plugin = join(root, "plugin");
    await cp(join(import.meta.dir, "fixtures/outside"), plugin, { recursive: true });
    await check(plugin, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function build(plugin, env = {}) {
  const result = Bun.spawnSync([process.execPath, "packages/build/src/build.ts", plugin], {
    cwd: workspace,
    env: { ...process.env, TOKAMAK_SERVER_DIR: join(plugin, ".test-server"), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}
