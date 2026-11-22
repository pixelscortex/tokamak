import { Avatar, Button, Dialog, icons, Menu } from "@tokamak/ui";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { Endpoint } from "../host/endpoint";
import { type MemberEdit, type MembersSnapshot, updateMembers } from "../host/members";
import { discoverSignIn, type SignInMethod } from "../host/sign-in";
import { readSnapshots } from "../host/snapshots";
import { useShell } from "./context";
import { CredentialField, passwordError, ProviderFields } from "./credential-fields";
import { Unreachable } from "./states";

export function Members(): JSX.Element {
  const shell = useShell();
  const endpoint = () => {
    const current = shell.session.connection();
    return current.state === "connected" ? current.endpoint : undefined;
  };
  const failure = () => {
    const current = shell.session.connection();
    return current.state === "failed" ? current : undefined;
  };
  return (
    <Show
      when={shell.servers.current().kind !== "local"}
      fallback={<p class="px-6 py-8 text-row text-ink-2">Members are managed on a shared server.</p>}
    >
      <Show
        when={endpoint()}
        keyed
        fallback={
          <Show when={failure()} fallback={<p class="px-6 py-8 text-row text-ink-2">Connecting…</p>}>
            {(failed) => <Unreachable reason={failed().reason} needs={failed().needs} />}
          </Show>
        }
      >
        {(server) => <MembersList endpoint={server} />}
      </Show>
    </Show>
  );
}

const roleLabel = { owner: "Owner", admin: "Admin", member: "Member" } as const;

