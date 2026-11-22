import { Show, createSignal as signal } from "solid-js";
import { component, state } from "@tokamak/sdk/client";

function Counter(props: { name: string }) {
  const [count, setCount] = signal(0);
  const note = state("empty");
  return (
    <button
      onClick={() => {
        setCount((n) => n + 1);
        note.set("edited");
      }}
    >
      {props.name}: {count()}, {note()}
    </button>
  );
}

export const Row = component("row", {}, () => {
  const [visible, setVisible] = signal(true);
  return (
    <>
      <button onClick={() => setVisible((v) => !v)}>Toggle left</button>
      <Show when={visible()}>
        <Counter part="left" name="Left" />
      </Show>
      <Counter part="right" name="Right"></Counter>
    </>
  );
});
