/** Real chat parts, updated by the native test one ACP-sized chunk at a time. */
import { createSignal, Show } from "solid-js";
import { mount, onHostEvent } from "@tokamak/render";
import { Message } from "../../plugins/chat/src/client/ui/messages/message";
import type { Message as ChatMessage } from "../../plugins/chat/src/client/lib/state/use-chat";
import { ShellFrame } from "../src/shell-frame";

function ChatLayout() {
  const [message, setMessage] = createSignal<ChatMessage>();
  onHostEvent<ChatMessage>("message", setMessage);
  return (
    <ShellFrame
      switcher={null}
      navigation={null}
      stage={
        <div class="shell-plugin shell-plugin-root">
          <section class="flex min-h-0 min-w-0 flex-1 justify-center px-6 pb-6">
            <div id="chat-layout-column" class="flex min-h-0 w-[560px] max-w-full flex-col gap-4">
              <div class="flex min-h-0 flex-1 flex-col gap-5">
                <div
                  id="chat-messages"
                  class="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain"
                >
                  <p class="m-0 shrink-0">Previous user message</p>
                  <Show when={message()}>
                    <Message message={message()!} />
                  </Show>
                </div>
                <div class="shrink-0">Conversation · Codex · 3 turns</div>
              </div>
              <div class="shrink-0">Ask anything</div>
            </div>
          </section>
        </div>
      }
    />
  );
}
mount(ChatLayout);
