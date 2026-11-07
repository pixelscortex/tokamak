/** Production-build regression: ordinary interfaces and annotated callbacks must
 * survive the REAL bundler, including when its checkout path contains spaces. */
import { createSignal } from "solid-js";
import { mount, onHostEvent } from "@tokamak/render";

interface Payload {
  label: string;
  count: number;
}

function TypedApp() {
  const [value, setValue] = createSignal("initial");

  onHostEvent<Payload>("typed", (payload: Payload): void => {
    setValue(`${payload.label}:${payload.count}`);
  });

  return <p id="typed">{value()}</p>;
}

mount(TypedApp);
