/*
  <Density value="dense">
    <Row lead={…}>Weekly admin</Row>
  </Density>

  Sets how tight rows are inside it: roomy 48, normal 40, dense 32 for a
  single row, with 16, 12 and 8 inline padding. Density only gets tighter
  inward: a roomy Density inside a dense one stays dense. With no provider,
  normal applies.
  Slots: none. Renders data-density on a display: contents wrapper.
*/
import { createContext, useContext } from "solid-js";
import type { JSX } from "@solidjs/web";

export type DensityValue = "roomy" | "normal" | "dense";

const order: Record<DensityValue, number> = { roomy: 0, normal: 1, dense: 2 };
const DensityContext = createContext<() => DensityValue | undefined>(() => undefined);

export function useDensity(): () => DensityValue {
  const parent = useContext(DensityContext);
  return () => parent() ?? "normal";
}

export function Density(props: { value: DensityValue; children: JSX.Element }): JSX.Element {
  const parent = useContext(DensityContext);
  const value = (): DensityValue => {
    const outer = parent();
    return outer && order[outer] > order[props.value] ? outer : props.value;
  };
  return (
    <DensityContext value={value}>
      <div data-slot="density" data-density={value()}>
        {props.children}
      </div>
    </DensityContext>
  );
}
