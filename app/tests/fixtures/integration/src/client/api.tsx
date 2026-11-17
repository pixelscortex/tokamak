import { createApi, type FunctionReference } from "@tokamak/sdk";
import { Region, view } from "@tokamak/sdk/client";
import { useClient, useQuery } from "@tokamak/sdk/solid";

const api = createApi<{
  threads: { list: FunctionReference<"query", {}, { title: string }[]> };
}>("chat");
export const FixtureView = view({ route: "/" }, () => {
  const threads = useQuery(useClient(), api.threads.list, () => ({}));
  return (
    <section aria-label="Integration fixture">
      <Region.Sidebar>
        <p>Fixture sidebar</p>
      </Region.Sidebar>
      <Region.Header>
        <p>Fixture header</p>
      </Region.Header>
      <h1>Fixture revision one</h1>
      <p role="status" aria-label="Fixture thread count">
        {threads.loading() ? "Loading fixture query…" : `Fixture live threads: ${threads.data()?.length}`}
      </p>
      <p role="alert">{threads.error()?.message}</p>
    </section>
  );
});

export const ThrowingView = view({ route: "/throw" }, () => {
  throw new Error("Deliberate fixture failure");
});
