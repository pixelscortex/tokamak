import { readFile, cp, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

function local(invoke) {
  return { kind: "local", args: { kind: "any" }, invoke };
}

export const functions = {
  echo: local((value) => value),
  loop: local(async () => {
    console.info("loop");
    while (true) {}
  }),
  memory: local(() => new Uint8Array(64 * 1024 * 1024)),
  sleep: local(async (_, ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 60000));
    await ctx.op("local.runQuery", {});
  }),
  providers: local((_, ctx) => ctx.contracts.list({ place: "local", owner: "consumer", name: "fixture" })),
  huge: local(() => "x".repeat(1024 * 1024)),
  native: local(async ({ source, endpoint }) => {
    const file = join(tmpdir(), randomUUID());
    await cp(source, file);
    try {
      const path = await realpath(pathToFileURL(file));
      const text = await readFile(path, "utf8");
      let ticks = 0;
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          clearInterval(timer);
          ticks++;
          resolve();
        }, 1);
      });
      const bytes = new TextEncoder().encode("ε");
      return {
        copied: text.includes("export const functions"),
        text: await (await fetch(endpoint)).text(),
        bytes: [...bytes],
        ticks,
      };
    } finally {
      await unlink(file);
    }
  }),
};
