import { For, Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Id } from "@tokamak/sdk";
import { Button, Dialog, Icon, Menu, Textarea, icons } from "@tokamak/ui";
import { folderName, folderOf, optionAgent, type Backend, type BackendOption } from "../../lib/agents";
import { glyphs } from "../../lib/icons";
import { api, type ChatState } from "../../lib/state/use-chat";

// The last folder that worked, so a new thread starts where the previous one did.
let lastFolder = "";

const FOLDER = "folder";

/** The agent and its folder, in the composer strip: a menu of agents and "Change folder…". */
export function AgentPicker(props: {
  chat: ChatState;
  threadId: Id<"threads">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const [folderOpen, setFolderOpen] = createSignal(false, { ownedWrite: true });
  const [folder, setFolder] = createSignal("", { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  const agent = () => props.chat.agent();
  const backend = () => props.chat.backend() as Backend | undefined;
  const disabled = () => !props.chat.threadReady(props.threadId);

  async function save(choice: { plugin: string; backendId: string }, path: string) {
    const thread = props.chat.thread();
    if (!thread || disabled() || saving()) return "busy";
    setSaving(true);
    setError(undefined);
    try {
      if (props.chat.remote) {
        await props.chat.setMachineAgent(thread._id, choice.backendId, path);
        return undefined;
      }
      const settings = await props.chat.client.action(api.backends.configure, {
        plugin: choice.plugin,
        backendId: choice.backendId,
        settings: { cwd: path },
      });
      await props.chat.client.mutation(api.threads.setBackend, {
        threadId: thread._id,
        backend: { kind: "plugin", ...choice, settings },
      });
      lastFolder = folderOf(settings) || lastFolder;
      return undefined;
    } catch (cause) {
      const message = String(cause).replace(/^Error:\s*/, "");
      setError(message);
      return message;
    } finally {
      setSaving(false);
    }
  }

  function choose(value: string) {
    if (disabled()) return;
    if (value === FOLDER) {
      setFolder(agent()?.folder ?? (props.chat.remote ? "" : lastFolder));
      setError(undefined);
      setFolderOpen(true);
      return;
    }
    const option = props.chat.backends()?.find((item) => `${item.plugin}/${item.id}` === value);
    if (props.chat.remote) {
      if (option || value === "message")
        void props.chat
          .setMachineAgent(props.threadId, option?.id)
          .catch((error) => props.chat.setError(String(error)));
      return;
    }
    if (!option) return;
    void save({ plugin: option.plugin, backendId: option.id }, agent()?.folder || lastFolder).then(
      (failure) => {
        if (failure && failure !== "busy") props.chat.setError(failure);
      },
    );
  }

  async function submitFolder() {
    const path = folder().trim();
    if (path && !path.startsWith("/") && !path.startsWith("~")) {
      setError("Use a full path such as ~/code/app, or leave it empty for your home folder.");
      return;
    }
    const current = backend();
    if (current && !(await save({ plugin: current.plugin, backendId: current.backendId }, path)))
      setFolderOpen(false);
  }

  return (
    <>
      <Menu.Root
        open={props.open && !disabled()}
        onOpenChange={props.onOpenChange}
        onAction={(value) => choose(String(value))}
      >
        <Menu.Trigger
          variant="ghost"
          class="-ms-2 min-w-0"
          aria-label="Agent and folder"
          disabled={disabled()}
        >
          <span class="flex min-w-0 items-center gap-2">
            <Show when={agent()}>
              {(current) => <Icon path={current().mark} size={12} class="text-ink" />}
            </Show>
            <span class="text-row text-ink-2">
              {agent()?.name ?? (props.chat.remote ? "Message only" : "Choose an agent")}
            </span>
            <Show when={agent()?.folder}>
              {(path) => <span class="min-w-0 truncate text-data text-ink-3">{folderName(path())}</span>}
            </Show>
            <Icon path={icons.chevronDown} size={12} class="text-ink-3" />
          </span>
        </Menu.Trigger>
        <Menu.Content>
          <Menu.Group>
            <Menu.GroupLabel>{props.chat.remote ? "Agents on this computer" : "Agent"}</Menu.GroupLabel>
            <Show when={props.chat.remote}>
              <Menu.Item value="message">Message only</Menu.Item>
            </Show>
            <For each={props.chat.backends() ?? []}>
              {(option: BackendOption) => (
                <Menu.Item value={`${option.plugin}/${option.id}`}>
                  <Icon path={optionAgent(option).mark} class="text-ink-2" />
                  {optionAgent(option).name}
                  <Show when={backend()?.backendId === option.id && backend()?.plugin === option.plugin}>
                    <Icon path={glyphs.check} class="ms-auto text-ink-3" label="current" />
                  </Show>
                </Menu.Item>
              )}
            </For>
          </Menu.Group>
          <Show when={backend()}>
            <Menu.Separator />
            <Menu.Item value={FOLDER}>
              <Icon path={glyphs.folder} class="text-ink-2" />
              Change folder…
            </Menu.Item>
          </Show>
        </Menu.Content>
      </Menu.Root>
      <Dialog.Root open={folderOpen()} onOpenChange={(open) => !saving() && setFolderOpen(open)}>
        <Dialog.Backdrop />
        <Dialog.Content>
          <Dialog.Title>Folder for {agent()?.name ?? "the agent"}</Dialog.Title>
          <Dialog.Description>
            The agent can read, change and run anything in this folder. Leave it empty for your home folder.
          </Dialog.Description>
          <form
            class="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submitFolder();
            }}
          >
            <Textarea
              aria-label="Folder"
              placeholder="~ (home folder)"
              value={folder()}
              onValueChange={setFolder}
              submitShortcut="enter"
              onSubmit={() => void submitFolder()}
              disabled={saving()}
            />
            <Show when={error()}>
              {(message) => (
                <p role="alert" class="text-row text-removed">
                  {message()}
                </p>
              )}
            </Show>
            <div class="flex justify-end gap-2">
              <Dialog.Close disabled={saving()}>Cancel</Dialog.Close>
              <Button type="submit" variant="primary" disabled={saving()}>
                {saving() ? "Checking…" : "Use folder"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
