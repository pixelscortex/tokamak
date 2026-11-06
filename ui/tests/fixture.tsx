/** TKM-9 behavior fixture: actual package exports, Solid and native host only.
 * Policy changes model owners accepting/rejecting controlled edits reactively. */
import { createSignal } from "solid-js";
import { mount, onHostEvent } from "@tokamak/render";
import type { NativeEvent, NativeNode } from "@tokamak/render";
import { Button, Input } from "@tokamak/ui/elements";

function Fixture() {
  const [policy, setPolicy] = createSignal({ disabled: false, invalid: false, cancel: false, cancelKey: false, renderCancel: true, renderStop: false, renderThrowEmpty: false, accept: false, pressed: false, value: "fixed", name: "editor", label: "Task", description: "One task", class: "custom", defaultValue: "seed" });
  const [counts, setCounts] = createSignal<Record<string, number>>({});
  const [requested, setRequested] = createSignal("none");
  let wrappedEvent: NativeEvent | undefined;
  const count = (name: string) => setCounts((v) => ({ ...v, [name]: (v[name] ?? 0) + 1 }));
  const click = (name: string, event: NativeEvent) => { count(`${name}-click`); if (policy().cancel) event.preventDefault(); };
  const key = (event: NativeEvent) => { if (policy().cancel) event.preventDefault(); };
  const ref = (name: string, node: NativeNode) => { if (node.id > 0) count(`${name}-ref`); };
  onHostEvent<Partial<ReturnType<typeof policy>>>("ui-policy", (p) => setPolicy((v) => ({ ...v, ...p })));
  return <main>
    <Button id="native" defaultPressed={false} class={policy().class} disabled={policy().disabled}
      ref={(node) => ref("native", node)} onKeyDown={key} onKeyUp={key}
      onFocus={() => count("native-focus")} onBlur={() => count("native-blur")}
      onClick={(e) => click("native", e)} onPressedChange={() => count("native-change")}>Native</Button>
    <Button id="custom" ref={(node) => ref("custom", node)} nativeButton={false} defaultPressed={false} disabled={policy().disabled}
      onKeyDown={key} onKeyUp={key} onClick={(e) => click("custom", e)}
      onPressedChange={() => count("custom-change")}
      render={(props, state) => <div {...props} data-render-disabled={state.disabled}>Custom</div>} />
    <Button id="controlled" pressed={policy().pressed} onClick={(e) => click("controlled", e)}
      onPressedChange={(next) => { count("controlled-change"); setRequested(String(next)); if (policy().accept) setPolicy((v) => ({...v, pressed: next})); }}>Controlled</Button>
    <Button id="action">Action</Button>
    <section onClick={(event) => {
      count("wrapped-parent");
      if (event.type === "click") count("wrapped-parent-click");
      if (event === wrappedEvent && event.target !== event.currentTarget) count("wrapped-parent-identity");
      if (event.defaultPrevented) count("wrapped-parent-prevented");
    }}>
      <Button id="wrapped" nativeButton={false} defaultPressed={false}
        onClick={(event) => {
          count("wrapped-owner");
          if (event.type === "click") count("wrapped-owner-click");
          if (event === wrappedEvent && event.target === event.currentTarget) count("wrapped-owner-identity");
        }}
        onPressedChange={() => count("wrapped-change")}
        render={(props) => <div {...props} onClick={(event) => {
          wrappedEvent = event;
          count("wrapped-render");
          if (policy().renderCancel) event.preventDefault();
          if (policy().renderStop) event.stopPropagation();
          if (policy().renderThrowEmpty) throw "";
          props.onClick?.(event);
        }}>Wrapped activation</div>} />
    </section>
    <Input id={policy().name} value={policy().value} disabled={policy().disabled} invalid={policy().invalid}
      label={policy().label} description={policy().description} class={policy().class}
      aria-labelledby="external-label" aria-describedby="external-description"
      onKeyDown={(e) => { if (policy().cancelKey) e.preventDefault(); }}
      ref={(node) => ref("input", node)} onFocus={() => count("input-focus")} onBlur={() => count("input-blur")}
      onInput={(e) => { count("input-handler"); count(`input-cancelable-${e.cancelable}`); if (policy().cancel) e.preventDefault(); }}
      onValueChange={(next) => { count("input-change"); setRequested(next); if (policy().accept) setPolicy((v) => ({...v, value: next})); }}
      render={(props, state) => <input {...props} data-render-invalid={state.invalid}
        onInput={(e) => { count("render-input"); props.onInput?.(e); }} />} />
    <Input id="uncontrolled" defaultValue={policy().defaultValue} label="Uncontrolled" onValueChange={() => count("uncontrolled-change")} />
    <span id="external-label">External label</span><span id="external-description">External description</span>
    <p id="counts">{JSON.stringify(counts())}</p><p id="requested">{requested()}</p>
  </main>;
}
mount(Fixture);
