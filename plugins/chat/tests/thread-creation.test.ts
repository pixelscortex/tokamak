import { expect, test, vi } from "vitest";
import { createRoot, flush } from "solid-js";
import { TokamakClient, type Id, type JsonValue, type SubscriptionEvent } from "@tokamak/sdk";
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
