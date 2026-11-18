import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function buildMachine(root: string, entry: string) {
  const result = spawnSync(
    "proto",
    ["run", "bun", "--", fileURLToPath(new URL("../../sdk/tools/machine.mjs", import.meta.url)), root, entry],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Machine service bundling failed");
}
