import { createSignal, For } from "solid-js";
import { createApi, type FunctionReference } from "@tokamak/sdk";
import { Region, view } from "@tokamak/sdk/client";
import { useClient, useQuery } from "@tokamak/sdk/solid";
import { Button, Icon, Row, RowList, icons } from "@tokamak/ui";

const api = createApi<{
  threads: {
    list: FunctionReference<"query", {}, { _id: string; title: string }[]>;
    create: FunctionReference<"action", { title?: string }, string>;
  };
}>("chat");

export const FixtureView = view({ route: "/" }, () => {
  const client = useClient();
  const threads = useQuery(client, api.threads.list, () => ({}));
  const [title, setTitle] = createSignal("New thread");
  return (
    <section aria-label="Integration fixture" class="flex flex-col gap-4 p-8">
      <Region.Sidebar>
        <Row
          lead={<Icon path={icons.add} />}
          render={(attrs) => (
            <button
              {...attrs}
              type="button"
              onClick={() => void client.action(api.threads.create, { title: title() })}
            />
          )}
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
      <h2 class="text-read font-semibold text-ink">Fixture revision one</h2>
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
