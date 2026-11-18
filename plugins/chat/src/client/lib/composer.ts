import { createContext, useContext, type Accessor } from "solid-js";
import { defineSlot } from "@tokamak/sdk/client";
import type { Id } from "@tokamak/sdk";

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

export type EditorAPI = ComposerAPI & {
  selection(start: number, end: number): void;
  bind(input: HTMLTextAreaElement | undefined): void;
  focus(): void;
};
export const ComposerContext = createContext<EditorAPI>();
export function useComposer(): ComposerAPI {
  const api = useContext(ComposerContext);
  if (!api) throw new Error("useComposer requires a chat composer");
  return api;
}

type Drafts = {
  draft(): string;
  edit(text: string): void;
  send(text: string): Promise<void>;
  sending(): boolean;
};
type Chat = { threadId: Accessor<Id<"threads"> | undefined>; active(): unknown };

export function createComposerAPI(chat: Chat, drafts: Drafts): EditorAPI {
  let selection: { thread: string | undefined; start: number; end: number } | undefined;
  let input: HTMLTextAreaElement | undefined;
  // Signal writes land on the next flush, so back-to-back inserts read this copy.
  let pending: { thread: string | undefined; text: string } | undefined;
  const current = () => {
    // Read the signal every time, so a reactive reader keeps its subscription.
    const draft = drafts.draft();
    return pending && pending.thread === chat.threadId() ? pending.text : draft;
  };

  function setDraft(text: string) {
    pending = { thread: chat.threadId(), text };
    drafts.edit(text);
    queueMicrotask(() => (pending = undefined));
  }

  return {
    threadId: chat.threadId,
    getDraft: current,
    setDraft,
    insertText(text) {
      const draft = current();
      const range = selection?.thread === chat.threadId() ? selection : undefined;
      const start = Math.min(range?.start ?? draft.length, draft.length);
      const end = Math.min(range?.end ?? start, draft.length);
      const next = draft.slice(0, start) + text + draft.slice(end);
      const caret = start + text.length;
      setDraft(next);
      selection = { thread: chat.threadId(), start: caret, end: caret };
      requestAnimationFrame(() => {
        if (!input || input.value !== next) return;
        input.focus();
        input.setSelectionRange(caret, caret);
      });
    },
    submit: () => drafts.send(current()),
    busy: () => Boolean(chat.active() || drafts.sending()),
    selection(start, end) {
      selection = { thread: chat.threadId(), start, end };
    },
    bind(element) {
      input = element;
    },
    focus() {
      input?.focus();
    },
  };
}
