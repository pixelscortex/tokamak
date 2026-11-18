/*
  <RowList.Root aria-label="Threads" value={current()} onValueChange={open}>
    <RowList.Option value="a" kind="double" lead={…} detail="sonnet 4.5" sub={<Row kind="half">…</Row>}>
      Add CSV export
    </RowList.Option>
    <RowList.Group>
      <RowList.Option value="b" lead={…} trail="12m">Paginate customer list</RowList.Option>
    </RowList.Group>
  </RowList.Root>

  Rows you pick from, on ui-sdk Listbox: one tab stop, arrows and typing
  move, Enter or a click selects. Rows in a Group sit 4 apart; groups and
  lone options 12 apart. Half rows go in `sub`: they open with their option.
*/
import { Listbox, ListboxGroup, ListboxItem } from "@ui-sdk/solid/listbox";
import { omit } from "solid-js";
import type { ComponentProps, JSX } from "@solidjs/web";
import { cn } from "./cn.ts";
import { RowBody, rowVariants, type RowParts } from "./row.tsx";

export function Root(props: ComponentProps<typeof Listbox>): JSX.Element {
  const rest = omit(props, "class");
  return (
    <Listbox
      {...rest}
      data-slot="row-list"
      class={cn("flex flex-col gap-3 outline-offset-2", props.class as string)}
    />
  );
}

export function Group(props: ComponentProps<typeof ListboxGroup>): JSX.Element {
  const rest = omit(props, "class");
  return <ListboxGroup {...rest} class={cn("flex flex-col gap-1", props.class as string)} />;
}

export type OptionProps = RowParts & { sub?: JSX.Element } & Omit<
    ComponentProps<typeof ListboxItem>,
    "children"
  >;

export function Option(props: OptionProps): JSX.Element {
  const rest = omit(props, "kind", "lead", "trail", "detail", "children", "sub", "class");
  return (
    <ListboxItem
      {...rest}
      class={cn("group/row flex cursor-pointer flex-col gap-1 rounded-sm focus-ring", props.class as string)}
    >
      <span
        data-slot="row-box"
        class={cn(
          rowVariants({ kind: props.kind }).root(),
          "group-hover/row:bg-hover group-data-disabled/row:cursor-default",
        )}
      >
        <RowBody {...props} />
      </span>
      {props.sub && (
        <span data-slot="row-sub" class="flex flex-col">
          {props.sub}
        </span>
      )}
    </ListboxItem>
  );
}
