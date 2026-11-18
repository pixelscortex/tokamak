import { Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button, Chip, Dialog, Icon, Menu, Textarea, icons } from "@tokamak/ui";
import { folderName } from "../../lib/agents";
import { glyphs } from "../../lib/icons";
import type { ChatState } from "../../lib/state/use-chat";
import { useThreadEditor } from "../../lib/state/use-thread-editor";

/** The page header: the thread's title, its folder, and rename, copy and delete. */
export function ThreadHeader(props: { chat: ChatState; onCopy: () => void }): JSX.Element {
  const editor = useThreadEditor(props.chat);
  const [title, setTitle] = createSignal("", { ownedWrite: true });
  createEffect(editor.editing, (editing) => {
    if (editing?.mode === "rename") setTitle(editing.thread.title);
  });
  const mode = () => editor.editing()?.mode;
  const close = (open: boolean) => !open && !editor.busy() && editor.close();

  return (
    <Show when={props.chat.thread()}>
      {(thread) => (
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <Icon path={glyphs.chat} class="text-ink-2" />
          <h1 class="min-w-0 truncate text-row text-ink">{thread().title}</h1>
          <Show when={props.chat.agent()?.folder}>
            {(path) => (
              <Chip size="sm" mono label={`Folder ${path()}`}>
                {folderName(path())}
              </Chip>
            )}
          </Show>
          <span class="flex-1" />
          <Show when={props.chat.canStop() && !props.chat.active()}>
            <Button variant="ghost" onClick={() => void props.chat.cancel()}>
              Stop
            </Button>
          </Show>
          <Menu.Root
            onAction={(value) => {
              if (value === "copy") props.onCopy();
              else editor.begin(thread(), value as "rename" | "delete");
            }}
          >
            <Menu.Trigger variant="ghost" icon={icons.more} label="Thread actions" />
            <Menu.Content>
              <Menu.Item value="rename">
                <Icon path={glyphs.edit} class="text-ink-2" />
                Rename
              </Menu.Item>
              <Menu.Item value="copy" shortcut="mod+shift+c">
                <Icon path={glyphs.copy} class="text-ink-2" />
                Copy last reply
              </Menu.Item>
              <Menu.Separator />
              <Menu.Item value="delete" destructive>
                <Icon path={glyphs.delete} />
                Delete
              </Menu.Item>
            </Menu.Content>
          </Menu.Root>

          <Dialog.Root open={mode() === "rename"} onOpenChange={close}>
            <Dialog.Backdrop />
            <Dialog.Content>
              <Dialog.Title>Rename thread</Dialog.Title>
              <form
                class="flex flex-col gap-4 pt-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void editor.save(title());
                }}
              >
                <Textarea
                  aria-label="Thread title"
                  value={title()}
                  onValueChange={setTitle}
                  submitShortcut="enter"
                  onSubmit={() => void editor.save(title())}
                  disabled={editor.busy()}
                  autofocus
                />
                <div class="flex justify-end gap-2">
                  <Dialog.Close disabled={editor.busy()}>Cancel</Dialog.Close>
                  <Button type="submit" variant="primary" disabled={editor.busy() || !title().trim()}>
                    Rename
                  </Button>
                </div>
              </form>
            </Dialog.Content>
          </Dialog.Root>

          <Dialog.Root open={mode() === "delete"} onOpenChange={close}>
            <Dialog.Backdrop />
            <Dialog.Content>
              <Dialog.Title>Delete “{editor.editing()?.thread.title}”?</Dialog.Title>
              <Dialog.Description>Its messages are deleted too. This cannot be undone.</Dialog.Description>
              <div class="flex justify-end gap-2">
                <Dialog.Close disabled={editor.busy()}>Cancel</Dialog.Close>
                <Button variant="destructive" disabled={editor.busy()} onClick={() => void editor.save()}>
                  Delete
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Root>
        </div>
      )}
    </Show>
  );
}
