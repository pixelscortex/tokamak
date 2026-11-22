import type { JSX } from "@solidjs/web";
import { For, onCleanup } from "solid-js";
import { component } from "@tokamak/sdk/client";

export interface ExampleProps {
  label: string;
  lifecycle: (event: string) => void;
}

const SendButton = (props: ExampleProps) => {
  props.lifecycle("send mounted");
  onCleanup(() => props.lifecycle("send unloaded"));
  return <button>{props.label}</button>;
};

export const Composer = component("composer", {}, (props: ExampleProps) => (
  <section part="toolbar" aria-label="toolbar">
    <SendButton {...props} />
  </section>
));

export const CustomLayout = component("customLayout", {}, () => (
  <section part="ribbon">
    {(added) => (
      <>
        <h2>{added.append}</h2>
        <footer>{added.prepend}</footer>
      </>
    )}
  </section>
));

const Region = (props: { children: JSX.Element }) => <main>{props.children}</main>;

export const Labels = component("labels", {}, (props: { labels: string[] }) => (
  <section>
    <For part="for" each={props.labels}>
      {(label) => <span>{label}</span>}
    </For>
    <input part="search" aria-label="Search" />
    <Region children={<span part="body">Body</span>} />
  </section>
));
