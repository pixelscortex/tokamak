import assert from "node:assert/strict";
import { createRoot } from "solid-js";
import { TokamakClient } from "../../packages/sdk/src/client";
import { useBackends } from "../src/chat/use-backends";
import { useDrafts } from "../src/chat/use-drafts";
import type { ChatState } from "../src/chat/use-chat";

let discoveries = 0;
let sends = 0;
let sendError: string | undefined = undefined;
let error: string | undefined;
const client = new TokamakClient({
  query: async () => null,
  mutation: async () => null,
  subscribe: () => () => {},
  action: async (name) => {
    if (name === "chat/backends:list") {
      if (++discoveries === 1) throw new Error("temporary discovery failure");
      return [{ id: "agent", plugin: "acp", title: "Agent", folder: true }];
    }
    assert.equal(name, "chat/chat:send");
    sends++;
    if (sendError) throw new Error(sendError);
    return null;
  },
});
let dispose!: () => void;
let discovery!: ReturnType<typeof useBackends>;
let drafts!: ReturnType<typeof useDrafts>;
createRoot((stop) => {
  dispose = stop;
  discovery = useBackends(client);
  drafts = useDrafts({
    client,
    backendDiscovery: discovery,
    threadId: () => "thread",
    active: () => null,
    runs: () => ({}),
    setError: (value: string | undefined) => {
      error = value;
    },
  } as unknown as ChatState);
});
await discovery.refresh();
assert.match(discovery.error()!, /temporary discovery failure/);
assert.equal(discovery.data(), undefined, "failed discovery is not confirmed empty");
await drafts.send("Send despite the unavailable cache");
assert.equal(sends, 1);
await discovery.refresh(); // The same refresh used when opening the picker or retrying.
assert.equal(discoveries, 2);
assert.equal(discovery.error(), undefined);
assert.equal(discovery.data()?.[0]?.id, "agent");
await drafts.send("Send after discovery recovered");
assert.equal(sends, 2);
sendError = "No agent configured: see agents.example.toml";
await drafts.send("Keep this draft");
assert.match(error!, /No agent configured/);
assert.equal(drafts.draft(), "Keep this draft");
await discovery.refresh();
assert.equal(discoveries, 3, "send failure refreshes discovery");
dispose();
console.log("PASS backend discovery failure/retry/send/server error");
