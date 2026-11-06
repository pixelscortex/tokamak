/** A real Solid component: idle host ticks and native input share the same
 * reactive graph. Nothing in the native engine knows these counters exist. */
import { createSignal } from "solid-js";
import { mount, onHostEvent } from "@tokamak/render";

function Demo() {
  const [host, setHost] = createSignal(0);
  const [clicks, setClicks] = createSignal(0);
  const [value, setValue] = createSignal("");
  const [focus, setFocus] = createSignal("none");
  const [key, setKey] = createSignal("none");
  const [disabled, setDisabled] = createSignal(false);
  const [readonly, setReadonly] = createSignal(false);

  onHostEvent<{ count: number }>("tick", (tick) => setHost(tick.count));

  return (
    <main class="panel">
      <h1>Tokamak · native Solid</h1>
      <p id="host">Host ticks (no interaction needed): {host()}</p>
      <p>Button activations: {clicks()}</p>
      <button
        id="increment"
        type="button"
        aria-label="Increment counter"
        aria-pressed={clicks() % 2 === 1}
        data-pressed={clicks() % 2 === 1}
        onFocus={() => setFocus("increment")}
        onClick={() => setClicks((n) => n + 1)}
      >
        Increment · click / Enter / Space
      </button>
      <label id="editor-label">Plain text editor</label>
      <input
        id="editor"
        type="text"
        value={value()}
        disabled={disabled()}
        readonly={readonly()}
        aria-label="Plain text editor"
        aria-describedby="help"
        aria-invalid={false}
        onInput={(event) => setValue(event.value ?? "")}
        onFocus={() => setFocus("editor")}
        onBlur={() => setFocus("none")}
        onKeyDown={(event) => setKey(event.key ?? "none")}
      />
      <p id="help">Type, Backspace, paste, Tab. Focus uses :focus, not :focus-visible.</p>
      <p>Value: {value()}</p>
      <p>
        Focus: {focus()} · last key: {key()}
      </p>
      <button id="clear" type="button" onClick={() => setValue("")}>
        Controlled clear
      </button>
      <button type="button" aria-pressed={disabled()} onClick={() => setDisabled((v) => !v)}>
        Toggle disabled: {String(disabled())}
      </button>
      <button type="button" aria-pressed={readonly()} onClick={() => setReadonly((v) => !v)}>
        Toggle readonly: {String(readonly())}
      </button>
      <button disabled type="button" onClick={() => setClicks((n) => n + 1000)}>
        Disabled · must not activate
      </button>
    </main>
  );
}

mount(Demo);
