/*
  <RowList aria-label="Threads" value={current()} onValueChange={open}>
    <RowOption
      value="a"
      kind="double"
      lead={<StatusIcon status="running" />}
      detail="sonnet 4.5 · invoices-app"
      sub={<Row kind="half" lead={…}>haiku 4.5 running tests</Row>}
    >
      Add CSV export
    </RowOption>
    <RowGroup>
      <RowOption value="b" lead={…} trail={…}>Paginate customer list</RowOption>
      <RowOption value="c" lead={…} trail={…}>PDF dark mode</RowOption>
    </RowGroup>
  </RowList>

  A list of rows you pick from, on ui-sdk Listbox: one tab stop, arrows and
  typing move, Enter or a click selects. Rows in a RowGroup sit 4 apart;
  groups and lone options sit 12 apart. Half rows go in `sub`: they belong
  to their option, 4 under it, and open with it.
  Slots: listbox (data-row-list), listbox-group, listbox-item (data-row)
  holding row-box (the Row slots) and row-sub.
*/
import { Listbox, ListboxGroup, ListboxItem } from "@ui-sdk/solid/listbox";
import { omit } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { RowBody, type RowParts } from "./row.tsx";

export type RowListProps = ComponentProps<typeof Listbox>;

export function RowList(props: RowListProps): JSX.Element {
  return <Listbox data-row-list="" {...props} />;
}

export function RowGroup(props: ComponentProps<typeof ListboxGroup>): JSX.Element {
  return <ListboxGroup {...props} />;
}

export type RowOptionProps = RowParts & { sub?: JSX.Element } & Omit<ComponentProps<typeof ListboxItem>, "children">;

export function RowOption(props: RowOptionProps): JSX.Element {
  const rest = omit(props, "kind", "lead", "trail", "detail", "children", "sub");
  return (
    <ListboxItem {...rest} data-row="">
      <span data-slot="row-box" data-kind={props.kind ?? "single"}>
        <RowBody {...props} />
      </span>
      {props.sub && <span data-slot="row-sub">{props.sub}</span>}
    </ListboxItem>
  );
}
