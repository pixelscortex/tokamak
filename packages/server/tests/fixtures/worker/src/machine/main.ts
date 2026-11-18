import { appendFile, readFile, writeFile } from "node:fs/promises";
import type { MachineContext } from "@tokamak/sdk";

export async function start(ctx: MachineContext) {
  const config = await ctx.configuration();
  await appendFile("starts", `${process.pid}:${config.machineId}\n`);
  // Exercise one unplanned exit before the healthy, cooperative lifetime.
  try {
    await readFile("crashed");
  } catch {
    await writeFile("crashed", "yes");
    process.exit(17);
  }
  await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
  await writeFile("stopped", String(process.pid));
}
