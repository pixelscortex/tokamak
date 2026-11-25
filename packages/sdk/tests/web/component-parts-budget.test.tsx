import { render } from "@solidjs/web";
import { createSignal, flush, onCleanup } from "solid-js";
import { expect, test } from "vitest";
import { after, ExtensionProvider } from "../../client";
import { BenchmarkRow, RealisticRow } from "./fixtures/parts/owner/src/client/api";
import { parts } from "./fixtures/parts/owner/src/client/_generated/components";
import { host, layer } from "./fixtures/parts/extension-host";

function PlainRow(props: { text: string }) {
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

function PlainRealisticRow(props: { text: string; unloaded?: () => void }) {
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

const messages = Array.from({ length: 1000 }, (_, i) => `Message ${i}`);
const empty = host([]);
const gc = (globalThis as { gc?: () => void }).gc;
// Use CPU time for the assertions so a shared test runner being descheduled
// cannot make a sub-millisecond insertion look like a regression.
const usage = process.threadCpuUsage ?? process.cpuUsage;
const cpuMs = ({ user, system }: ReturnType<typeof usage>) => (user + system) / 1000;

function measure(Row: typeof PlainRow, count: number) {
  gc?.();
  const heap = process.memoryUsage().heapUsed;
  const root = document.createElement("div");
  const start = performance.now();
  const cpuStart = usage();
  const dispose = render(
    () => (
      <ExtensionProvider host={empty}>
        {messages.map((text) => (
          <Row text={text} />
        ))}
      </ExtensionProvider>
    ),
    root,
  );
  flush();
  const ms = performance.now() - start;
  const cpu = cpuMs(usage(cpuStart));
  gc?.();
  const bytes = (process.memoryUsage().heapUsed - heap) / (1000 * count);
  expect(root.querySelectorAll("article")).toHaveLength(1000);
  dispose();
  return { ms, cpu, bytes };
}

test.each([
  { name: "closed", plainRow: PlainRow, row: BenchmarkRow, count: 8 },
  { name: "realistic", plainRow: PlainRealisticRow, row: RealisticRow, count: 13 },
])(
  "$name unextended screen parts stay close to plain JSX mount cost",
  ({ name, plainRow, row, count }) => {
    measure(plainRow, count);
    measure(row, count);
    const plain: ReturnType<typeof measure>[] = [];
    const parts: ReturnType<typeof measure>[] = [];
    for (let i = 0; i < 7; i++) {
      if (i % 2) parts.push(measure(row, count));
      plain.push(measure(plainRow, count));
      if (!(i % 2)) parts.push(measure(row, count));
    }
    const median = (samples: typeof plain, key: "ms" | "cpu" | "bytes") =>
      samples.map((x) => x[key]).sort((a, b) => a - b)[3]!;
    const ratio = median(parts, "cpu") / median(plain, "cpu");
    console.log("parts mount", {
      name,
      plain: median(plain, "ms"),
      parts: median(parts, "ms"),
      wallRatio: median(parts, "ms") / median(plain, "ms"),
      cpuRatio: ratio,
      extraBytesPerElement: gc && Math.round(median(parts, "bytes") - median(plain, "bytes")),
    });
    expect(ratio).toBeLessThan(1.5);
  },
  20_000,
);

test("loading an addition for another path leaves 7500 mounted elements alone", async () => {
  const [layers, setLayers] = createSignal<ReturnType<typeof layer>[]>([]);
  const button = parts.Labels.section.button;
  const addon = layer(
    "After",
    after(button, () => "unrelated"),
    "after",
    button,
  );
  let loads = 0;
  const root = document.createElement("div");
  const dispose = render(
    () => (
      <ExtensionProvider
        host={{
          ...empty,
          contributions: (kind) => host(layers()).contributions(kind),
          async load() {
            loads++;
            return { After: addon.export };
          },
        }}
      >
        {messages.slice(0, 938).map((text) => (
          <BenchmarkRow text={text} />
        ))}
      </ExtensionProvider>
    ),
    root,
  );
  try {
    const first = root.firstElementChild;
    const start = performance.now();
    const cpuStart = usage();
    setLayers([addon]);
    flush();
    await Promise.resolve();
    flush();
    const ms = performance.now() - start;
    const cpu = cpuMs(usage(cpuStart));
    console.log("unrelated parts load", { ms, cpu });
    expect(loads).toBe(1);
    expect(root.firstElementChild).toBe(first);
    expect(cpu).toBeLessThan(5);
  } finally {
    dispose();
  }
});
