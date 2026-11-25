import { For, Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { isFailure } from "@tokamak/sdk";
import { useClient } from "@tokamak/sdk/client";
import { Tooltip, icons } from "@tokamak/ui";
import { api, type Subscription } from "../lib/api";
import { modelName, titleOf } from "../lib/format";
import { manageGlyphs, openSubscription, removing } from "../lib/manage";

/**
 * The subscription card's action row (Paper "1 · Profiles · screen"): four
 * ghost `sm` icon buttons with tooltips. Models (the tooltip lists them) and
 * Details open the details screen; Check again reads plan and models anew;
 * Remove asks first. A failed check says why on the card itself.
 *
 * Each button is 24 px and they sit 2 px apart, as drawn: smaller than the
 * 32 px target rule, an exception the owner has yet to confirm.
 */
export function CardActions(props: { subscription: Subscription }): JSX.Element {
  const client = useClient();
  const [checking, setChecking] = createSignal(false);
  const [problem, setProblem] = createSignal<string>();
  const name = () => titleOf(props.subscription);
  async function check() {
    if (checking()) return;
    setChecking(true);
    setProblem(undefined);
    try {
      const result = await client.action(api.manage.checkAgain, { id: props.subscription.id });
      if (isFailure(result)) setProblem(result.data.message);
    } catch {
      setProblem("Could not check again. Try again.");
    } finally {
      setChecking(false);
    }
  }
  const open = () => openSubscription.set(props.subscription.id);
  const models = () =>
    props.subscription.models.length
      ? props.subscription.models.map((model) => modelName(model.name)).join(" · ")
      : "No models found";
  const actions = [
    { label: () => `${name()} models`, icon: manageGlyphs.models, tip: models, run: open },
    {
      label: () => `Check ${name()} again`,
      icon: manageGlyphs.refresh,
      tip: () => "Check again",
      run: check,
    },
    { label: () => `${name()} details`, icon: manageGlyphs.details, tip: () => "Details", run: open },
    {
      label: () => `Remove ${name()}`,
      icon: manageGlyphs.remove,
      tip: () => "Remove",
      run: () => removing.set(props.subscription.id),
    },
  ];
  return (
    <div class="flex flex-col gap-1">
      <div class="flex items-center gap-hair">
        <For each={actions}>
          {(action) => {
            const busy = () => action.icon === manageGlyphs.refresh && checking();
            return (
              <Tooltip.Root>
                <Tooltip.Trigger
                  size="sm"
                  variant="ghost"
                  icon={busy() ? icons.running : action.icon}
                  label={action.label()}
                  aria-busy={busy() ? "true" : undefined}
                  onClick={() => void action.run()}
                />
                <Tooltip.Content>{action.tip()}</Tooltip.Content>
              </Tooltip.Root>
            );
          }}
        </For>
      </div>
      <Show when={problem()}>
        <p role="alert" class="m-0 text-label text-removed">
          {problem()}
        </p>
      </Show>
    </div>
  );
}
