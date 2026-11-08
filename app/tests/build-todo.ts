/** Build only the retired fixture; never register its functions in the product. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const result = spawnSync(process.execPath, ["x", "--no-install", "vite", "build"], {
  cwd: fileURLToPath(new URL("./fixtures/todo/", import.meta.url)),
  stdio: "inherit", timeout: 30_000,
});
assert.ifError(result.error);
assert.equal(result.status, 0, "retired Todo fixture build");
