import { createSignal, For } from "solid-js";
import { createApi, type FunctionReference } from "@tokamak/sdk";
import { Region, state, view } from "@tokamak/sdk/client";
import { useClient, useQuery } from "@tokamak/sdk/solid";
import { Button, Icon, Row, RowList, icons } from "@tokamak/ui";

const api = createApi<{
  threads: {
    list: FunctionReference<"query", {}, { _id: string; title: string }[]>;
    start: FunctionReference<
      "mutation",
      { text: string; folder: { kind: "own" } },
      { threadId: string; messageId: string }
    >;
  };
}>("chat");
const revision = "Fixture revision one";

export const FixtureView = view({ route: "/" }, () => {
  const client = useClient();
  const threads = useQuery(client, api.threads.list, () => ({}));
  const [title, setTitle] = createSignal("New thread");
  return (
    <section aria-label="Integration fixture" class="flex flex-col gap-4 p-8">
      <Region.Sidebar>
        <Row
          as="button"
          lead={<Icon path={icons.add} />}
          onClick={() => void client.mutation(api.threads.start, { text: title(), folder: { kind: "own" } })}
        >
          New fixture thread
        </Row>
        <RowList.Root aria-label="Fixture threads">
          <RowList.Group>
            <For each={threads.data() ?? []}>
              {(thread) => <RowList.Option value={thread._id}>{thread.title}</RowList.Option>}
            </For>
          </RowList.Group>
        </RowList.Root>
      </Region.Sidebar>
      <Region.Header>
        <h1 class="min-w-0 flex-1 truncate text-row font-medium text-ink">Fixture header</h1>
        <Button variant="ghost" icon={icons.more} label="Fixture actions" />
      </Region.Header>
      <h2 class="text-read font-semibold text-ink">{revision}</h2>
      <p role="status" aria-label="Fixture thread count" class="text-row text-ink-2">
        {threads.loading() ? "Loading fixture query…" : `Fixture live threads: ${threads.data()?.length}`}
      </p>
      <label class="flex flex-col gap-2 text-label text-ink-3">
        New thread title
        <input
          class="h-8 max-w-read rounded-sm px-3 text-row text-ink inset-ring inset-ring-edge-strong"
          value={title()}
          onInput={(event) => setTitle(event.currentTarget.value)}
        />
      </label>
      <p role="alert">{threads.error()?.message}</p>
    </section>
  );
});

export const PanelView = view({ route: "/panel" }, () => (
  <section aria-label="Panel fixture" class="p-8 text-row text-ink-2">
    <Region.Panel>
      <div class="flex h-12 shrink-0 items-center ps-4 pe-2 text-row font-medium text-ink">Fixture panel</div>
    </Region.Panel>
    The stage beside a panel.
  </section>
));

export const ThrowingView = view({ route: "/throw" }, () => {
  throw new Error("Deliberate fixture failure");
});

const windowDraft = state("");
const deviceDraft = state("", { keep: "device" });
const personalDraft = state("", { keep: "me" });

export const WindowStateView = view({ route: "/window-state" }, () => (
  <section aria-label="Window state fixture">
    <h2>{revision}</h2>
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const draft = new FormData(event.currentTarget).get("draft");
        if (typeof draft !== "string") return;
        windowDraft.set(draft);
        deviceDraft.set(draft);
        personalDraft.set(draft);
      }}
    >
      <label>
        Draft <input name="draft" />
      </label>
      <Button type="submit">Save drafts</Button>
    </form>
    <p>Window draft: {windowDraft() || "empty"}</p>
    <p>Device draft: {deviceDraft() || "empty"}</p>
    <p>Personal draft: {personalDraft() || "empty"}</p>
  </section>
));
