import { For, Match, Show, Switch as Choose, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Chip, Collapsible, Dialog, Icon, Input, Row, icons } from "@tokamak/ui";
import type { SignIn, Subscription } from "../lib/api";
import { countOf, modelName, titleOf } from "../lib/format";
import { glyphs, profilesIcon } from "../lib/icons";
import { CompanyMark, markPath } from "./company-mark";

/**
 * Adding a subscription (Paper "2a" to "2d"): company, then method, then
 * sign-in, then connected. Closing the dialog at any step stops nothing: a
 * sign-in keeps waiting, and the screen shows it as an "Awaiting sign-in" card
 * that opens this dialog at its sign-in step again.
 */
export type Step =
  | { kind: "company" }
  | { kind: "method"; company: "anthropic" }
  | { kind: "sign-in"; signIn: SignIn }
  | { kind: "connected"; subscription: Subscription };

type Failed = { failed: true; kind: string; data: { message: string } };
const failed = (value: unknown): value is Failed =>
  typeof value === "object" && value !== null && (value as { failed?: unknown }).failed === true;

export interface AddDialogProps {
  step: Step | undefined;
  onStep: (step: Step | undefined) => void;
  /** Starts a sign-in; `repair` signs that subscription in again instead of adding one. */
  start: (repair?: string) => Promise<SignIn | Failed>;
  finish: (signIn: SignIn, pasted: string) => Promise<Subscription | Failed>;
  setLabel: (subscription: Subscription, label: string) => Promise<null | Failed>;
  /** Copies text to the clipboard; the window's own clipboard by default. */
  copy?: (text: string) => Promise<void>;
}

const STEPS = { company: 1, method: 2, "sign-in": 3, connected: 4 } as const;

