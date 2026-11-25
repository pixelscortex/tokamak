import { For, Show, createSignal, onCleanup } from "solid-js";
import { isFailure } from "@tokamak/sdk";
import { useClient, useQuery, view } from "@tokamak/sdk/client";
import { Button, icons } from "@tokamak/ui";
import { api, type SignIn } from "../lib/api";
import { profilesIcon } from "../lib/icons";
import { AddDialog, type Step } from "../ui/add-dialog";
import { loadMarks } from "../ui/company-mark";
import { AwaitingCard, SubscriptionCard } from "../ui/subscription-card";

/**
 * How often the open screen asks the server to renew logins that run out
 * soon. Server code has no timer that may use the network, so renewal runs on
 * demand: here, and (TKM-263) before the proxy uses a login.
 */
const RENEW_EVERY_MS = 60_000;

/**
 * The Profiles screen (Paper "1 · Profiles · screen"). This ticket draws its
 * Subscriptions section; the Profiles section under it comes with TKM-264.
 */
export const Profiles = view({ route: "/", title: "Profiles", icon: profilesIcon }, () => {
  const client = useClient();
  const listed = useQuery(client, api.subscriptions.list, () => ({}));
  const [step, setStep] = createSignal<Step>();
  const [now, setNow] = createSignal(Date.now());
  const [problem, setProblem] = createSignal<string>();
  loadMarks(client);

  const renew = () => void client.action(api.subscriptions.renew, {}).catch(() => {});
  renew();
  const timer = setInterval(() => {
    setNow(Date.now());
    renew();
  }, RENEW_EVERY_MS);
  onCleanup(() => clearInterval(timer));

  const start = (repair?: string) =>
    client.action(api.subscriptions.startSignIn, {
      company: "anthropic",
      method: "subscription",
      ...(repair !== undefined && { repair }),
    });
  async function signInAgain(subscription: string) {
    setProblem(undefined);
    const started = await start(subscription);
    if (isFailure(started)) setProblem(started.data.message);
    else setStep({ kind: "sign-in", signIn: started });
  }
  const subscriptions = () => listed.data()?.subscriptions ?? [];
  const signIns = () => listed.data()?.signIns ?? [];

  return (
    <div class="flex flex-col px-8 pb-12">
      <section aria-label="Subscriptions" class="mx-auto flex w-full max-w-profiles flex-col gap-3 pt-6">
        <header class="flex h-8 items-center justify-between">
          <h2 class="m-0 flex items-center gap-2">
            <span class="text-row font-medium text-ink">Subscriptions</span>
            <span class="text-data text-ink-3">{subscriptions().length}</span>
          </h2>
          <Button variant="ghost" icon={icons.add} onClick={() => setStep({ kind: "company" })}>
            Add subscription
          </Button>
        </header>
        <Show when={problem() ?? listed.error()?.message}>
          {(message) => (
            <p role="alert" class="m-0 text-label text-removed">
              {message()}
            </p>
          )}
        </Show>
        <div class="grid grid-cols-4 gap-3">
          <For each={subscriptions()}>
            {(subscription) => (
              <SubscriptionCard
                subscription={subscription}
                now={now()}
                onEnabled={(enabled) =>
                  void client.mutation(api.subscriptions.setEnabled, { id: subscription.id, enabled })
                }
                onSignIn={() => signInAgain(subscription.id)}
              />
            )}
          </For>
          <For each={signIns()}>
            {(signIn: SignIn) => (
              <AwaitingCard
                signIn={signIn}
                onContinue={() => setStep({ kind: "sign-in", signIn })}
                onCancel={async () => {
                  await client.mutation(api.subscriptions.cancelSignIn, { id: signIn.id });
                  const open = step();
                  if (open?.kind === "sign-in" && open.signIn.id === signIn.id) setStep(undefined);
                }}
              />
            )}
          </For>
        </div>
        <Show when={listed.data() && !subscriptions().length && !signIns().length}>
          <p class="m-0 text-row text-ink-3">
            No subscriptions yet. Add one to sign in to Claude once for every thread.
          </p>
        </Show>
      </section>
      <AddDialog
        step={step()}
        onStep={setStep}
        start={start}
        finish={(signIn, pasted) => client.action(api.subscriptions.finishSignIn, { id: signIn.id, pasted })}
        setLabel={(subscription, label) =>
          client.mutation(api.subscriptions.setLabel, { id: subscription.id, label })
        }
      />
    </div>
  );
});
