/** Acceptance fixture compiled as universal JSX, then executed only by the
 * renderer's real runtime::QuickJsContext. No browser globals or test JS engine. */
import { createSignal, For, Show } from "solid-js";
import { mount, onHostEvent } from "@tokamak/render";

function App() {
  const [count, setCount] = createSignal(0);
  const [value, setValue] = createSignal("");
  const [focus, setFocus] = createSignal("none");
  const [key, setKey] = createSignal("none");
  const [host, setHost] = createSignal("idle");
  const [disabled, setDisabled] = createSignal(false);
  const [readonly, setReadonly] = createSignal(false);
  const [cancel, setCancel] = createSignal(false);
  const [stop, setStop] = createSignal(false);
  const [bubbles, setBubbles] = createSignal(0);
  const [identity, setIdentity] = createSignal(false);
  const [items, setItems] = createSignal(["a", "b", "c"]);
  const [visible, setVisible] = createSignal(true);
  const [deliveries, setDeliveries] = createSignal(0);

  onHostEvent<{ label: string; count: number }>("update", (p) => {
    setHost(p.label);
    setCount(p.count);
  });
  onHostEvent<{ disabled: boolean; readonly: boolean; cancel: boolean; stop: boolean }>(
    "policy",
    (p) => {
      setDisabled(p.disabled);
      setReadonly(p.readonly);
      setCancel(p.cancel);
      setStop(p.stop);
    },
  );
  onHostEvent<{ items: string[]; visible: boolean }>("tree", (p) => {
    setItems(p.items);
    setVisible(p.visible);
  });
  onHostEvent<null>("clear", () => setValue(""));
  onHostEvent<null>("async", () => {
    Promise.resolve().then(() => setHost("promise settled"));
  });
  onHostEvent<null>("spin", () => {
    const again = (): void => {
      void Promise.resolve().then(again);
    };
    again();
  });

  function Subscriber() {
    onHostEvent<null>("ping", () => setDeliveries((n) => n + 1));

    return <span id="subscriber">subscribed</span>;
  }

  return (
    <main
      id="panel"
      class={count() ? "active panel" : "panel"}
      data-count={count()}
      onClick={(event) => {
        setBubbles((n) => n + 1);
        setIdentity(typeof event.target === "number" && event.target !== event.currentTarget);
      }}
    >
      <button
        id="activate"
        type="button"
        aria-label="Activate fixture"
        aria-pressed={count() % 2 === 1}
        data-pressed={count() % 2 === 1}
        onFocus={() => setFocus("activate")}
        onKeyDown={(event) => {
          setKey(`${event.key}:${event.code}:${event.repeat}:${event.shiftKey}`);
          if (cancel()) event.preventDefault();
        }}
        onClick={(event) => {
          setCount((n) => n + 1);
          if (stop()) event.stopPropagation();
        }}
      >
        Activate
      </button>
      <input
        id="editor"
        type="text"
        value={value()}
        disabled={disabled()}
        readonly={readonly()}
        aria-disabled={false}
        aria-invalid={false}
        aria-describedby="value"
        class="editor"
        onFocus={() => setFocus("editor")}
        onBlur={() => setFocus("none")}
        onInput={(event) => setValue(event.value ?? "")}
        onKeyDown={(event) => {
          if (cancel()) event.preventDefault();
        }}
        onAppleKeybinding={(event) => {
          if (cancel()) event.preventDefault();
        }}
        onComposition={(event) => {
          if (cancel()) event.preventDefault();
        }}
      />
      <button id="blocked" type="button" disabled onClick={() => setCount(999)}>
        Disabled
      </button>
      <button
        id="throw"
        type="button"
        onClick={() => {
          setHost("before throw");
          throw new Error("fixture listener failure");
        }}
      >
        Throw
      </button>
      <p id="count">{count()}</p>
      <p id="value">{value()}</p>
      <p id="focus">{focus()}</p>
      <p id="key">{key()}</p>
      <p id="host">{host()}</p>
      <p id="bubbles">{bubbles()}</p>
      <p id="identity">{String(identity())}</p>
      <p id="deliveries">{deliveries()}</p>
      <section id="list">
        <For each={items()}>{(item) => <span id={`item-${item}`}>{item}</span>}</For>
      </section>
      <Show when={visible()}>
        <Subscriber />
      </Show>
    </main>
  );
}

mount(App);
