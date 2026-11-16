import { Show, createMemo, createSignal, type Accessor } from "solid-js";
import type { PluginLoader, SlotContribution } from "@tokamak/runtime/plugins";
import { Contribution } from "../contribution";
import type { Message } from "./use-chat";

type Tool = Extract<Message["parts"][number], { type: "tool" }>;

export function ToolPart(props: { loader: PluginLoader; part: Tool; threadId: string; live?: boolean }) {
  const renderer = createMemo(() =>
    props.live !== false && props.part.status === "done" && props.part.view
      ? props.loader
          .contributions("itemRenderer")
          .find(
            (contribution) =>
              contribution.plugin === props.part.plugin && contribution.options.type === props.part.view,
          )
      : undefined,
  );

  return (
    <Show when={renderer()} fallback={<ToolLine part={props.part} />}>
      {(contribution: Accessor<SlotContribution>) => (
        <Contribution
          loader={props.loader}
          contribution={contribution()}
          failureFallback={<ToolLine part={props.part} />}
          componentProps={{ part: props.part, threadId: props.threadId }}
        />
      )}
    </Show>
  );
}

function ToolLine(props: { part: Tool }) {
  const [expanded, setExpanded] = createSignal(false);
  const label = () =>
    props.part.status === "running"
      ? `${props.part.toolName}…`
      : props.part.status === "error"
        ? `${props.part.toolName} failed`
        : (props.part.summary ?? props.part.toolName);

  return (
    <div class="font-label text-[10px] text-text-3">
      <div class="flex items-center gap-2">
        <span>{label()}</span>
        <button
          class="border-0 bg-transparent p-0 font-label text-[10px] text-text-3"
          aria-label={`Details for ${props.part.toolName}`}
          aria-expanded={expanded()}
          onClick={() => setExpanded((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (!event.repeat) setExpanded((value) => !value);
            }
          }}
        >
          ›
        </button>
      </div>
      <Show when={expanded()}>
        <pre class="m-0 mt-2 whitespace-pre-wrap break-words">
          {JSON.stringify(
            {
              args: props.part.args,
              ...(props.part.status === "error"
                ? { error: props.part.error }
                : { result: props.part.result }),
            },
            null,
            2,
          ).replace(/[\u007f-\u009f\p{Cf}]/gu, "")}
        </pre>
      </Show>
    </div>
  );
}
