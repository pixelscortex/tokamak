import { For, Show, Switch as Choose, Match } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Icon, Switch, icons } from "@tokamak/ui";
import { productOf, type SignIn, type Subscription } from "../lib/api";
import { countOf, lastUse, planLine, titleOf } from "../lib/format";
import { glyphs } from "../lib/icons";
import { CompanyMark } from "./company-mark";

/**
 * One subscription (Paper "1 · Profiles · screen", a card): logo, plan and
 * label, the "Enabled" switch, the accounts' emails, the organisation and
 * plan, the status, the model count and the last use, then its action row
 * (`actions`, ui/card-actions.tsx). Its profile codes come with TKM-264.
 */
export function SubscriptionCard(props: {
  subscription: Subscription;
  now: number;
  onEnabled: (enabled: boolean) => void;
  onSignIn: () => Promise<unknown>;
  /** The row of icon buttons under the card's lines. */
  actions?: JSX.Element;
}): JSX.Element {
  const subscription = () => props.subscription;
  const name = () => titleOf(subscription());
  return (
    <article
      aria-label={[name(), subscription().label].filter(Boolean).join(", ")}
      class="flex flex-col gap-3 rounded-md p-4 surface-tray"
    >
      <div class="flex items-center gap-3">
        <CompanyMark company={subscription().company} size={24} />
        <div class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-row font-medium text-ink">{name()}</span>
          <Show when={subscription().label}>
            <span class="truncate text-label text-ink-3">{subscription().label}</span>
          </Show>
        </div>
        <Switch
          aria-label={`${name()} enabled`}
          checked={subscription().enabled}
          onCheckedChange={(checked: boolean) => props.onEnabled(checked)}
        />
      </div>
      <div class="flex min-w-0 flex-1 flex-col">
        <For each={subscription().accounts}>
          {(account) => (
            <Show when={account.email}>
              <span class="truncate text-data text-ink-2">{account.email}</span>
            </Show>
          )}
        </For>
        <span class="truncate text-data text-ink-3">{planLine(subscription())}</span>
      </div>
      <Choose>
        <Match when={subscription().status === "signed-out"}>
          <div class="flex h-6 items-center gap-2" title={subscription().reason}>
            <Icon path={glyphs.signedOut} size={12} class="text-warn" />
            <span class="flex-1 text-label text-warn">Signed out</span>
            <Button size="sm" variant="ghost" onClick={() => props.onSignIn()}>
              Sign in
            </Button>
          </div>
        </Match>
        <Match when={subscription().status === "ok"}>
          <div class="flex h-4 items-center gap-2">
            <Icon path={icons.done} size={12} class="text-ink-3" />
            <span class="text-label text-ink-2">OK</span>
          </div>
        </Match>
      </Choose>
      <span class="truncate text-data text-ink-3">
        {countOf(subscription().models.length, "model")} · {lastUse(subscription().lastUsedAt, props.now)}
      </span>
      {props.actions}
    </article>
  );
}

/**
 * A sign-in still waiting for the person (Paper's pending card): it stays
 * when the dialog is closed. "Continue" opens the dialog at its sign-in step
 * again; "Cancel" stops waiting, and nothing is left behind. After 15 minutes
 * it says it expired and offers to start again.
 */
export function AwaitingCard(props: {
  signIn: SignIn;
  onContinue: () => void;
  onCancel: () => Promise<unknown>;
  onRestart: () => Promise<unknown>;
}): JSX.Element {
  const product = () => productOf[props.signIn.company];
  return (
    <article
      aria-label={`${product()}, ${props.signIn.expired ? "sign-in expired" : "awaiting sign-in"}`}
      class="flex items-start gap-3 rounded-md p-4 inset-ring inset-ring-edge"
    >
      <span class="flex size-8 shrink-0 items-center justify-center rounded-sm bg-card">
        <CompanyMark company={props.signIn.company} size={18} />
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <div class="flex flex-col">
          <span class="text-row font-medium text-ink">{product()}</span>
          <Show
            when={!props.signIn.expired}
            fallback={<span class="text-data text-ink-3">Sign-in expired after 15 minutes</span>}
          >
            <span class="flex items-center gap-2 text-data text-ink-3">
              <Icon path={icons.running} size={12} />
              {props.signIn.addTo
                ? "Awaiting another account"
                : props.signIn.repair
                  ? "Awaiting sign-in again"
                  : "Awaiting sign-in"}
            </span>
          </Show>
        </div>
        {/* Each Button stays pending until its promise settles, so a second press does nothing. */}
        <div class="flex gap-1">
          <Show
            when={!props.signIn.expired}
            fallback={
              <Button size="sm" variant="ghost" onClick={() => props.onRestart()}>
                Start again
              </Button>
            }
          >
            <Button size="sm" variant="ghost" onClick={() => props.onContinue()}>
              Continue
            </Button>
          </Show>
          <Button size="sm" variant="ghost" onClick={() => props.onCancel()}>
            {props.signIn.expired ? "Dismiss" : "Cancel"}
          </Button>
        </div>
      </div>
    </article>
  );
}
