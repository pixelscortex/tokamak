/** TKM-9 native showcase consumes @tokamak/ui/elements with live Solid state.
 * The renderer still owns native editing, focus and native-button activation. */
import { createSignal } from "solid-js";
import { mount, onHostEvent } from "@tokamak/render";
import { Button, Input } from "@tokamak/ui/elements";

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
      <h1>Tokamak · Button + Input</h1>
      <p id="host">Host ticks (no interaction needed): {host()}</p>
      <p>Button activations: {clicks()}</p>
      <Button
        id="increment"
        aria-label="Increment counter"
        defaultPressed={false}
        onFocus={() => setFocus("increment")}
        onClick={() => setClicks((n) => n + 1)}
      >
        Increment · click / Enter / Space
      </Button>
      <Input
        label="Controlled text editor"
        description="Type, Backspace, paste, Tab. Focus includes pointer focus."
        id="editor"
        type="text"
        value={value()}
        disabled={disabled()}
        readonly={readonly()}
        invalid={value().length > 24}
        onValueChange={setValue}
        onFocus={() => setFocus("editor")}
        onBlur={() => setFocus("none")}
        onKeyDown={(event) => setKey(event.key ?? "none")}
      />
      <p id="help">More than 24 characters marks the controlled input invalid.</p>
      <p>Value: {value()}</p>
      <p>
        Focus: {focus()} · last key: {key()}
      </p>
      <Button id="clear" onClick={() => setValue("")}>
        Controlled clear
      </Button>
      <div class="row">
        <Button pressed={disabled()} onPressedChange={setDisabled}>
          Toggle disabled: {String(disabled())}
        </Button>
        <Button pressed={readonly()} onPressedChange={setReadonly}>
          Toggle readonly: {String(readonly())}
        </Button>
        <Button disabled onClick={() => setClicks((n) => n + 1000)}>
          Disabled · must not activate
        </Button>
      </div>
      <div class="row">
        <Button defaultPressed>Initially pressed</Button>
        <Button nativeButton={false} defaultPressed={false} render={(props) => <div {...props} />}>
          Swapped div · Enter / Space
        </Button>
      </div>
      <div class="row">
        <Input label="Uncontrolled" defaultValue="Buy milk" description="Value is owned by Input." />
        <Input label="Disabled" defaultValue="Not editable" disabled />
        <Input label="Invalid" defaultValue="" invalid description="A task title is required." />
      </div>
    </main>
  );
}

mount(Demo);
