import { Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Avatar, Button, Icon } from "@tokamak/ui";
import type { ServerAddress } from "../../host/invite";
import type { Access, Reach } from "../../host/reach";
import { Field } from "../field";
import { shellIcons } from "../icons";
import { Actions, Check, Checks, Head, Note, Problem, Progress, Recent, ServerCard } from "./parts";

export type Step =
  | { name: "address" }
  | { name: "connecting"; address: ServerAddress; token?: string; answer?: Reach & { ok: true } }
  | { name: "unreachable"; address: ServerAddress; token?: string; answer: Reach & { ok: false } }
  | { name: "verify"; address: ServerAddress; token?: string; answer: Reach; access?: Access }
  | { name: "customize"; address: ServerAddress; token: string };

export type StepOf<Name extends Step["name"]> = Extract<Step, { name: Name }>;

export function AddressStep(props: {
  address: string;
  inviteToken?: string;
  error?: string;
  onInput: (value: string) => void;
  onSubmit: (event: SubmitEvent) => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <form class="flex flex-col gap-8" onSubmit={(event) => props.onSubmit(event)}>
      <Progress step={1} />
      <Head title="Join a server">
        Paste the address you got from the server's owner. If they sent a whole invite, paste all of it.
      </Head>
      <div class="flex flex-col gap-2">
        <Field
          label="Server address"
          icon={shellIcons.cloud}
          value={props.address}
          onInput={props.onInput}
          mono
          autofocus
          placeholder="tokamak.example.app"
          invalid={!!props.error}
          describedBy="connect-address-note"
          trail={
            <Show when={props.inviteToken}>
              <span
                role="img"
                aria-label="Invite token included"
                class="flex h-8 shrink-0 items-center gap-1 rounded-sm bg-edge/50 px-2 text-label text-ink-2"
              >
                <Icon path={shellIcons.key} size={12} />
                Invite
              </span>
            </Show>
          }
        />
        <div id="connect-address-note">
          <Switch>
            <Match when={props.error}>{(reason) => <Note failed>{reason()}</Note>}</Match>
            <Match when={props.inviteToken}>
              <Note>Your invite came with it, so you won't need to type it</Note>
            </Match>
          </Switch>
        </div>
      </div>
      <Actions back="Cancel" onBack={props.onCancel} action="Connect" />
      <Recent />
    </form>
  );
}

/** Only what is true today: something answered, and over TLS when the address is https. */
export function ConnectingStep(props: {
  step: StepOf<"connecting">;
  onBack: () => void;
  onContinue: () => void;
}): JSX.Element {
  return (
    <div class="flex flex-col gap-8">
      <Progress step={2} />
      <Head title="Reaching the server" address={props.step.address.host} />
      <Checks>
        <Show
          when={props.step.answer}
          fallback={<Check state="running" label={`Looking for ${props.step.address.host}`} />}
        >
          {(answer) => (
            <>
              <Check state="done" label="Found the server" ms={answer().ms} />
              <Show when={props.step.address.secure}>
                <Check state="done" label="Made a secure connection" />
              </Show>
            </>
          )}
        </Show>
      </Checks>
      <Actions
        back="Back"
        onBack={props.onBack}
        action="Continue"
        pending={!props.step.answer}
        autofocus={!!props.step.answer}
        onAction={props.onContinue}
      />
    </div>
  );
}

export function UnreachableStep(props: {
  step: StepOf<"unreachable">;
  onBack: () => void;
  onRetry: () => void;
}): JSX.Element {
  const foreign = () => props.step.answer.kind === "not-tokamak";
  return (
    <div class="flex flex-col gap-8">
      <Progress step={2} />
      <Head title="Couldn't reach the server" address={props.step.address.host} />
      <Checks>
        <Check
          state="failed"
          label={foreign() ? "Not a Tokamak server" : "No answer from the server"}
          ms={props.step.answer.ms}
        />
      </Checks>
      <p class="text-read text-pretty text-ink-2">
        {foreign()
          ? "Something answered at this address, but it isn't a Tokamak server. Check the address with whoever sent it."
          : "Nothing answered at this address. The server may be asleep or starting up, which usually takes under a minute. If it keeps failing, check the address with whoever sent it."}
      </p>
      <Actions back="Change address" onBack={props.onBack} action="Try again" onAction={props.onRetry} />
    </div>
  );
}

