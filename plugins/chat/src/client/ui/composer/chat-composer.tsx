import { Slot } from "@tokamak/sdk/client";
import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, icons } from "@tokamak/ui";
import { composerActions, composerAfter, composerBefore, useComposer } from "../../lib/composer";
import { ComposerInput } from "./composer-input";
import { SendButton } from "./send-button";

/**
 * One panel in three layers: an optional needs-you band, the card with the
 * prompt and its actions, and the strip with the agent below.
 */
export function Composer(props: {
  band?: JSX.Element;
  strip: JSX.Element;
  placeholder: string;
  disabled: boolean;
  queued: string;
  onUnqueue: () => void;
  onEdit: (text: string) => void;
  onStop: () => void;
}): JSX.Element {
  const composer = useComposer();
  return (
    <div class="flex flex-col gap-2">
      <div class="nest-lg/1 flex flex-col gap-1 surface-tray">
        {props.band}
        <div class="flex min-h-0 flex-col gap-2 rounded-inner surface-card py-3 ps-4 pe-3">
          <Slot of={composerBefore} props={{ composer }} />
          <Show when={props.queued}>
            <div class="flex items-center gap-2 text-row text-ink-2">
              <span class="shrink-0 text-label text-ink-3">Queued</span>
              <span class="min-w-0 flex-1 truncate">{props.queued}</span>
              <Button
                variant="ghost"
                icon={icons.close}
                label="Edit queued message"
                onClick={() => props.onUnqueue()}
              />
            </div>
          </Show>
          <ComposerInput
            aria-label="Message"
            placeholder={props.placeholder}
            disabled={props.disabled}
            value={composer.getDraft()}
            onValueChange={(text: string) => props.onEdit(text)}
            onSubmit={() => void composer.submit()}
          />
          <div class="-ms-2 flex h-8 items-center gap-1">
            <Slot of={composerActions} props={{ composer }} />
            <span class="flex-1" />
            <SendButton onStop={props.onStop} />
          </div>
        </div>
        {props.strip}
      </div>
      <Slot of={composerAfter} props={{ composer }} />
    </div>
  );
}
