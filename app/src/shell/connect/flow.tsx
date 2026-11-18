import { Match, Switch, createSignal, onCleanup, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Region } from "@tokamak/sdk/client";
import { Icon, icons } from "@tokamak/ui";
import { nameFromHost, parseInvite, type ParsedInvite, type ServerAddress } from "../../host/invite";
import { checkAccess, reach } from "../../host/reach";
import { useShell } from "../context";
import { Control } from "../control";
import { shellIcons } from "../icons";
import { shellPages } from "../pages";
import {
  AddressStep,
  ConnectingStep,
  CustomizeStep,
  UnreachableStep,
  VerifyStep,
  type Step,
  type StepOf,
} from "./steps";

/**
 * "Add a server": four steps on the stage, in its own tab. Nothing is saved until the
 * last step; Esc, the close control or closing the tab cancels, and leaving stops any
 * request still out.
 */
export function Connect(): JSX.Element {
  const shell = useShell();
  const servers = shell.servers;
  const [step, setStep] = createSignal<Step>({ name: "address" }, { ownedWrite: true });
  const [address, setAddress] = createSignal("", { ownedWrite: true });
  const [inviteToken, setInviteToken] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  const [addressError, setAddressError] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  const [token, setToken] = createSignal("", { ownedWrite: true });
  const [name, setName] = createSignal(untrack(servers.displayName), { ownedWrite: true });
  const [checking, setChecking] = createSignal(false, { ownedWrite: true });
  let request: AbortController | undefined;
  const next = () => {
    request?.abort();
    request = new AbortController();
    return request.signal;
  };
  onCleanup(() => request?.abort());

  const cancel = () => shell.navigation.close(shellPages.connect.route);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented) cancel();
  };
  document.addEventListener("keydown", onKey);
  onCleanup(() => document.removeEventListener("keydown", onKey));

  /**
   * A whole invite splits into its address, shown in the field, and its token, kept
   * aside. The token belongs to that address: typing another one drops it.
   */
  let invitedAddress: string | undefined;
  const typeAddress = (value: string) => {
    setAddressError(undefined);
    const parsed = value.includes("#") ? parseInvite(value) : undefined;
    if (parsed?.ok && parsed.token) {
      invitedAddress = shown(parsed.address);
      setInviteToken(parsed.token);
      setAddress(invitedAddress);
      return;
    }
    if (value.trim() !== invitedAddress) {
      invitedAddress = undefined;
      setInviteToken(undefined);
    }
    setAddress(value);
  };

  const connect = (target: ServerAddress, invite?: string) => {
    const signal = next();
    setStep({ name: "connecting", address: target, token: invite });
    void reach(target.origin, { signal }).then((answer) => {
      if (signal.aborted) return;
      if (answer.ok) setStep({ name: "connecting", address: target, token: invite, answer });
      else setStep({ name: "unreachable", address: target, token: invite, answer });
    });
  };

  const start = (parsed: ParsedInvite) => {
    if (!parsed.ok) return setAddressError(parsed.reason);
    const own = servers.list().find((server) => server.kind === "origin");
    if (!servers.canAdd && own && own.kind === "origin" && parsed.address.origin !== own.address)
      return setAddressError(`This page can only join ${own.address}.`);
    connect(parsed.address, parsed.token);
  };

  const join = async (event: SubmitEvent) => {
    event.preventDefault();
    const current = step();
    if (current.name !== "verify" || checking()) return;
    const secret = (current.access || !current.token ? token() : current.token).trim();
    if (!secret) return setStep({ ...current, access: "rejected" });
    const signal = next();
    setChecking(true);
    const access = await checkAccess(current.address.origin, secret, { signal });
    if (signal.aborted) return;
    setChecking(false);
    if (access === "accepted") return setStep({ name: "customize", address: current.address, token: secret });
    setToken(secret);
    setStep({ ...current, access });
  };

  const finish = (event: SubmitEvent) => {
    event.preventDefault();
    const current = step();
    if (current.name !== "customize" || !name().trim()) return;
    const saved = servers.save({
      address: current.address.origin,
      token: current.token,
      name: nameFromHost(current.address.host),
      displayName: name().trim(),
    });
    // The same server with a new token reconnects in place; another one switches.
    if (saved.id === servers.current().id) shell.session.retry();
    else shell.switchServer(saved.id);
    cancel();
  };

  // An address or invite handed over by the failure band or a /join link starts at once.
  const handed = shell.takeInvite();
  if (handed) {
    typeAddress(handed);
    start(parseInvite(handed));
  }

  const serverName = () => {
    const current = step();
    return "address" in current ? nameFromHost(current.address.host) : "";
  };
  const at = <Name extends Step["name"]>(name: Name) => {
    const current = step();
    return current.name === name ? (current as StepOf<Name>) : undefined;
  };

  return (
    <>
      <Region.Header>
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <Icon path={shellIcons.cloud} class="text-ink" />
          <h1 class="truncate text-row font-medium text-ink">{shellPages.connect.title}</h1>
          <div class="flex-1" />
          <Control icon={icons.close} label="Close" keys="Escape" onClick={cancel} />
        </div>
      </Region.Header>
      <div class="flex min-h-0 flex-1 flex-col items-center overflow-auto px-8 py-16">
        <div class="flex-1" />
        <section aria-label="Add a server" class="flex w-full max-w-dialog flex-col">
          <Switch>
            <Match when={step().name === "address"}>
              <AddressStep
                address={address()}
                inviteToken={inviteToken()}
                error={addressError()}
                onInput={typeAddress}
                onSubmit={(event) => {
                  event.preventDefault();
                  start(parseInvite(inviteToken() ? `${address()}#${inviteToken()}` : address()));
                }}
                onCancel={cancel}
              />
            </Match>
            <Match when={at("connecting")}>
              {(current) => (
                <ConnectingStep
                  step={current()}
                  onBack={() => setStep({ name: "address" })}
                  onContinue={() => {
                    const { address: target, token: invite, answer } = current();
                    if (answer) setStep({ name: "verify", address: target, token: invite, answer });
                  }}
                />
              )}
            </Match>
            <Match when={at("unreachable")}>
              {(current) => (
                <UnreachableStep
                  step={current()}
                  onBack={() => setStep({ name: "address" })}
                  onRetry={() => connect(current().address, current().token)}
                />
              )}
            </Match>
            <Match when={at("verify")}>
              {(current) => (
                <VerifyStep
                  step={current()}
                  name={serverName()}
                  token={token()}
                  onToken={setToken}
                  checking={checking()}
                  onSubmit={join}
                  onBack={() => {
                    request?.abort();
                    setChecking(false);
                    setStep({ name: "address" });
                  }}
                />
              )}
            </Match>
            <Match when={step().name === "customize"}>
              <CustomizeStep
                server={serverName()}
                name={name()}
                onName={setName}
                usedBefore={!!servers.displayName() && name() === servers.displayName()}
                onSubmit={finish}
              />
            </Match>
          </Switch>
        </section>
        <div class="grow-2" />
      </div>
    </>
  );
}

/** The address as a person would type it: the host, unless the scheme can't be implied. */
function shown(address: ServerAddress): string {
  const again = parseInvite(address.host);
  return again.ok && again.address.origin === address.origin ? address.host : address.origin;
}
