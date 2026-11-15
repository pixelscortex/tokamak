/** The first thread is local to this run. Keeping messages outside the view's
 * owner preserves them while the router mounts a plugin in its place. */
import { For, Show, createMemo, createSignal } from "solid-js";
import { Textarea } from "@tokamak/ui/components";
import { Icon } from "@tokamak/ui";

/** A plain person outline (Lucide "user", ISC licence, https://lucide.dev/license),
 * with its circle written as an equivalent path for `<tk-icon>`. */
const person = "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2 M16 7a4 4 0 1 1-8 0a4 4 0 1 1 8 0Z";

interface Message {
  from: "you" | "agent";
  text: string;
}
const [messages, setMessages] = createSignal<Message[]>([]);

function Mark(props: { from: Message["from"] }) {
  return <Show when={props.from === "you"} fallback={
    <span class="chat-mark chat-mark-agent" aria-hidden="true"><span /></span>
  }>
    <span class="chat-mark chat-mark-you" aria-hidden="true"><Icon d={person} strokeWidth={2.5} class="chat-mark-icon" /></span>
  </Show>;
}

export function Chat(props: { pathname: string }) {
  const [draft, setDraft] = createSignal("");
  // Reverse only the display projection; the in-memory thread is chronological.
  const newestFirst = createMemo(() => [...messages()].reverse());
  function send(text: string) {
    if (!text.trim()) return;
    setMessages(previous => [...previous, { from: "you", text }]);
    setDraft("");
  }
  return <section class="chat-view" aria-label="Chat" data-chat-route={props.pathname}>
    <div class="chat-thread">
      <div class="chat-row">
        <Mark from="you" />
        <Textarea
          id="chat-input"
          aria-label="Message"
          size="md"
          appearance="inherit"
          caret="block"
          class="chat-input"
          placeholder="Reply, or tell Tokamak what to do"
          value={draft()}
          onValueChange={setDraft}
          onSubmit={send}
        />
      </div>
      <For each={newestFirst()}>{message => <div class="chat-row" data-from={message.from}>
        <Mark from={message.from} />
        <p class={message.from === "you" ? "chat-text chat-text-you" : "chat-text chat-text-agent"}>{message.text}</p>
      </div>}</For>
    </div>
  </section>;
}
