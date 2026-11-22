// A test plugin that extends chat the way `ai` and `code` will: through the
// elements chat publishes, never through chat's source.
import { after, append, before, prepend, replace, wrap } from "@tokamak/sdk/client";
import { Button } from "@tokamak/ui";
import { createSignal, onCleanup } from "solid-js";
import * as chat from "plugin:chat/client";

export const Question = prepend(chat.Composer.top, () => <p>Probe question</p>);
export const AgentRow = after(chat.Composer.box, (props) => (
  <p>Probe agent row for {props.threadId ?? "a new thread"}</p>
));
// Only under the last message: `when` reads the props of each message.
export const ChangeCard = append(
  chat.Message.footer,
  (props) => <p>Probe change card in {props.threadId}</p>,
  {
    when: (props) => props.isLast,
  },
);
// Appending a user message takes away this frame while leaving the reply and its other layers in place.
export const LastReplyFrame = wrap(chat.Message.footer, (props) => <aside>{props.children}</aside>, {
  order: -1,
  when: (props) => props.message.role === "assistant" && props.isLast,
});
// Local state detects an accidental remount when the neighboring frame's condition flips.
export const ReplyActions = wrap(
  chat.Message.footer,
  (props) => (
    <>
      <ReplyDisclosure part="footer" message={props.message} />
      {props.children}
    </>
  ),
  { when: (props) => props.message.role === "assistant" && props.next?.role !== "assistant" },
);
export const ReplyWork = before(
  chat.Message.body,
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
      <Button aria-expanded={open() ? "true" : "false"} onClick={() => setOpen((value) => !value)}>
        Probe {props.part} actions
      </Button>
      {open() && (
        <p>
          {props.part} actions for {chat.messageText(props.message)}
        </p>
      )}
    </>
  );
}

export const Heading = replace(chat.Empty.heading, () => <h2>What should Probe work on?</h2>);
export const Status = append(chat.ThreadRow.status, (props) => (
  <span aria-label={`Probe status of ${props.thread.title}`}>●</span>
));
export const Detail = append(chat.ThreadRow.detail, () => <span>opus 5.5 · invoices-app</span>, {
  when: (props) => props.thread.title === "Add CSV export",
});
export const Branch = after(chat.Header.title, () => <span>Probe branch</span>);
