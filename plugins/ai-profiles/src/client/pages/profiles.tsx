import { For, Show, createSignal, onCleanup } from "solid-js";
import { isFailure } from "@tokamak/sdk";
import { useClient, useQuery, view } from "@tokamak/sdk/client";
import { Button, icons } from "@tokamak/ui";
import { api, type SignIn } from "../lib/api";
import { profilesIcon } from "../lib/icons";
import { AddDialog, type Step } from "../ui/add-dialog";
import { loadMarks } from "../ui/company-mark";
import { AwaitingCard, SubscriptionCard } from "../ui/subscription-card";
import { openSubscription } from "../lib/manage";
import { ENDING, createSignInWatch } from "../lib/sign-in-watch";
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

type Target = Pick<SignIn, "repair" | "addTo" | "repairAccount">;

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

  /** A sign-in of the same kind as `like`: a new subscription, a repair, one account, or another account. */
  const start = (like?: Target) =>
    like?.addTo !== undefined
      ? client.action(api.manage.addAccount, { id: like.addTo })
      : like?.repairAccount !== undefined
        ? client.action(api.manage.signInAccount, { id: like.repairAccount })
        : client.action(api.subscriptions.startSignIn, {
            company: "anthropic",
            method: "subscription",
            ...(like?.repair !== undefined && { repair: like.repair }),
          });
  /** "Sign in" on a signed-out card, and "Start again" on an expired one. */
  async function startAndOpen(like?: Target) {
    setProblem(undefined);
    try {
      const started = await start(like);
      if (isFailure(started)) setProblem(started.data.message);
      else setStep({ kind: "sign-in", signIn: started });
    } catch {
      setProblem("The sign-in could not start. Try again.");
    }
  }

  const { local } = createSignInWatch({
    data: () => listed.data(),
    step,
    setStep,
    onCancelled: setProblem,
  });

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
      <SubscriptionDetails data={listed.data()} />
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
                onSignIn={() => startAndOpen({ repair: subscription.id })}
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
                onRestart={() => startAndOpen(signIn)}
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
        start={() => {
          // "Start again" restarts the same kind of sign-in; the method step starts a new one.
          const open = step();
          return start(open?.kind === "sign-in" ? open.signIn : undefined);
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
