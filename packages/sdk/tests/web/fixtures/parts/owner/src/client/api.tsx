import type { JSX } from "@solidjs/web";
import { For, onCleanup } from "solid-js";

export interface ExampleProps {
  label: string;
  lifecycle: (event: string) => void;
}

const SendButton = (props: ExampleProps) => {
  props.lifecycle("send mounted");
  onCleanup(() => props.lifecycle("send unloaded"));
  return <button>{props.label}</button>;
};

export const Composer = (props: ExampleProps) => (
  <section aria-label="toolbar">
    <SendButton {...props} />
    <div aria-label="body" />
  </section>
);

const Region = (props: { children: JSX.Element }) => <main>{props.children}</main>;

export const Labels = (props: { labels: string[] }) => (
  <section>
    <For each={props.labels}>
      {(props, index) => (
        <span>
          {index() + 1}: {props}
        </span>
      )}
    </For>
    <input aria-label="Search" />
    <Region children={<span>Body</span>} />
    <button {...{ children: "Forwarded" }} />
  </section>
);

export function BenchmarkRow(props: { text: string }) {
  return (
    <article>
      <header>
        <b>Person</b>
        <time>10:00</time>
      </header>
      <div data-region="body">
        <p>{props.text}</p>
      </div>
      <footer>
        <span>Sent</span>
      </footer>
    </article>
  );
}
