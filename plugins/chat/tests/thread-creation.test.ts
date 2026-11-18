import { expect, test, vi } from "vitest";
import { createRoot, flush } from "solid-js";
import { TokamakClient, type Id, type JsonValue, type SubscriptionEvent } from "@tokamak/sdk";
import { chatKeys } from "../src/client/lib/state/chat-keys";
import { useChat } from "../src/client/lib/state/use-chat";
import { useDrafts } from "../src/client/lib/state/use-drafts";

const oldId = "threads:old" as Id<"threads">;
const newId = "threads:new" as Id<"threads">;
const row = (_id: string) => ({ _id, title: "New chat", createdAt: 1, updatedAt: 1 });

test("a thread-list update cannot send the previous draft while creation is awaiting its response", async () => {
  await createRoot(async (dispose) => {
    let update!: (event: SubscriptionEvent<JsonValue>) => void;
    let created!: (id: JsonValue) => void;
    const action = vi.fn(async (name: string) => {
      if (name === "chat/threads:create") return new Promise<JsonValue>((resolve) => (created = resolve));
      return [];
    });
    const client = new TokamakClient({
      query: async () => null,
      mutation: async () => null,
      action,
      subscribe(name, _args, notify) {
        if (name === "chat/threads:list") {
          update = notify;
          notify({ value: [row(oldId)] });
        } else notify({ value: [] });
        return () => {};
      },
    });
    const chat = useChat(client);
    const drafts = useDrafts(chat);
    flush();
    drafts.edit("Keep the previous draft");
    flush();
    const creating = chat.createThread();
    flush();
    update({ value: [row(newId), row(oldId)] });
    flush();
    expect(chat.threadId()).toBe(oldId);
    expect(chat.creating()).toBe(true);
    await drafts.send(drafts.draft());
    expect(action.mock.calls.map(([name]) => name)).not.toContain("chat/chat:send");
    expect(drafts.draft()).toBe("Keep the previous draft");

    created(newId);
    await creating;
    flush();
    expect(chat.threadId()).toBe(newId);
    expect(chat.creating()).toBe(false);
    expect(drafts.draft()).toBe("");
    await drafts.send("New thread message");
    expect(action).toHaveBeenLastCalledWith("chat/chat:send", {
      threadId: newId,
      text: "New thread message",
    });
    chat.open(oldId);
    flush();
    expect(drafts.draft()).toBe("Keep the previous draft");
    dispose();
  });
});

test("Escape stops an owned hub run and ignores a thread with only another member's run", async () => {
  await createRoot(async (dispose) => {
    let publish!: (event: SubscriptionEvent<JsonValue>) => void;
    const mutation = vi.fn(async (_name: string, _args: JsonValue) => null);
    const mine = { runId: "runs:mine", threadId: oldId, ownerId: "me", startedAt: 1 };
    const theirs = { runId: "runs:other", threadId: oldId, ownerId: "other", startedAt: 2 };
    const chat = useChat(
      new TokamakClient({
        query: async () => ({ id: "me", name: "Me", role: "member" }),
        mutation,
        action: async () => [],
        subscribe(name, _args, notify) {
          if (name === "chat/runs:running") publish = notify;
          notify({ value: name === "chat/threads:list" ? [row(oldId)] : [mine, theirs] });
          return () => {};
        },
      }),
      { hub: "http://127.0.0.1" },
    );
    await vi.waitFor(() => {
      flush();
      expect(chat.userId()).toBe("me");
    });
    const keys = chatKeys({
      draft: () => "",
      canStop: chat.canStop,
      stop: () => void chat.cancel(),
      answer: () => false,
    });
    const escape = () => new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    const owned = escape();
    keys(owned);
    expect(owned.defaultPrevented).toBe(true);
    expect(mutation).toHaveBeenCalledExactlyOnceWith("chat/runs:cancel", { runId: mine.runId });

    publish({ value: [theirs] });
    flush();
    const other = escape();
    keys(other);
    expect(other.defaultPrevented).toBe(false);
    expect(mutation).toHaveBeenCalledTimes(1);
    dispose();
  });
});
