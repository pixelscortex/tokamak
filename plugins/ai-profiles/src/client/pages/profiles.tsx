import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { isFailure } from "@tokamak/sdk";
import { useClient, useQuery, view } from "@tokamak/sdk/client";
import { Button, icons } from "@tokamak/ui";
import { api, type SignIn, type Subscription } from "../lib/api";
import { profilesIcon } from "../lib/icons";
import { AddDialog, type Step } from "../ui/add-dialog";
import { loadMarks } from "../ui/company-mark";
import { AwaitingCard, SubscriptionCard } from "../ui/subscription-card";
import { openSubscription } from "../lib/manage";
import { CardActions } from "../ui/card-actions";
import { RemoveDialog } from "../ui/remove-dialog";
import { SubscriptionDetails } from "./subscription";

/**
 * How often the open screen asks the server to renew logins that run out
 * soon. Server code has no timer that may use the network, so renewal runs on
 * demand: here, and (TKM-263) before the proxy uses a login. The server keeps
 * its own wait after a failed renewal, so asking this often costs nothing.
 */
export const RENEW_EVERY_MS = 60_000;

/** Failures after which a sign-in no longer exists on the server. */
const ENDING = ["AlreadyAdded", "Gone", "Expired", "Cancelled", "NotFound"];

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

  const start = (repair?: string, addTo?: string) =>
    addTo !== undefined
      ? client.action(api.manage.addAccount, { id: addTo })
      : client.action(api.subscriptions.startSignIn, {
          company: "anthropic",
          method: "subscription",
          ...(repair !== undefined && { repair }),
        });
  /** "Sign in" on a signed-out card, and "Start again" on an expired one. */
  async function startAndOpen(repair?: string, addTo?: string) {
    setProblem(undefined);
    try {
      const started = await start(repair, addTo);
      if (isFailure(started)) setProblem(started.data.message);
      else setStep({ kind: "sign-in", signIn: started });
    } catch {
      setProblem("The sign-in could not start. Try again.");
    }
  }

  /**
   * Sign-ins this window is finishing or cancelling, and ones it ended: the
   * watch below leaves those to the call that answers for them.
   */
  const busy = new Set<string>();
  const endedHere = new Set<string>();
  async function local<T>(id: string, call: () => Promise<T>, ended: (result: T) => boolean): Promise<T> {
    busy.add(id);
    try {
      const result = await call();
      if (ended(result)) endedHere.add(id);
      return result;
    } finally {
      busy.delete(id);
    }
  }

  // An open dialog notices its sign-in ending in another window: finished
  // there (go on to "Connected") or cancelled there (close and say so).
  const seen = new Set<string>();
  createEffect(
    () => listed.data(),
    (data) => {
      if (!data) return;
      for (const signIn of data.signIns) seen.add(signIn.id);
      const open = step();
      if (open?.kind !== "sign-in") return;
      const id = open.signIn.id;
      if (!seen.has(id) || busy.has(id) || endedHere.has(id)) return;
      const still = data.signIns.find((signIn) => signIn.id === id);
      if (still) {
        if (still.expired !== open.signIn.expired) setStep({ kind: "sign-in", signIn: still });
        return;
      }
      const target = open.signIn.repair ?? open.signIn.addTo;
      const added: Subscription | undefined = target
        ? data.subscriptions.find((item) => item.id === target && item.status === "ok")
        : data.subscriptions.find((item) => item.createdAt >= open.signIn.startedAt);
      if (added) setStep({ kind: "connected", subscription: added });
      else {
        setStep(undefined);
        setProblem("That sign-in was cancelled in another window.");
      }
    },
  );

  const subscriptions = () => listed.data()?.subscriptions ?? [];
  const signIns = () => listed.data()?.signIns ?? [];
  async function cancel(signIn: SignIn) {
    await local(
      signIn.id,
      () => client.mutation(api.subscriptions.cancelSignIn, { id: signIn.id }),
      () => true,
    );
    const open = step();
    if (open?.kind === "sign-in" && open.signIn.id === signIn.id) setStep(undefined);
  }

  return (
    <div class="flex flex-col px-8 pb-12">
      <SubscriptionDetails subscriptions={listed.data()?.subscriptions} />
      <section
        aria-label="Subscriptions"
        hidden={openSubscription() !== undefined}
        class="mx-auto flex w-full max-w-profiles flex-col gap-3 pt-6"
      >
        <header class="flex h-8 items-center justify-between">
          <h2 class="m-0 flex items-center gap-2">
            <span class="text-row font-medium text-ink">Subscriptions</span>
            <span class="text-data text-ink-3">{subscriptions().length}</span>
          </h2>
          <Button
            variant="ghost"
            icon={icons.add}
            onClick={() => {
              setProblem(undefined);
              setStep({ kind: "company" });
            }}
          >
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
                onSignIn={() => startAndOpen(subscription.id)}
                actions={<CardActions subscription={subscription} />}
              />
            )}
          </For>
          <For each={signIns()}>
            {(signIn: SignIn) => (
              <AwaitingCard
                signIn={signIn}
                onContinue={() => {
                  setProblem(undefined);
                  setStep({ kind: "sign-in", signIn });
                }}
                onCancel={() => cancel(signIn)}
                onRestart={() => startAndOpen(signIn.repair, signIn.addTo)}
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
      <RemoveDialog subscriptions={subscriptions()} />
      <AddDialog
        step={step()}
        onStep={setStep}
        start={(repair) => {
          const open = step();
          return start(repair, open?.kind === "sign-in" ? open.signIn.addTo : undefined);
        }}
        finish={(signIn, pasted) =>
          local(
            signIn.id,
            () => client.action(api.subscriptions.finishSignIn, { id: signIn.id, pasted }),
            (result) => !isFailure(result) || ENDING.includes(result.kind),
          )
        }
        setLabel={(subscription, label) =>
          client.mutation(api.subscriptions.setLabel, { id: subscription.id, label })
        }
      />
    </div>
  );
});
