export type ChatKeyControls = {
  draft: () => string;
  canStop: () => boolean;
  stop: () => void;
  /** Answers the pending permission with its n-th option (allow first); false if there is none. */
  answer: (index: number) => boolean;
};

/** Keys for the chat stage: Esc stops a reply, 1–4 answer a permission while the draft is empty. */
export function chatKeys(controls: ChatKeyControls) {
  return (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (event.key === "Escape" && controls.canStop()) {
      // A popup or dialog closes first; Esc reaches here only when nothing else used it.
      event.preventDefault();
      if (!event.repeat) controls.stop();
      return;
    }
    if (plain && /^[1-4]$/.test(event.key) && !controls.draft() && !event.repeat) {
      if (controls.answer(Number(event.key) - 1)) event.preventDefault();
    }
  };
}
