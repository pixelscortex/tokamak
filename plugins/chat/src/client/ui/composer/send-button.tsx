import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button } from "@tokamak/ui";
import { useComposer } from "../../lib/composer";
import { glyphs } from "../../lib/icons";

/**
 * Send, or stop while a reply runs. Typing during a run turns the arrow into
 * "Queue follow-up"; stop stays beside it.
 */
export function SendButton(props: { onStop?: () => void; disabled?: boolean }): JSX.Element {
  const composer = useComposer();
  const draft = () => composer.getDraft().trim();
  return (
    <span class="flex shrink-0 items-center gap-1">
      <Show
        when={composer.busy() && props.onStop}
        fallback={
          <Button
            variant={draft() ? "primary" : "ghost"}
            icon={glyphs.arrowUp}
            label="Send"
            disabled={props.disabled || !draft()}
            onClick={() => void composer.submit()}
          />
        }
      >
        {(stop) => (
          <>
            <Show when={draft()}>
              <Button
                variant="ghost"
                icon={glyphs.arrowUp}
                label="Queue follow-up"
                disabled={props.disabled}
                onClick={() => void composer.submit()}
              />
            </Show>
            <Button variant="primary" icon={glyphs.stop} label="Stop" onClick={() => stop()()} />
          </>
        )}
      </Show>
    </span>
  );
}
