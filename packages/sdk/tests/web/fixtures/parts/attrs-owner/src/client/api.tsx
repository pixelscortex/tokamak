import { createRenderEffect, For } from "solid-js";

export interface AttributeProps {
  label: string;
  busy: boolean;
  enabled: boolean;
  ownerDisabled: boolean;
  labels: string[];
  mount: () => void;
}

function AttrButton(props: {
  disabled: boolean;
  label: string;
  once?: boolean;
  mount: () => void;
  optional?: () => void;
}) {
  createRenderEffect(
    () => props.mount,
    (mount) => mount(),
  );
  return (
    <button disabled={props.disabled} data-once={String(props.once ?? false)}>
      {props.label}
    </button>
  );
}

export function AttributeScreen(props: AttributeProps) {
  return (
    <main>
      <article data-part="attr-root" class={["flex", { hidden: props.busy }]} title={props.label}>
        <header
          data-part="attr-nested"
          hidden
          itemscope
          class={{ block: true, hidden: props.busy }}
          title={props.label}
        >
          Heading
        </header>
        <input data-part="attr-input" type="text" value={props.label} />
        <AttrButton disabled={props.ownerDisabled} label="Send" mount={props.mount} />
      </article>
      <For each={props.labels}>
        {(label) => (
          <em data-part="attr-row" title={label}>
            {label}
          </em>
        )}
      </For>
    </main>
  );
}
