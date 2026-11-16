import assert from "node:assert/strict";
import { createEffect, createRoot, createSignal, onCleanup } from "solid-js";
import {
  ExtensionProvider,
  Slot,
  defineSlot,
  publicComponent,
  type ExtensionHost,
} from "@tokamak/sdk/client";
import { createComposerAPI } from "../../plugins/chat/src/client/lib/composer";
import { useDrafts } from "../../plugins/chat/src/client/lib/state/use-drafts";
import type { ChatState } from "../../plugins/chat/src/client/lib/state/use-chat";
import type { Id } from "@tokamak/sdk";

const slot = defineSlot<{ text: string }>("test.actions");
const [catalog, setCatalog] = createSignal(["mod"]);
const [versions, setVersions] = createSignal<Record<string, number>>({});
const [text, setText] = createSignal("first");
let mounts = 0,
  cleanups = 0,
  loads = 0;
let observed = "";
let aliasApplied = false;
const host: ExtensionHost = {
  contributions: (kind) =>
    kind === "fill"
      ? catalog().map((plugin) => ({ plugin, id: "Fill", kind, options: { target: slot.name } }))
      : kind === "replace"
        ? [{ plugin: "mod", id: "Replacement", kind, options: { target: "owner.Alias" } }]
        : [],
  version: (id) => versions()[id] ?? 0,
  onError: () => () => {},
  async load() {
    loads++;
    return {
      Fill(props: { text: string }) {
        mounts++;
        onCleanup(() => cleanups++);
        createEffect(() => {
          observed = props.text;
        });
        return null;
      },
      Replacement() {
        aliasApplied = true;
        return null;
      },
    };
  },
};
let dispose!: () => void;
createRoot((stop) => {
  dispose = stop;
  const Component = publicComponent(["owner.Input", "owner.Alias"], () => null);
  return (
    <ExtensionProvider host={host}>
      <Slot of={slot} props={{ text: text() }} />
      <Component />
    </ExtensionProvider>
  );
});
await Promise.resolve();
assert.equal(mounts, 1);
assert.equal(observed, "first");
assert.equal(aliasApplied, true);
setText("second");
assert.equal(observed, "second");
assert.equal(mounts, 1, "reactive slot props must not remount a fill");
assert.equal(cleanups, 0);
setCatalog(["mod"]);
await Promise.resolve();
assert.equal(mounts, 1, "unrelated catalog refresh must preserve fill identity");
assert.equal(loads, 1);
setVersions({ mod: 1 });
await Promise.resolve();
assert.equal(mounts, 2);
assert.equal(cleanups, 1);
dispose();
assert.equal(cleanups, 2);

createRoot((stop) => {
  const [threadId, setThreadId] = createSignal("first" as Id<"threads">);
  const chat = { threadId, runs: () => ({}), active: () => null } as unknown as ChatState;
  const drafts = useDrafts(chat);
  const composer = createComposerAPI(chat, drafts);
  composer.setDraft("private first draft");
  setThreadId("second" as Id<"threads">);
  assert.equal(composer.getDraft(), "");
  assert.equal(
    composer.setDraft("second draft"),
    undefined,
    "setDraft must never return the shared draft record",
  );
  composer.insertText(" appended");
  assert.equal(composer.getDraft(), "second draft appended");
  setThreadId("first" as Id<"threads">);
  assert.equal(composer.getDraft(), "private first draft");
  stop();
});
console.log(
  "PASS client extensions: scoped drafts, stable fills, reactive props, public aliases, generation disposal",
);
