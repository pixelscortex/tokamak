import { expect, test, vi } from "vitest";
import { fail, type Id, type LocalContext } from "@tokamak/sdk";
import { contractScope } from "@tokamak/sdk/internal/contracts";
import { hooksFor } from "../src/server/turn-hooks";

test("closing turns that skip after releases their before receipts", async () => {
  const after = vi.fn(async () => {});
  const snapshot = { before: vi.fn(), after };
  const validation = { before: vi.fn() };
  const ctx = {
    [contractScope]: {
      routed: true,
      list: async () => [
        { id: "snapshot", implementation: snapshot },
        { id: "validation", implementation: validation },
      ],
    },
  } as unknown as LocalContext;
  const turn = { threadId: "threads:one" as Id<"threads">, turnId: "turns:one", folder: "/work" };
  const hooks = hooksFor(ctx, turn);

  for (let i = 0; i < 20; i++) {
    snapshot.before.mockResolvedValueOnce({ state: `receipt-${i}` });
    validation.before.mockResolvedValueOnce(fail("Validation", { reason: "Cannot start" }));
    expect(await hooks.before()).toBe("Cannot start");
    hooks.close();
  }
  expect(after).not.toHaveBeenCalled();

  // Reuse the very same bound provider without a new receipt. Any entry kept
  // after close would now be replayed to this after hook.
  expect(await hooks.before()).toBeUndefined();
  expect(await hooks.after()).toBeUndefined();
  expect(after).toHaveBeenCalledExactlyOnceWith(turn);
});
