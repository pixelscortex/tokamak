import { createSignal, createEffect, onCleanup } from "solid-js";
import { createApi } from "@tokamak/sdk";
import { view, useShortcuts } from "@tokamak/sdk/client";
import { useClient, useQuery } from "@tokamak/sdk/solid";
const api = createApi("fixture");
import { useRouter } from "@tokamak/runtime/router";
import { signal, revision } from "@plugins/fixture-dependency/ui";
export const sharedDependencySignal = signal;
export const sharedSignal = createSignal;
export const View = view({ route: "/" }, () => {
  if ("FIXTURE_REVISION" === "throws") throw new Error("fixture view failed");
  const query = useQuery(useClient(), api.data.read, () => ({}));
  const [count, setCount] = createSignal(0);
  onCleanup(useShortcuts().registerShortcut("Meta+n", () => setCount(count() + 1)));
  const button = document.createElement("button");
  button.dataset.route = useRouter().location().pathname;
  button.onclick = () => setCount(count() + 1);
  createEffect(
    () => `${query.data() ?? "waiting"} FIXTURE_REVISION ${count()} dependency:${revision}`,
    (text) => {
      button.textContent = text;
    },
  );
  onCleanup(() => {
    button.dataset.disposed = "true";
    button.onclick = null;
  });
  return button;
});
