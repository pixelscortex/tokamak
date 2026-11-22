/*
  <Row lead={<StatusIcon status="done" />} trail="12m">Paginate customer list</Row>
  <Row kind="double" selected lead={…} trail="0:12" detail="sonnet 4.5 · invoices-app">Add CSV export</Row>
  <Row kind="half" lead={<Icon path={mark} size={12} />}>haiku 4.5 running tests</Row>
  <Row as="button" onClick={createThread}>New thread</Row>
  <Row render={(attrs) => <a href="/threads/1" {...attrs} />}>Weekly admin</Row>

  Single rows follow the container's density-* (32 / 40 / 48); double is 48,
  half is 24 and starts at the title edge of the row above. Lead 16, 8 from
  the title; trail one quiet item; detail holds facts, never status words.
  Selected: the surface's selected fill, ink, weight 500.
*/
import { merge, omit } from "solid-js";
import type { JSX } from "@solidjs/web";
import { cn, tv } from "./cn.ts";

export const rowVariants = tv({
  slots: {
    root: [
      "group/row flex min-w-0 flex-col justify-center rounded-sm px-row text-start text-row text-ink-2 no-underline",
      "data-selected:bg-selected data-selected:text-ink",
      "group-data-selected/row:bg-selected group-data-selected/row:text-ink group-data-disabled/row:text-ink-3",
    ],
    line: "flex min-w-0 items-center gap-2",
    lead: "flex w-4 shrink-0 justify-center text-ink-3 group-data-selected/row:text-ink",
    title: "min-w-0 flex-1 truncate group-data-selected/row:font-medium",
    trail: "flex shrink-0 items-center gap-1 text-data text-ink-3",
    detail: "flex min-w-0 items-center gap-1 truncate text-label text-ink-3",
  },
  variants: {
    kind: {
      single: { root: "h-row" },
      double: { root: "h-12" },
      half: {
        root: "h-6 text-label text-ink-3 group-data-selected/row:bg-transparent group-data-selected/row:text-ink-3",
        line: "ps-6 gap-1",
        lead: "w-3 group-data-selected/row:text-ink-3",
      },
    },
    lead: { true: { detail: "ps-6" } },
    interactive: { true: { root: "cursor-pointer hover:bg-hover focus-ring" } },
  },
  defaultVariants: { kind: "single" },
});

export type RowKind = "single" | "double" | "half";

export type RowParts = {
  kind?: RowKind;
  lead?: JSX.Element;
  trail?: JSX.Element;
  detail?: JSX.Element;
  children: JSX.Element;
};

export function RowBody(props: RowParts): JSX.Element {
  const slots = () => rowVariants({ kind: props.kind, lead: Boolean(props.lead) });
  return (
    <>
      <span data-slot="row-line" class={slots().line()}>
        {props.lead && (
          <span data-slot="row-lead" class={slots().lead()}>
            {props.lead}
          </span>
        )}
        <span data-slot="row-title" class={slots().title()}>
          {props.children}
        </span>
        {props.trail && (
          <span data-slot="row-trail" class={slots().trail()}>
            {props.trail}
          </span>
        )}
      </span>
      {props.kind === "double" && props.detail && (
        <span data-slot="row-detail" class={slots().detail()}>
          {props.detail}
        </span>
      )}
    </>
  );
}

export type RowProps = RowParts &
  Omit<JSX.HTMLAttributes<HTMLElement>, "children" | "class"> & {
    class?: string;
    selected?: boolean;
    as?: "button";
    render?: (attrs: Record<string, unknown>) => JSX.Element;
  };

export function Row(props: RowProps): JSX.Element {
  const rest = omit(
    props,
    "kind",
    "lead",
    "trail",
    "detail",
    "children",
    "selected",
    "as",
    "render",
    "class",
  );
  const attrs = merge(rest, {
    "data-slot": "row",
    get "data-selected"() {
      return props.selected ? "" : undefined;
    },
    get class() {
      return cn(
        rowVariants({ kind: props.kind, interactive: props.as === "button" || Boolean(props.render) }).root(),
        props.as === "button" && "w-full",
        props.class,
      );
    },
    get children() {
      return <RowBody {...props} />;
    },
  }) as Record<string, unknown>;
  if (props.render) return props.render(attrs);
  if (props.as === "button") return <button type="button" {...attrs} />;
  return <div {...attrs} />;
}
