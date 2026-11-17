/*
  <FileName path="src/invoices/InvoiceTable.tsx" />

  A file name that truncates in the base name and keeps its extension. The
  folder shows as a data prefix when there is room; the full path is the
  accessible name and the tooltip.
*/
import type { JSX } from "@solidjs/web";
import { cn } from "./cn.ts";

export function splitPath(path: string): { folder: string; base: string; extension: string } {
  const slash = path.lastIndexOf("/") + 1;
  const name = path.slice(slash);
  const dot = name.lastIndexOf(".");
  const cut = dot > 0 ? dot : name.length;
  return { folder: path.slice(0, slash), base: name.slice(0, cut), extension: name.slice(cut) };
}

export function FileName(props: { path: string; folder?: boolean; class?: string }): JSX.Element {
  const parts = () => splitPath(props.path);
  return (
    <span
      data-slot="file-name"
      title={props.path}
      aria-label={props.path}
      class={cn("flex min-w-0 items-baseline", props.class)}
    >
      {props.folder !== false && parts().folder && (
        <span aria-hidden="true" class="min-w-0 truncate pe-1 text-data text-ink-3">
          {parts().folder}
        </span>
      )}
      <span aria-hidden="true" class="min-w-0 truncate">
        {parts().base}
      </span>
      <span aria-hidden="true" class="shrink-0">
        {parts().extension}
      </span>
    </span>
  );
}
