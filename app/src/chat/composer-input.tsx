import { onMount, splitProps } from "solid-js";
import { setProp, type NativeEvent, type NativeNode } from "@tokamak/render";
import { Textarea, type TextareaProps } from "@tokamak/ui/components";

/** Apple editing commands do not bubble, so intercept on the native editor. */
export function ComposerInput(props: TextareaProps & { mapOpen: boolean }) {
  const [local, editor] = splitProps(props, ["mapOpen"]);
  let input: NativeNode;

  onMount(() => {
    const original = input.handlers.get("applekeybinding");
    setProp(input, "onAppleKeybinding", (event: NativeEvent) => {
      if (local.mapOpen && event.command?.startsWith("deleteToBeginning")) {
        event.preventDefault();
        return;
      }
      original?.(event);
    });
  });

  return <Textarea {...editor} ref={node => { input = node; }} />;
}