export function AddDialog(props: AddDialogProps): JSX.Element {
  return (
    <Dialog.Root
      open={props.step !== undefined}
      onOpenChange={(open: boolean) => !open && props.onStep(undefined)}
    >
      <Dialog.Backdrop />
      <Dialog.Content>
        <Show when={props.step}>
          {(step) => (
            <div class="flex flex-col gap-5">
              <Choose>
                <Match when={step().kind === "company"}>
                  <CompanyStep onPick={() => props.onStep({ kind: "method", company: "anthropic" })} />
                </Match>
                <Match when={step().kind === "method"}>
                  <MethodStep
                    start={async () => {
                      const started = await props.start();
                      if (!failed(started)) props.onStep({ kind: "sign-in", signIn: started });
                      return started;
                    }}
                    onBack={() => props.onStep({ kind: "company" })}
                  />
                </Match>
                <Match
                  when={step().kind === "sign-in" && (step() as Extract<Step, { kind: "sign-in" }>).signIn}
                >
                  {(signIn) => (
                    <SignInStep
                      signIn={signIn()}
                      copy={props.copy}
                      finish={async (pasted) => {
                        const added = await props.finish(signIn(), pasted);
                        if (!failed(added)) props.onStep({ kind: "connected", subscription: added });
                        return added;
                      }}
                      restart={async () => {
                        const started = await props.start(signIn().repair);
                        if (!failed(started)) props.onStep({ kind: "sign-in", signIn: started });
                        return started;
                      }}
                    />
                  )}
                </Match>
                <Match
                  when={
                    step().kind === "connected" &&
                    (step() as Extract<Step, { kind: "connected" }>).subscription
                  }
                >
                  {(subscription) => (
                    <ConnectedStep
                      subscription={subscription()}
                      done={async (label) => {
                        const saved = await props.setLabel(subscription(), label);
                        if (!failed(saved)) props.onStep(undefined);
                        return saved;
                      }}
                    />
                  )}
                </Match>
              </Choose>
            </div>
          )}
        </Show>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** The dialog's top line: how far along it is, the company's mark, the title, close. */
function Header(props: { step: keyof typeof STEPS; mark?: boolean; children: JSX.Element }): JSX.Element {
  return (
    <div class="flex items-center gap-3">
      <div class="flex gap-1" role="img" aria-label={`Step ${STEPS[props.step]} of 4`}>
        <For each={[1, 2, 3, 4]}>
          {(n) => <span class={["h-1 w-6 rounded-full", n <= STEPS[props.step] ? "bg-ink" : "bg-edge"]} />}
        </For>
      </div>
      <Show when={props.mark}>
        <CompanyMark company="anthropic" size={18} />
      </Show>
      <Dialog.Title class="flex-1">{props.children}</Dialog.Title>
      <Dialog.Close variant="ghost" icon={icons.close} label="Close" />
    </div>
  );
}

function Problem(props: { message: string | undefined }): JSX.Element {
  return (
    <Show when={props.message}>
      <p role="alert" class="m-0 text-label text-removed">
        {props.message}
      </p>
    </Show>
  );
}

function CompanyStep(props: { onPick: () => void }): JSX.Element {
  return (
    <>
      <Header step="company">Add subscription</Header>
      <div class="flex flex-col density-normal">
        <Row
          as="button"
          lead={<CompanyMark company="anthropic" size={16} />}
          trail={<Icon path={glyphs.next} size={14} />}
          onClick={() => props.onPick()}
        >
          Anthropic
        </Row>
        {/* Listed, not yet offered: ChatGPT subscriptions come next (TKM-262). */}
        <div class="opacity-50">
          <Row lead={<CompanyMark company="openai" size={16} />} trail="Later">
            OpenAI
          </Row>
        </div>
        <div role="separator" class="mx-1 my-1 h-px bg-edge" />
        <div class="opacity-50">
          <Row lead={<span />}>More later</Row>
        </div>
      </div>
    </>
  );
}

function MethodStep(props: { start: () => Promise<unknown>; onBack: () => void }): JSX.Element {
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<string>();
  async function choose() {
    if (busy()) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const started = await props.start();
      if (failed(started)) setProblem(started.data.message);
    } catch {
      setProblem("The sign-in could not start. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Header step="method" mark>
        Anthropic
      </Header>
      <div class="flex flex-col gap-1">
        <div class="rounded-md bg-band p-1">
          <Row
            as="button"
            kind="double"
            aria-busy={busy() ? "true" : undefined}
            lead={<Icon path={profilesIcon} />}
            trail={<Icon path={glyphs.next} size={14} />}
            detail="Pro · Max · Team · Enterprise"
            onClick={() => void choose()}
          >
            Claude subscription
          </Row>
        </div>
        {/* Shown so it is not missed, and marked as coming later. */}
        <div class="rounded-md p-1 opacity-50 inset-ring inset-ring-edge" aria-disabled="true">
          <Row
            kind="double"
            lead={<Icon path={glyphs.key} />}
            trail="Later"
            detail="From the Anthropic console"
          >
            API key
          </Row>
        </div>
      </div>
      <Problem message={problem()} />
      <div class="flex">
        <Button variant="ghost" icon={glyphs.back} onClick={() => props.onBack()}>
          Back
        </Button>
      </div>
    </>
  );
}

function SignInStep(props: {
  signIn: SignIn;
  finish: (pasted: string) => Promise<unknown>;
  restart: () => Promise<unknown>;
  copy?: (text: string) => Promise<void>;
}): JSX.Element {
  const [pasted, setPasted] = createSignal("");
  const [problem, setProblem] = createSignal<string>();
  /** A sign-in that cannot finish any more (refused or cancelled) offers to start again. */
  const [ended, setEnded] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  async function copyLink() {
    await (props.copy ?? ((text: string) => navigator.clipboard.writeText(text)))(props.signIn.link);
    setCopied(true);
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => setCopied(false), 2_000);
  }
  async function submit() {
    setProblem(undefined);
    try {
      const result = await props.finish(pasted());
      if (failed(result)) {
        setProblem(result.data.message);
        setEnded(["Refused", "Cancelled", "AlreadyAdded", "Gone"].includes(result.kind));
      }
    } catch {
      setProblem("The sign-in could not finish. Try again.");
    }
  }
  return (
    <>
      <Header step="sign-in" mark>
        Sign in to Claude
      </Header>
      <Show
        when={!ended()}
        fallback={
          <div class="flex flex-col items-start gap-3">
            <Problem message={problem()} />
            <Button variant="brand" onClick={() => props.restart()}>
              Start again
            </Button>
          </div>
        }
      >
        <div class="flex items-center gap-1 pt-1">
          <Button
            variant="brand"
            icon={glyphs.external}
            render={(attrs: Record<string, unknown>) => (
              <a {...attrs} href={props.signIn.link} target="_blank" rel="noopener noreferrer" />
            )}
          >
            Open sign-in page
          </Button>
          <span class="ps-2 text-label text-ink-3">or</span>
          <Button variant="ghost" icon={copied() ? icons.check : glyphs.copy} onClick={() => copyLink()}>
            {copied() ? "Copied" : "Copy link"}
          </Button>
        </div>
        <p class="m-0 flex items-center gap-2 text-label text-ink-3">
          <Icon path={icons.running} size={12} />
          Waiting for you to sign in · you can close this
        </p>
        <Collapsible.Root>
          <Collapsible.Trigger variant="quiet">Signed in on another device?</Collapsible.Trigger>
          <Collapsible.Panel>
            <form
              class="flex flex-col gap-2 pt-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <div class="flex items-center gap-2">
                <Input
                  mono
                  class="flex-1"
                  aria-label="Link or code from the sign-in page"
                  placeholder="http://localhost:54545/callback?code=…"
                  invalid={Boolean(problem())}
                  value={pasted()}
                  onInput={(event: InputEvent & { currentTarget: HTMLInputElement }) =>
                    setPasted(event.currentTarget.value)
                  }
                />
                <Button size="sm" variant="ghost" type="submit" disabled={!pasted().trim()}>
                  Continue
                </Button>
              </div>
              <Problem message={problem()} />
            </form>
          </Collapsible.Panel>
        </Collapsible.Root>
      </Show>
    </>
  );
}

function ConnectedStep(props: {
  subscription: Subscription;
  done: (label: string) => Promise<unknown>;
}): JSX.Element {
  const [label, setLabel] = createSignal(props.subscription.label);
  const [problem, setProblem] = createSignal<string>();
  const email = () => props.subscription.accounts.find((account) => account.email)?.email;
  async function save() {
    setProblem(undefined);
    const saved = await props.done(label());
    if (failed(saved)) setProblem(saved.data.message);
  }
  return (
    <>
      <Header step="connected">Connected</Header>
      <div class="flex items-center gap-3 rounded-md p-4 surface-tray">
        <CompanyMark company={props.subscription.company} size={24} />
        <div class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-row font-medium text-ink">{titleOf(props.subscription)}</span>
          <Show when={email()}>
            <span class="truncate text-data text-ink-2">{email()}</span>
          </Show>
        </div>
        <Icon path={icons.done} class="text-ink-3" />
      </div>
      <div class="flex flex-col gap-2">
        <span class="text-data text-ink-3">{countOf(props.subscription.models.length, "model")} found</span>
        <ul aria-label="Models" class="m-0 flex list-none flex-wrap gap-2 p-0">
          <For each={props.subscription.models}>
            {(model) => (
              <li>
                <Chip size="sm" icon={markPath(props.subscription.company)}>
                  {modelName(model.name)}
                </Chip>
              </li>
            )}
          </For>
        </ul>
      </div>
      <form
        class="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div class="flex flex-col gap-2">
          <label for="subscription-label" class="text-label text-ink-3">
            Label
          </label>
          <Input
            id="subscription-label"
            size="lg"
            placeholder="Personal"
            value={label()}
            invalid={Boolean(problem())}
            onInput={(event: InputEvent & { currentTarget: HTMLInputElement }) =>
              setLabel(event.currentTarget.value)
            }
          />
          <Problem message={problem()} />
        </div>
        <div class="flex justify-end">
          <Button variant="brand" type="submit">
            Done
          </Button>
        </div>
      </form>
    </>
  );
}
