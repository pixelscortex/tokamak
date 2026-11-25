import { render } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import { expect, test } from "vitest";
import { after, ExtensionProvider } from "../../client";
import { BenchmarkRow } from "./fixtures/parts/owner/src/client/api";
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

const messages = Array.from({ length: 1000 }, (_, i) => `Message ${i}`);
const empty = host([]);
const gc = (globalThis as { gc?: () => void }).gc;
// Use CPU time for the assertions so a shared test runner being descheduled
// cannot make a sub-millisecond insertion look like a regression.
const usage = process.threadCpuUsage ?? process.cpuUsage;
const cpuMs = ({ user, system }: ReturnType<typeof usage>) => (user + system) / 1000;

function measure(Row: typeof PlainRow) {
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
  const bytes = (process.memoryUsage().heapUsed - heap) / 8000;
  expect(root.querySelectorAll("article")).toHaveLength(1000);
  dispose();
  return { ms, cpu, bytes };
}

test("unextended screen parts stay close to plain JSX mount cost", () => {
  measure(PlainRow);
  measure(BenchmarkRow);
  const plain: ReturnType<typeof measure>[] = [];
  const parts: ReturnType<typeof measure>[] = [];
  for (let i = 0; i < 7; i++) {
    if (i % 2) parts.push(measure(BenchmarkRow));
    plain.push(measure(PlainRow));
    if (!(i % 2)) parts.push(measure(BenchmarkRow));
  }
  const median = (samples: typeof plain, key: "ms" | "cpu" | "bytes") =>
    samples.map((x) => x[key]).sort((a, b) => a - b)[3]!;
  const ratio = median(parts, "cpu") / median(plain, "cpu");
  console.log("parts mount", {
    plain: median(plain, "ms"),
    parts: median(parts, "ms"),
    wallRatio: median(parts, "ms") / median(plain, "ms"),
    cpuRatio: ratio,
    extraBytesPerElement: gc && Math.round(median(parts, "bytes") - median(plain, "bytes")),
  });
  expect(ratio).toBeLessThan(1.5);
}, 20_000);

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
