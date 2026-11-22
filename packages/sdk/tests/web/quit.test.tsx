import { describe, expect, test } from "vitest";
import { onQuit, quitBlockers } from "@tokamak/sdk/client";

describe("quitting with work in progress", () => {
  test("the app hears every blocker, and a broken or silent check blocks nothing", async () => {
    const stopped: string[] = [];
    const removers = [
      onQuit(() => ({
        message: "Claude is still working in 1 thread",
        stop: async () => stopped.push("claude"),
      })),
      onQuit(async () => undefined),
      onQuit(() => {
        throw new Error("broken plugin");
      }),
      onQuit(() => new Promise(() => {})),
    ];
    const blockers = await quitBlockers(50);
    expect(blockers.map((blocker) => blocker.message)).toEqual(["Claude is still working in 1 thread"]);
    await blockers[0]!.stop();
    expect(stopped).toEqual(["claude"]);

    for (const remove of removers) remove();
    expect(await quitBlockers(50)).toEqual([]);
  });
});
