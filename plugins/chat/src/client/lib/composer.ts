import { createContext, useContext, type Accessor } from "solid-js";
import { defineSlot } from "@tokamak/sdk/client";
import type { Id } from "@tokamak/sdk";
import type { ChatState } from "./state/use-chat";
import type { useDrafts } from "./state/use-drafts";

export interface ComposerAPI {
  threadId: Accessor<Id<"threads"> | undefined>;
  getDraft(): string;
  setDraft(text: string): void;
  insertText(text: string): void;
  submit(): Promise<void>;
  busy: Accessor<boolean>;
}
export interface ComposerSlotProps {
  composer: ComposerAPI;
}
export const composerBefore = defineSlot<ComposerSlotProps>("composer.before");
export const composerActions = defineSlot<ComposerSlotProps>("composer.actions");
export const composerStripLeft = defineSlot<ComposerSlotProps>("composer.strip.left");
export const composerStripRight = defineSlot<ComposerSlotProps>("composer.strip.right");
export const composerAfter = defineSlot<ComposerSlotProps>("composer.after");
type EditorAPI = ComposerAPI & { selection(start: number, end: number): void };
export const ComposerContext = createContext<EditorAPI>();
export function useComposer(): ComposerAPI {
  const api = useContext(ComposerContext);
  if (!api) throw new Error("useComposer requires a chat composer");
  return api;
}
export function createComposerAPI(chat: ChatState, drafts: ReturnType<typeof useDrafts>): EditorAPI {
  let selection: { thread: string | undefined; start: number; end: number } | undefined;
  return {
    threadId: chat.threadId,
    getDraft: () => drafts.draft(),
    setDraft(text) {
      drafts.edit(text);
    },
    insertText(text) {
      const draft = drafts.draft();
      const range = selection?.thread === chat.threadId() ? selection : undefined;
      const start = Math.min(range?.start ?? draft.length, draft.length);
      const end = Math.min(range?.end ?? start, draft.length);
      drafts.edit(draft.slice(0, start) + text + draft.slice(end));
      selection = { thread: chat.threadId(), start: start + text.length, end: start + text.length };
    },
    submit: () => drafts.send(drafts.draft()),
    busy: () => Boolean(chat.active() || drafts.sending()),
    selection(start, end) {
      selection = { thread: chat.threadId(), start, end };
    },
  };
}
