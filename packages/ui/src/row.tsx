/*
  <Row lead={<StatusIcon status="done" />} trail={<span class="text-data">12m</span>}>
    Paginate customer list
  </Row>
  <Row kind="double" selected lead={…} trail={…} detail={<>sonnet 4.5 · invoices-app</>}>
    Add CSV export
  </Row>
  <Row kind="half" lead={<Icon path={…} size={12} />} trail={<StatusIcon status="running" size={12} />}>
    haiku 4.5 running tests
  </Row>
  <Row render={(attrs) => <a href="/threads/1" {...attrs} />}>Weekly admin</Row>

  One row grammar in three heights. Single: 32 / 40 / 48 by density. Double:
  48, with a 12/16 tertiary line of facts at the title's edge (never status
  words, never under the lead). Half: 24, a child of the row above, starting
  at its title edge. Lead is one 16 icon or mark (12 in a half row), 8 from
  the title; trail is one quiet item. Idle rows read secondary; a selected
  row takes the selected fill, ink and weight 500.
  To make rows a pickable list, use RowList and RowOption.
  A consumer may add layout classes only.
  Slots: row-lead, row-title, row-trail, row-detail. data-slot="row",
  data-kind, data-selected.
*/
import { merge, omit } from "solid-js";
import type { JSX } from "@solidjs/web";

export type RowKind = "single" | "double" | "half";

export type RowParts = {
  kind?: RowKind;
  lead?: JSX.Element;
  trail?: JSX.Element;
  detail?: JSX.Element;
  children: JSX.Element;
};

export function RowBody(props: RowParts): JSX.Element {
  return (
    <>
      <span data-slot="row-line">
        {props.lead && <span data-slot="row-lead">{props.lead}</span>}
        <span data-slot="row-title">{props.children}</span>
        {props.trail && <span data-slot="row-trail">{props.trail}</span>}
      </span>
      {props.kind === "double" && props.detail && <span data-slot="row-detail">{props.detail}</span>}
    </>
  );
}

export type RowProps = RowParts &
  Omit<JSX.HTMLAttributes<HTMLElement>, "children"> & {
    selected?: boolean;
    render?: (attrs: Record<string, unknown>) => JSX.Element;
  };

export function Row(props: RowProps): JSX.Element {
  const rest = omit(props, "kind", "lead", "trail", "detail", "children", "selected", "render");
  const attrs = merge(rest, {
    "data-slot": "row",
    get "data-kind"() {
      return props.kind ?? "single";
    },
    get "data-selected"() {
      return props.selected ? "" : undefined;
    },
    get children() {
      return <RowBody {...props} />;
    },
  }) as Record<string, unknown>;
  return props.render ? props.render(attrs) : <div {...attrs} />;
}
