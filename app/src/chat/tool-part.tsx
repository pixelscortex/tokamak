import { Show, createSignal } from "solid-js";
import type { Message } from "./use-chat";
type Tool = Extract<Message["parts"][number], { type: "tool" }>;
export function ToolPart(props: { part: Tool }) {
  return <ToolLine part={props.part} />;
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
