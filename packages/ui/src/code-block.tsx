/*
  <CodeBlock code={source} language="ts" />

  Code you could copy: mono 14/20 on the surface's hover tone, radius 12
  with 4 padding, scrolling sideways instead of wrapping. The copy key sits
  in the top row beside the language; after a copy it shows a check and
  its name says Copied.
*/
import { createSignal, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button } from "./button.tsx";
import { cn } from "./cn.ts";
import { icons } from "./icons.ts";

const copyIcon =
  "M6.9998 6V3C6.9998 2.44772 7.44752 2 7.9998 2H19.9998C20.5521 2 20.9998 2.44772 20.9998 3V17C20.9998 17.5523 20.5521 18 19.9998 18H16.9998V20.9991C16.9998 21.5519 16.5499 22 15.993 22H4.00666C3.45059 22 3 21.5554 3 20.9991L3.0026 7.00087C3.0027 6.44811 3.45264 6 4.00942 6H6.9998ZM5.00242 8L5.00019 20H14.9998V8H5.00242ZM8.9998 6H16.9998V16H18.9998V4H8.9998V6Z";

export function CodeBlock(props: {
  code: string;
  language?: string;
  copy?: (text: string) => Promise<void>;
  class?: string;
}): JSX.Element {
  const [copied, setCopied] = createSignal(false, { ownedWrite: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  async function copy() {
    try {
      await (props.copy ?? ((text) => navigator.clipboard.writeText(text)))(props.code);
    } catch {
      return;
    }
    clearTimeout(timer);
    setCopied(true);
    timer = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <figure
      data-slot="code-block"
      class={cn("m-0 flex min-w-0 flex-col rounded-md bg-hover p-1", props.class)}
    >
      <div class="flex items-center gap-2 ps-3">
        <span class="min-w-0 flex-1 truncate text-data text-ink-3">{props.language}</span>
        <Button
          variant="ghost"
          icon={copied() ? icons.check : copyIcon}
          label={copied() ? "Copied" : "Copy code"}
          onClick={() => void copy()}
        />
      </div>
      <pre class="m-0 overflow-x-auto px-3 pb-3 font-mono text-row text-ink">
        <code>{props.code}</code>
      </pre>
    </figure>
  );
}
