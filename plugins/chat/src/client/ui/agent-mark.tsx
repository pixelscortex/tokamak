import { Show, createSignal, type Accessor } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Icon, cn } from "@tokamak/ui";
import type { Agent } from "../lib/agents";

// One load per URL for the whole session; the browser's HTTP cache keeps the file
// across sessions. undefined while loading, false when missing or offline.
const logos = new Map<string, Accessor<boolean | undefined>>();

function loaded(url: string): boolean | undefined {
  let state = logos.get(url);
  if (!state) {
    const [value, set] = createSignal<boolean | undefined>(undefined, { ownedWrite: true });
    const image = new Image();
    image.onload = () => set(true);
    image.onerror = () => set(false);
    image.src = url;
    logos.set(url, (state = value));
  }
  return state();
}

/**
 * An agent's brand icon from LobeHub, painted in the current text colour like the
 * bundled marks. Shows the bundled mark (or `fallback`) until the icon loads, and
 * keeps it when the icon is missing or the CDN cannot be reached.
 */
export function AgentMark(props: {
  agent: Agent | undefined;
  fallback: string;
  size?: 12 | 16;
  class?: string;
}): JSX.Element {
  const logo = () => {
    const url = props.agent?.logo;
    return url && loaded(url) ? url : undefined;
  };
  return (
    <Show
      when={logo()}
      fallback={<Icon path={props.agent?.mark ?? props.fallback} size={props.size} class={props.class} />}
    >
      {(url) => (
        <span
          data-slot="icon"
          aria-hidden="true"
          class={cn("block shrink-0 bg-current", props.size === 12 ? "size-3" : "size-4", props.class)}
          style={{
            "mask-image": `url("${url()}")`,
            "-webkit-mask-image": `url("${url()}")`,
            "mask-size": "contain",
            "-webkit-mask-size": "contain",
            "mask-repeat": "no-repeat",
            "-webkit-mask-repeat": "no-repeat",
            "mask-position": "center",
            "-webkit-mask-position": "center",
          }}
        />
      )}
    </Show>
  );
}
