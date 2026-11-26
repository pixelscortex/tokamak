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
    <div aria-label="detail" />
    <select aria-label="Upload" />
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
    <div data-part="groups">
      <For each={props.labels}>
        {(group, groupIndex) => (
          <For each={[group.toUpperCase()]} keyed={false}>
            {(label, index) => (
              <em>
                {groupIndex()}:{index}:{label()}
              </em>
            )}
          </For>
        )}
      </For>
    </div>
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

function RowStatus(props: { text: string; unloaded?: () => void }) {
  onCleanup(() => props.unloaded?.());
  return <small aria-label="Status">{props.text}</small>;
}

export function RealisticRow(props: { text: string; unloaded?: () => void }) {
  return (
    <article class={props.text ? "flex" : "hidden"}>
      <header>
        <b>Person</b>
        <time>10:00</time>
        <RowStatus text="Ready" unloaded={props.unloaded} />
      </header>
      <div class={{ flex: !!props.text }}>
        <p>{props.text}</p>
        <button type="button" onClick={() => {}}>
          <span>Reply</span>
        </button>
      </div>
      <footer>
        <a href="#status">
          <svg viewBox="0 0 16 16">
            <path d="M0 0h4v4z" />
          </svg>
        </a>
      </footer>
    </article>
  );
}
