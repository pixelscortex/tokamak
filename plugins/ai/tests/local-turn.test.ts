import { LocalReloadTimeout, type TokamakClient } from "@tokamak/sdk";
import { expect, test, vi } from "vitest";
import { runLocalTurn } from "../src/client/lib/local-turn";

test("a normally completed turn produces no reload warning when its result was lost", async () => {
  const local = vi.fn().mockRejectedValue(new LocalReloadTimeout());
  const mutation = vi.fn().mockResolvedValue("ended");
  const client = { local, mutation } as unknown as TokamakClient;

  await expect(
    runLocalTurn(client, { threadId: "thread", messageId: "message", folder: "/fixture", agentId: "agent" }),
  ).resolves.toBeUndefined();
  expect(mutation).toHaveBeenCalledWith(expect.anything(), {
    messageId: "message",
    replyToken: local.mock.calls[0][1].replyToken,
  });
});
