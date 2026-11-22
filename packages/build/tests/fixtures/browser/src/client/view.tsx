import { component, useQuery, useClient, view } from "@tokamak/sdk/client";
import { createApi } from "@tokamak/sdk";
import { createSignal } from "solid-js";
const api = createApi<{ fixture: { read: import("@tokamak/sdk").FunctionReference<"query", {}, string> } }>();
export const dependency = () => import("plugin:other/client");
export const FixtureBody = component("fixtureBody", {}, (props: { label: string; text?: string }) => (
  <section part="body">
    <h1>{props.label}</h1>
    <p>{props.text}</p>
  </section>
));
export const FixtureView = view({ route: "/fixture" }, () => {
  const [label] = createSignal("Fixture");
  const query = useQuery(useClient(), api.fixture.read, () => ({}));
  return <FixtureBody label={label()} text={query.data()} />;
});