export function VerifyStep(props: {
  step: StepOf<"verify">;
  name: string;
  token: string;
  onToken: (value: string) => void;
  checking: boolean;
  onSubmit: (event: SubmitEvent) => void;
  onBack: () => void;
}): JSX.Element {
  const asking = () => !props.step.token || !!props.step.access;
  return (
    <form class="flex flex-col gap-8" onSubmit={(event) => props.onSubmit(event)}>
      <Progress step={3} />
      <Head title="Is this the right place?">
        {asking()
          ? "The server answered. Check it's the one you were invited to, then add your invite."
          : "The server answered. Check it's the one you were invited to."}
      </Head>
      <ServerCard name={props.name} address={props.step.address.host} />
      <Show when={asking()}>
        <div class="flex flex-col gap-2">
          <Field
            id="connect-token"
            label="Invite token"
            visibleLabel
            icon={shellIcons.key}
            value={props.token}
            onInput={props.onToken}
            mono
            autofocus
            invalid={!!props.step.access}
            describedBy="connect-token-note"
          />
          <div id="connect-token-note">
            <Switch
              fallback={<p class="text-label text-ink-3">Ask whoever invited you if you don't have one.</p>}
            >
              <Match when={props.step.access === "rejected"}>
                <Problem title="This invite wasn't accepted">
                  It may be mistyped, or the server's owner changed it. Ask them for a new invite, then paste
                  it here.
                </Problem>
              </Match>
              <Match when={props.step.access === "unknown"}>
                <Problem title="The server didn't let this app in">
                  Either the invite is wrong or the server doesn't accept connections from this app. Check
                  both with whoever sent the invite.
                </Problem>
              </Match>
            </Switch>
          </div>
        </div>
      </Show>
      <Actions back="Back" onBack={props.onBack} action="Join" busy={props.checking} />
    </form>
  );
}

export function CustomizeStep(props: {
  server: string;
  name: string;
  onName: (value: string) => void;
  usedBefore: boolean;
  onSubmit: (event: SubmitEvent) => void;
}): JSX.Element {
  const shown = () => props.name.trim();
  return (
    <form class="flex flex-col gap-8" onSubmit={(event) => props.onSubmit(event)}>
      <Progress step={4} />
      <Head title="You're in. How should people see you?">
        People on {props.server} will see this name next to what you write.
      </Head>
      <div class="flex flex-col gap-2">
        <Field
          id="connect-name"
          label="Your name"
          visibleLabel
          lead={<Avatar name={shown() || "?"} />}
          value={props.name}
          onInput={props.onName}
          autofocus
          autocomplete="name"
        />
        <Show when={props.usedBefore}>
          <p class="text-label text-ink-3">The name you used before</p>
        </Show>
      </div>
      <div class="flex flex-col gap-2">
        <p class="text-label text-ink-3">How it looks in a thread</p>
        <div
          role="group"
          aria-label="Message preview"
          class="flex flex-col gap-2 rounded-md surface-tray p-4"
        >
          <div class="flex items-center gap-2">
            <Avatar name={shown() || "?"} size={16} />
            <span class="text-label text-ink-3">{shown() || "Your name"}</span>
            <span class="text-data text-ink-3">now</span>
          </div>
          <p class="text-read text-ink">Hi all, I'm in.</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <p class="text-label text-ink-3">Kept on this device for now</p>
        <div class="flex-1" />
        <Button variant="brand" type="submit" aria-disabled={shown() ? undefined : "true"}>
          Open {props.server}
        </Button>
      </div>
    </form>
  );
}
