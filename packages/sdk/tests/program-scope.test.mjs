import { expect, test } from "bun:test";
import { localContext } from "../src/functions";
import { invocationHost } from "../worker/invocation-host";
import { invocationProcesses } from "../worker/process";

test("force stop ends scoped programs while the outer program can still work", async () => {
  const { signal } = new AbortController();
  const invocation = invocationHost(
    signal,
    () => () => null,
    () => invocationProcesses(signal),
  );
  const ctx = localContext(invocation.host(), {});
  const command = [process.execPath, "-e", "for await (const line of console) console.log(line)"];

  try {
    const outer = ctx.proc(command);
    await ctx.withPrograms(async (forceStop, scoped) => {
      const inner = scoped.proc(command);
      inner.write("ready\n");
      expect((await inner.stdout[Symbol.asyncIterator]().next()).value).toBe("ready");

      await forceStop();
      expect(await inner.exited).not.toBe(0);

      outer.write("still running\n");
      outer.closeInput();
      expect((await outer.stdout[Symbol.asyncIterator]().next()).value).toBe("still running");
      expect(await outer.exited).toBe(0);
    });
  } finally {
    await invocation.close();
  }
});
