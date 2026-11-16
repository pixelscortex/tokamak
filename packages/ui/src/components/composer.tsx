/** Message input with command, context, approval and run controls. */
import { Show, createSignal, untrack } from "solid-js";
import type { JSX } from "@tokamak/render";
import { Textarea } from "./textarea";
import { createComposerCommands, ComposerCommandMenu } from "./composer-commands";
import {
  ComposerFormFields,
  ComposerApprovalShelf,
  ComposerRunShelf,
  ComposerContextChips,
  ComposerFooter,
} from "./composer-parts";
import type { ComposerProps } from "./composer-types";
export type {
  ComposerContext,
  ComposerRun,
  ComposerCommand,
  ComposerField,
  ComposerForm,
  ComposerApproval,
  ComposerProps,
} from "./composer-types";

export function Composer(props: ComposerProps): JSX.Element {
  const [own, setOwn] = createSignal(untrack(() => props.defaultValue ?? ""));
  const draft = () => props.value ?? own();
  function setDraft(next: string) {
    if (props.value === undefined) setOwn(next);
    props.onValueChange?.(next);
  }
  const ids = (part: string) => (props.id ? `${props.id}-${part}` : undefined);
  const empty = () => draft().trim() === "";
  const commands = createComposerCommands(props, draft, setDraft);

  function submit() {
    const text = draft();
    if (props.form) {
      props.form.onSubmit(text.trim());
      setDraft("");
      return;
    }
    if (text.trim() === "") return;
    props.onSubmit?.(text);
    setDraft("");
  }
  const hasShelf = () =>
    Boolean(props.approval || props.running || commands.listing() || props.context?.length || props.above);
  const hasAbove = () => Boolean(props.form || hasShelf());

  const body = () => (
    <>
      {/* Form menus must escape the shelf's overflow clip. */}
      <ComposerFormFields {...props} ids={ids} hasShelf={hasShelf()} />
      <Show when={hasShelf()}>
        {/* Above the message: scrolls when the composer runs out of room
         * and the text has given up its lines. */}
        <div class="flex min-h-0 shrink flex-col gap-3 overflow-y-auto px-4 pt-3 pb-3">
          <ComposerApprovalShelf {...props} ids={ids} />
          <ComposerRunShelf {...props} ids={ids} />
          <ComposerCommandMenu ids={ids} commands={commands} />
          <ComposerContextChips {...props} ids={ids} />
          {props.above}
        </div>
      </Show>
      <Show when={hasAbove()}>
        <div class="mx-4 h-px shrink-0 bg-line" />
      </Show>
      {/* The message: gives up lines first when room runs out. */}
      <div class={`flex min-h-6 shrink-[1000] flex-col px-4 ${hasAbove() ? "pt-3" : "pt-3.5"}`}>
        <Textarea
          id={ids("input")}
          aria-label="Message"
          placeholder={props.form?.placeholder ?? props.placeholder}
          maxRows={props.maxRows}
          value={draft()}
          onValueChange={setDraft}
          onKeyDown={commands.keydown}
          onSubmit={submit}
          class="min-h-0 flex-auto"
        />
      </div>
      <ComposerFooter {...props} ids={ids} submit={submit} empty={empty()} />
    </>
  );

  return (
    <div
      id={props.id}
      class={`flex min-h-0 flex-col bg-base font-ui ${props.docked ? "pointer-events-auto rounded-t-[18px]" : "rounded-[18px]"} ${props.class ?? ""}`}
    >
      {body()}
    </div>
  );
}