function MembersList(props: { endpoint: Endpoint }): JSX.Element {
  const [snapshot, setSnapshot] = createSignal<MembersSnapshot>();
  const [reconnecting, setReconnecting] = createSignal(false);
  const [denied, setDenied] = createSignal(false);
  const [edit, setEdit] = createSignal<MemberEdit>();
  const byId = createMemo(() => new Map(snapshot()?.members.map((member) => [member.id, member])));
  const endpoint = props.endpoint;
  let stream: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  async function follow(signal: AbortSignal, refreshed: (fresh: boolean) => void) {
    try {
      const allowed = await readSnapshots<MembersSnapshot>(endpoint, "/members/live", signal, (next) => {
        setSnapshot(next);
        setReconnecting(false);
        refreshed(true);
      });
      if (!allowed && !signal.aborted) {
        setEdit(undefined);
        setSnapshot(undefined);
        setReconnecting(false);
        setDenied(true);
        return;
      }
    } catch {
      // Retry when a temporary connection failure interrupts the list.
    } finally {
      refreshed(false);
    }
    if (!signal.aborted) {
      setReconnecting(true);
      retry = setTimeout(() => void refresh(), 1_000);
    }
  }

  function refresh(): Promise<boolean> {
    clearTimeout(retry);
    stream?.abort();
    const controller = new AbortController();
    stream = controller;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5_000);
      void follow(controller.signal, (fresh) => {
        clearTimeout(timeout);
        resolve(fresh);
      });
    });
  }

  void refresh();
  onCleanup(() => {
    clearTimeout(retry);
    stream?.abort();
  });

  return (
    <section aria-label="Members" class="mx-auto w-full max-w-read px-6 py-8 sm:px-8">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-row text-ink-2">Manage access to this server.</p>
        <Show when={snapshot()}>
          <Button icon={icons.add} disabled={reconnecting()} onClick={() => setEdit({ kind: "add" })}>
            Add member
          </Button>
        </Show>
      </div>
      <Show when={denied()}>
        <p class="mt-3 text-row text-ink-3">Only the owner and admins can manage members.</p>
      </Show>
      <Show when={reconnecting()}>
        <p role="status" class="mt-3 text-row text-ink-3">
          Reconnecting to the member list…
        </p>
      </Show>
      <Show
        when={snapshot()}
        fallback={
          <Show when={!denied() && !reconnecting()}>
            <p role="status" class="mt-4 text-row text-ink-3">
              Loading members…
            </p>
          </Show>
        }
      >
        {(current) => (
          <ul class="mt-3">
            <For each={[...byId().keys()]}>
              {(id) => {
                const member = () => byId().get(id)!;
                const mayManage = () =>
                  member().role !== "owner" &&
                  (current().viewer.role === "owner" || member().role === "member");
                return (
                  <li class="flex flex-wrap items-center gap-3 border-b border-edge py-3">
                    <Avatar name={member().name} size={24} class="shrink-0" />
                    <div class="min-w-0 flex-1">
                      <p class="wrap-break-word text-row font-medium text-ink">
                        {member().name}
                        <Show when={id === current().viewer.id}>
                          <span class="ms-2 text-label font-normal text-ink-3">You</span>
                        </Show>
                      </p>
                      <p class="text-label text-ink-3">{roleLabel[member().role]}</p>
                    </div>
                    <Show when={mayManage()}>
                      <Menu.Root
                        onAction={(value) => {
                          if (value === "reset" || value === "role" || value === "remove")
                            setEdit({ kind: value, member: member() });
                        }}
                      >
                        <Menu.Trigger
                          variant="ghost"
                          icon={icons.more}
                          disabled={reconnecting()}
                          label={`Actions for ${member().name}`}
                        />
                        <Menu.Content align="end">
                          <Show when={member().hasAccount}>
                            <Menu.Item value="reset">Reset password</Menu.Item>
                          </Show>
                          <Show when={current().viewer.role === "owner"}>
                            <Menu.Item value="role">
                              {member().role === "admin" ? "Make member" : "Make admin"}
                            </Menu.Item>
                          </Show>
                          <Menu.Item value="remove" destructive>
                            Remove member
                          </Menu.Item>
                        </Menu.Content>
                      </Menu.Root>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        )}
      </Show>
      <Show when={edit()} keyed>
        {(operation) => (
          <MemberDialog
            endpoint={endpoint}
            edit={operation}
            refresh={refresh}
            close={() => setEdit(undefined)}
          />
        )}
      </Show>
    </section>
  );
}

type EditFields = Record<string, FormDataEntryValue>;
type MemberAction = {
  title: string;
  description: string;
  path: string;
  body: (fields: EditFields, method?: string) => object | undefined;
};

function memberAction(edit: MemberEdit): MemberAction {
  const members = "/members";
  const member = edit.kind === "add" ? undefined : edit.member;
  const target = member ? `${members}/${encodeURIComponent(member.id)}` : members;
  const promote = member?.role !== "admin";
  const actions: Record<MemberEdit["kind"], MemberAction> = {
    add: {
      title: "Add member",
      description:
        "Share the temporary password with the new member. They’ll choose their own when they sign in.",
      path: members,
      body: (fields, method) => ({ method, fields }),
    },
    reset: {
      title: "Reset password",
      description: `Set a temporary password for ${member?.name}. They’ll choose a new one at sign-in. No email is sent. Their signed-in devices stay signed in. To sign them out, go to Settings → Devices.`,
      path: `${target}/reset-password`,
      body: (fields) => ({ password: fields.password }),
    },
    remove: {
      title: "Remove member",
      description: `${member?.name} will lose access to this server and be signed out on every device.`,
      path: `${target}/revoke`,
      body: () => undefined,
    },
    role: {
      title: promote ? "Make admin" : "Make member",
      description: promote
        ? `${member?.name} will be able to add members and manage their access.`
        : `${member?.name} will lose access to member management.`,
      path: `${target}/role`,
      body: () => ({ role: promote ? "admin" : "member" }),
    },
  };
  return actions[edit.kind];
}

function MemberDialog(props: {
  endpoint: Endpoint;
  edit: MemberEdit;
  refresh(): Promise<boolean>;
  close(): void;
}): JSX.Element {
  const edit = props.edit;
  const action = memberAction(edit);
  const [methods, setMethods] = createSignal<SignInMethod[]>();
  const [selected, select] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const method = () => methods()?.find(({ id }) => id === selected()) ?? methods()?.[0];
  const controller = new AbortController();
  const { signal } = controller;
  onCleanup(() => controller.abort());
  if (edit.kind === "add") {
    void discoverSignIn(props.endpoint.http, signal).then((options) => {
      if (!signal.aborted) setMethods(options?.methods.filter((method) => method.createAccountForm) ?? []);
    });
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy() || (edit.kind === "add" && !method())) return;
    const fields = Object.fromEntries(new FormData(event.currentTarget as HTMLFormElement));
    const body = action.body(fields, method()?.id);
    setError("");
    setBusy(true);
    try {
      const reason = await updateMembers(props.endpoint, action.path, signal, body);
      if (signal.aborted) return;
      if (reason === "LoginTaken" && edit.kind === "add") {
        // The previous request may have committed after its response was lost.
        const refreshed = await props.refresh();
        if (!signal.aborted)
          setError(
            refreshed
              ? "This login is already in use. Close this dialog to check the updated member list."
              : "This login is already in use. The member list couldn’t refresh; check it before trying again.",
          );
      } else if (reason) setError(memberError(reason));
      else props.close();
    } catch {
      if (signal.aborted) return;
      if (edit.kind === "add") {
        setError("Couldn’t confirm that the member was added. Check the member list before trying again.");
      } else setError("Couldn’t save the change. Try again.");
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy() && props.close()}>
      <Dialog.Content>
        <Dialog.Title>{action.title}</Dialog.Title>
        <Dialog.Description>{action.description}</Dialog.Description>
        <form class="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
          <Show when={edit.kind === "add"}>
            <Show when={(methods()?.length ?? 0) > 1}>
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
              when={method()?.createAccountForm}
              keyed
              fallback={
                <p role="status" class="text-row text-ink-2">
                  {methods() ? "No sign-in method supports adding members." : "Finding sign-in methods…"}
                </p>
              }
            >
              {(form) => (
                <ProviderFields form={form} password="temporary" autofocus={methods()?.length === 1} />
              )}
            </Show>
          </Show>
          <Show when={edit.kind === "reset"}>
            <CredentialField
              label="Temporary password"
              name="password"
              type="password"
              autocomplete="new-password"
              autofocus
            />
          </Show>
          <Show when={error()}>
            <p role="alert" class="text-row text-removed">
              {error()}
            </p>
          </Show>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <Dialog.Close variant="ghost" disabled={busy()}>
              Cancel
            </Dialog.Close>
            <Button
              type="submit"
              variant={edit.kind === "remove" ? "destructive" : "primary"}
              disabled={busy() || (edit.kind === "add" && !method())}
              data-agent-confirm={action.description}
            >
              {action.title}
            </Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function memberError(kind: string): string {
  if (kind === "Forbidden") return "You don’t have permission to make this change.";
  if (kind === "AccountNotLinked") return "This member has no password account to reset.";
  if (kind === "MemberManagementBusy") return "Another member change is in progress. Try again.";
  return passwordError(kind) ?? "Couldn’t save the change. Try again.";
}
