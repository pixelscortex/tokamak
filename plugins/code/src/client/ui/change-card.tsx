import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon } from "@tokamak/ui";
import type { MessageProps } from "plugin:chat/client";
import { changeOf, openReview, type ReplyChange } from "../lib/changes";
import { chevronRightIcon, fileCodeIcon } from "../lib/icons";
import { Counts, filesLabel } from "./counts";

/**
 * Under the last reply of a turn that changed something (Paper "Coding ·
 * threads + review", "Summary · changed files"): the turn's counts, and the
 * way into the review panel. The first turn after Git appeared says how many
 * files tracking started with; with no change of its own it opens nothing.
 */
export function ChangeCard(props: MessageProps): JSX.Element {
  return (
    <Show when={changeOf(props)}>
      {(change) => (
        <Show
          when={change().files > 0}
          fallback={
            <div class="flex h-8 w-full items-center gap-2 rounded-sm px-2 surface-card">
              <CardText change={change()} />
            </div>
          }
        >
          <button
            type="button"
            aria-label={`Review turn ${change().number}`}
            onClick={() => openReview(props.threadId, change().turnId)}
            class="flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-start transition duration-200 surface-card hover:bg-hover focus-ring"
          >
            <CardText change={change()} />
            <span class="flex-1" />
            <span class="text-label text-ink-3">open in review</span>
            <Icon path={chevronRightIcon} size={12} class="text-ink-3" />
          </button>
        </Show>
      )}
    </Show>
  );
}

function CardText(props: { change: ReplyChange }): JSX.Element {
  return (
    <>
      <Icon path={fileCodeIcon} class="text-ink" />
      <span class="text-row font-medium text-ink">
        {props.change.tracking === null
          ? filesLabel(props.change.files)
          : `Started tracking · ${filesLabel(props.change.tracking)}`}
      </span>
      <Show when={props.change.files > 0}>
        <Counts added={props.change.added} removed={props.change.removed} />
      </Show>
    </>
  );
}
