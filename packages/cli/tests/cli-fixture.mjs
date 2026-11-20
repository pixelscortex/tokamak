import { join } from "node:path";
import { workspace } from "../../build/tests/outside-fixture.mjs";

export function cli(root, args, extra = {}) {
  const result = Bun.spawnSync([process.execPath, "run", "--silent", "tokamak", ...args], {
    cwd: workspace,
    timeout: 60_000,
    env: {
      ...process.env,
      TOKAMAK_SERVER: undefined,
      TOKAMAK_TOKEN: undefined,
      TOKAMAK_SERVER_DIR: join(root, "data"),
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}
