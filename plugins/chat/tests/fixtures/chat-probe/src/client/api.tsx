// A test plugin that extends chat the way `ai` and `code` will: through the
// elements chat publishes, never through chat's source.
import { after, append, before, prepend, replace, wrap } from "@tokamak/sdk/client";
import { createSignal, onCleanup } from "solid-js";
import * as chat from "plugin:chat/client";

export const Question = prepend(chat.parts.Composer.div.div, () => <p>Probe question</p>);
export const AgentRow = after(chat.parts.Composer.div.div$2, (props) => (
  <p>Probe agent row for {props.threadId ?? "a new thread"}</p>
));
// Only under the last message: `when` reads the props of each message.
export const ChangeCard = append(
  chat.parts.Message.article.div$2,
  (props) => <p>Probe change card in {props.threadId}</p>,
  {
    when: (props) => props.isLast,
  },
);
// Appending a user message takes away this frame while leaving the reply and its other layers in place.
export const LastReplyFrame = wrap(
  chat.parts.Message.article.div$2,
  (props) => <aside>{props.children}</aside>,
  {
    order: -1,
    when: (props) => props.message.role === "assistant" && props.isLast,
  },
);
// Local state detects an accidental remount when the neighboring frame's condition flips.
export const ReplyActions = wrap(
  chat.parts.Message.article.div$2,
  (props) => (
    <>
      <ReplyDisclosure part="footer" message={props.message} />
      {props.children}
    </>
  ),
  { when: (props) => props.message.role === "assistant" && props.next?.role !== "assistant" },
);
export const ReplyWork = before(
  chat.parts.Message.article.div,
  (props) => <ReplyDisclosure part="body" message={props.message} />,
  { when: (props) => props.message.role === "assistant" },
);

function ReplyDisclosure(props: { part: "body" | "footer"; message: chat.MessageDoc }) {
  const [open, setOpen] = createSignal(false, { ownedWrite: true });
  onCleanup(() =>
    document.dispatchEvent(new CustomEvent("probe-reply-actions-unmounted", { detail: props.part })),
  );
  return (
    <>
      <button
        type="button"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => setOpen((value) => !value)}
      >
        Probe {props.part} actions
      </button>
      {open() && (
        <p>
          {props.part} actions for {chat.messageText(props.message)}
        </p>
      )}
    </>
  );
}

export const Heading = replace(chat.parts.Empty.div.div.h2, () => <h2>What should Probe work on?</h2>);
export const Status = append(chat.parts.ThreadRow.ListboxItem.span.span.span, (props) => (
  <span aria-label={`Probe status of ${props.thread.title}`}>●</span>
));
export const Detail = append(
  chat.parts.ThreadRow.ListboxItem.span.span$2,
  () => <span>opus 5.5 · invoices-app</span>,
  {
    when: (props) => props.thread.title === "Add CSV export",
  },
);
export const Branch = after(chat.parts.Header.div.div, () => <span>Probe branch</span>);
