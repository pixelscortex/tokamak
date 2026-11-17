import { view, defineSlot, useQuery, useClient } from "@tokamak/sdk/client";
import { createApi } from "@tokamak/sdk";
import { createSignal } from "solid-js";
const api = createApi<{ fixture: { read: import("@tokamak/sdk").FunctionReference<"query", {}, string> } }>();
export const dependency = () => import("plugin:other/client");
export const actions = defineSlot("actions");
export function Panel() {
  return <aside>Panel</aside>;
}
export const FixtureView = view({ route: "/fixture" }, () => {
  const [label] = createSignal("Fixture");
  const query = useQuery(useClient(), api.fixture.read, () => ({}));
  return (
    <section>
      <h1>{label()}</h1>
      <p>{query.data()}</p>
    </section>
  );
});
