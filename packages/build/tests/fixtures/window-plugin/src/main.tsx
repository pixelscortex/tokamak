import { Show, createSignal as signal } from "solid-js";
import { state } from "@tokamak/sdk/client";

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

export const Row = () => {
  const [visible, setVisible] = signal(true);
  return (
    <>
      <button onClick={() => setVisible((v) => !v)}>Toggle left</button>
      <Show when={visible()}>
        <Counter name="Left" />
      </Show>
      <Counter name="Right"></Counter>
    </>
  );
};
