import { For, Show, createEffect, createSignal } from "solid-js";
import { isFailure, type Id, type MachineFailure, type ResultOf } from "@tokamak/sdk";
import { after, append, before, prepend, useClient } from "@tokamak/sdk/client";
import * as chat from "plugin:chat/client";
import { api } from "../server/_generated/api";
import { lastOfTurn, oneAtATime, rememberClient, turnChanged, turnOf } from "./lib/changes";
import { ChangeCard } from "./ui/change-card";
import { BranchChip, ReviewPanelMount, ReviewToggle } from "./ui/thread-header";

/**
 * code's window entry. Everything here is read from this computer's Git
 * through code's local part, so a plain browser shows none of it.
 */

/**
 * Each reply's notice, asked once per window: the footer's parts mount again
 * whenever the thread's messages change, and asking the local part for every
 * reply each time floods the connection until the server closes it.
 */
const notices = new Map<string, Promise<ResultOf<typeof api.notices.forTurn>>>();

function SnapshotNotice(props: chat.MessageProps) {
  const client = useClient();
  rememberClient(client);
  const [notice, setNotice] = createSignal<Exclude<ResultOf<typeof api.notices.forTurn>, MachineFailure>>(
    null,
    { ownedWrite: true },
  );
  createEffect(
    // A string, so a fresh message object for the same reply does not ask again.
    () => `${props.threadId}\n${props.message._id}`,
    (key) => {
      const [threadId, replyId] = key.split("\n") as [Id<"threads">, string];
      let active = true;
      setNotice(null);
      let asked = notices.get(key);
      if (!asked) {
        const turn = turnOf(client, threadId, replyId);
        asked = turn.then((found) =>
          found
            ? oneAtATime(() => client.action(api.notices.forTurn, { threadId, turnId: found.turnId }))
            : null,
        );
        notices.set(key, asked);
        // A failure, or a reply whose turn is not listed yet, is asked again by the next mount.
        turn.then(
          (found) => found || notices.delete(key),
          () => notices.delete(key),
        );
        asked.catch(() => notices.delete(key));
      }
      void asked.then((result) => active && setNotice(isFailure(result) ? null : result)).catch(() => {});
      return () => {
        active = false;
      };
    },
  );
  return (
    <>
      <Show when={notice()?.warning}>{(warning) => <p class="text-label text-ink-3">{warning()}</p>}</Show>
      <Show when={notice()?.omitted.length}>
        <div class="break-words text-label text-ink-3">
          <p>Skipped files over 50 MB:</p>
          <ul aria-label="Skipped files">
            <For each={notice()?.omitted} keyed={(name) => name}>
              {(name) => <li>{name()}</li>}
            </For>
          </ul>
        </div>
      </Show>
    </>
  );
}

export const Notices = append(chat.Message.footer, SnapshotNotice, {
  when: ({ message }) =>
    message.role === "assistant" &&
    message.status !== "streaming" &&
    !!message.author?.id.startsWith("agent:"),
});

/**
 * Removes the snapshot refs of threads deleted elsewhere (another window, or
 * while this app was closed): only the device that made them can, and code
 * has no window entry of its own, so it runs when Chat's composer first
 * mounts. Once per connection; a failed prune is retried on the next mount.
 * Draws nothing.
 */
const started = new WeakSet<object>();
function SnapshotCleanup() {
  const client = useClient();
  if (!started.has(client)) {
    started.add(client);
    void client.action(api.hooks.prune, {}).then(
      (result) => {
        if (isFailure(result) && result.kind !== "noMachine") started.delete(client);
      },
      () => started.delete(client),
    );
  }
  return null;
}

export const Cleanup = prepend(chat.Composer.top, SnapshotCleanup);

/** The change card under the last reply of a turn, only when the turn changed something. */
export const Changes = append(chat.Message.footer, ChangeCard, {
  when: (m) => lastOfTurn(m) && turnChanged(m),
});

/** The branch after the thread's title. */
export const Branch = after(chat.Header.title, BranchChip);

/** The layout control that opens the review panel, before the thread menu. */
export const Review = before(chat.Header.menu, ReviewToggle);

/** The review panel itself, in the shell's panel region; mounted with the thread's header. */
export const Panel = after(chat.Header.menu, ReviewPanelMount);
