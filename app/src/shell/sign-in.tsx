import { Button, Dialog } from "@tokamak/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, For, onCleanup, Show } from "solid-js";
import {
  createOwnerAccount,
  discoverSignIn,
  exchangeOwnerKey,
  submitSignIn,
  type SignInMethod,
} from "../host/sign-in";
import { type SignInTarget, useShell } from "./context";
import { CredentialField, ProviderFields, passwordError } from "./credential-fields";

export function SignInDialog(): JSX.Element {
  const shell = useShell();
  return (
    <Show when={shell.signIn()} keyed>
      {(target) => <SignInForm target={target} close={shell.closeSignIn} signedIn={shell.finishSignIn} />}
    </Show>
  );
}

function SignInForm(props: {
  target: SignInTarget;
  close(): void;
  signedIn(key: string): void;
}): JSX.Element {
  const { origin, onInvite } = props.target;
  const [options, setOptions] = createSignal(props.target.options, { ownedWrite: true });
  const [loading, setLoading] = createSignal(!props.target.options, { ownedWrite: true });
  const [selected, select] = createSignal("", { ownedWrite: true });
  const [step, setStep] = createSignal<"signIn" | "ownerKey" | "ownerSetup" | "password">("signIn", {
    ownedWrite: true,
  });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [busy, setBusy] = createSignal(false, { ownedWrite: true });
  const controller = new AbortController();
  const { signal } = controller;
  const [setupMethods, setSetupMethods] = createSignal<SignInMethod[]>([], { ownedWrite: true });
  let deviceKey = "";
  let pending: { method: string; fields: Record<string, string> } | undefined;
  onCleanup(() => {
    deviceKey = "";
    pending = undefined;
    controller.abort();
  });
  if (!props.target.options) {
    void discoverSignIn(origin, signal).then((options) => {
      if (signal.aborted) return;
      setOptions(options);
      setLoading(false);
    });
  }
  const methods = () => (step() === "ownerSetup" ? setupMethods() : (options()?.methods ?? []));
  const method = () => methods().find(({ id }) => id === selected()) ?? methods()[0];
  const change = (next: ReturnType<typeof step>) => {
    if (next === "signIn") {
      deviceKey = "";
      pending = undefined;
    }
    select("");
    setError("");
    setStep(next);
  };
  const ready = () => step() === "ownerKey" || step() === "password" || !!method();
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy() || !ready()) return;
    const fields = Object.fromEntries(new FormData(event.currentTarget as HTMLFormElement)) as Record<
      string,
      string
    >;
    setError("");
    setBusy(true);
    try {
      if (step() === "ownerKey") {
        const result = await exchangeOwnerKey(origin, fields.ownerKey!.trim(), signal, options()?.ownerSetup);
        if (signal.aborted) return;
        if ("failed" in result) setError("This server didn’t accept the owner key.");
        else if (result.setupMethods.length > 0) {
          deviceKey = result.key;
          setSetupMethods(result.setupMethods);
          change("ownerSetup");
        } else props.signedIn(result.key);
        return;
      }
      if (step() === "ownerSetup") {
        const failure = await createOwnerAccount(origin, deviceKey, method()!.id, fields, signal);
        if (signal.aborted) return;
        if (failure) setError(failureMessage(failure.kind));
        else props.signedIn(deviceKey);
        return;
      }
      if (step() === "password") {
        if (!pending) return;
        if (fields.newPassword !== fields.confirmPassword) {
          setError("The passwords don’t match.");
          return;
        }
        const result = await submitSignIn(origin, pending.method, pending.fields, signal, fields.newPassword);
        if (signal.aborted) return;
        if ("failed" in result) {
          if (
            result.kind === "WrongPassword" ||
            result.kind === "PasswordChanged" ||
            result.kind === "PasswordChangeNotRequired" ||
            result.kind === "AccountNotLinked"
          ) {
            change("signIn");
            setError("That temporary password can’t be used. Sign in again.");
          } else setError(failureMessage(result.kind));
        } else props.signedIn(result.key);
        return;
      }
      const methodId = method()!.id;
      const result = await submitSignIn(origin, methodId, fields, signal);
      if (signal.aborted) return;
      if ("failed" in result) {
        if (result.kind === "PasswordChangeRequired") {
          pending = { method: methodId, fields };
          change("password");
        } else setError(failureMessage(result.kind));
      } else props.signedIn(result.key);
    } catch {
      if (!signal.aborted) setError("Couldn’t sign in. Try again.");
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  };
  return (
    <Dialog.Root open onOpenChange={(open) => !open && props.close()}>
      <Dialog.Content>
        <Dialog.Title>
          {step() === "ownerSetup"
            ? "Set up owner account"
            : step() === "password"
              ? "Choose a new password"
              : "Sign in to server"}
        </Dialog.Title>
        <Dialog.Description>
          <span class="break-all font-mono">{new URL(origin).host}</span>
          <Show when={step() === "ownerSetup"}>
            <span class="mt-2 block">Choose the credentials you’ll use next time.</span>
          </Show>
          <Show when={step() === "password"}>
            <span class="mt-2 block">Replace your temporary password to sign in.</span>
          </Show>
        </Dialog.Description>
        <form class="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <Show when={step() === "ownerKey"}>
            <Show when={!methods().some((method) => method.setupOwnerForm)}>
              <p class="text-row text-ink-2">The owner uses the owner key to sign in to this server.</p>
            </Show>
            <CredentialField name="ownerKey" label="Owner key" type="password" autofocus />
          </Show>
          <Show when={step() === "password"}>
            <CredentialField
              name="newPassword"
              label="New password"
              type="password"
              autocomplete="new-password"
              autofocus
            />
            <CredentialField
              name="confirmPassword"
              label="Confirm new password"
              type="password"
              autocomplete="new-password"
            />
          </Show>
          <Show when={step() === "signIn" || step() === "ownerSetup"}>
            <Show when={methods().length > 1}>
              <label class="flex flex-col gap-2 text-label text-ink-3">
                Sign-in method
                <select
                  class="h-12 rounded-md bg-edge/50 px-4 text-row text-ink"
                  value={method()?.id}
                  onChange={(event) => {
                    select(event.currentTarget.value);
                    setError("");
                  }}
                >
                  <For each={methods()}>{(option) => <option value={option.id}>{option.name}</option>}</For>
                </select>
              </label>
            </Show>
            <Show
              when={step() === "ownerSetup" ? method()?.setupOwnerForm : method()?.form}
              keyed
              fallback={
                <p class="text-row text-ink-2" role="status">
                  {loading() ? "Finding sign-in methods…" : "No sign-in methods are available."}
                </p>
              }
            >
              {(form) => (
                <ProviderFields
                  form={form}
                  password={step() === "ownerSetup" ? "new" : "current"}
                  autofocus={methods().length === 1}
                />
              )}
            </Show>
          </Show>
          <Show when={error()}>
            <p role="alert" class="text-row text-removed">
              {error()}
            </p>
          </Show>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <Show when={step() !== "signIn"} fallback={<Dialog.Close variant="ghost">Cancel</Dialog.Close>}>
              <Button type="button" variant="ghost" disabled={busy()} onClick={() => change("signIn")}>
                Back
              </Button>
            </Show>
            <Show when={step() === "ownerSetup"}>
              <Button
                type="button"
                variant="ghost"
                disabled={busy()}
                onClick={() => props.signedIn(deviceKey)}
              >
                Continue without setup
              </Button>
            </Show>
            <Show when={ready()}>
              <Button type="submit" disabled={busy()}>
                {step() === "ownerSetup"
                  ? "Create account"
                  : step() === "ownerKey"
                    ? "Continue"
                    : step() === "password"
                      ? "Set password"
                      : "Sign in"}
              </Button>
            </Show>
          </div>
        </form>
        <Show when={step() === "signIn" && !loading()}>
          <div class="mt-2 flex flex-wrap gap-2">
            <Button variant="ghost" disabled={busy()} onClick={() => change("ownerKey")}>
              {options()?.ownerSetup ? "Set up owner account" : "Use owner key"}
            </Button>
            <Show when={onInvite}>
              {(invite) => (
                <Button
                  variant="ghost"
                  disabled={busy()}
                  onClick={() => {
                    props.close();
                    invite()();
                  }}
                >
                  Use an invite
                </Button>
              )}
            </Show>
          </div>
        </Show>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function failureMessage(kind: string): string {
  switch (kind) {
    case "WrongPassword":
    case "AccountNotLinked":
      return "The username, email, or password is incorrect.";
    case "SignInThrottled":
      return "Too many unsuccessful attempts. Wait a moment and try again.";
    case "OwnerSetupExpired":
      return "This setup window expired. Go back and enter the owner key again.";
    case "SignInBusy":
      return "The server is busy signing people in. Try again.";
    case "OwnerAlreadySetUp":
      return "The owner account is already set up. Go back to sign in.";
    default:
      return passwordError(kind) ?? "Couldn’t sign in. Try again.";
  }
}
