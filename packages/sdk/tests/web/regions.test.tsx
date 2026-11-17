import { expect, test } from "vitest";
import { createContext, createSignal, Errored, flush, Show, useContext } from "solid-js";
import { render } from "@solidjs/web";
import {
  Region,
  RegionOutlet,
  RegionProvider,
  usePageTitle,
  usePageTitleValue,
  useRegionFilled,
} from "../../client";

test("regions retain view context, append in mount order, and retire with the view", () => {
  const Context = createContext("missing");
  const [visible, setVisible] = createSignal(true);
  const [text, setText] = createSignal("view context");
  const root = document.createElement("div");
  const Content = () => (
    <span>
      {useContext(Context)}:{text()}
    </span>
  );
  let filled!: () => boolean;
  const Shell = () => {
    filled = useRegionFilled("sidebar");
    return (
      <>
        <RegionOutlet name="sidebar" class="text-label" />
        <Show when={visible()}>
          <Context value="provided">
            <Region.Sidebar>
              <Content />
            </Region.Sidebar>
            <Region.Sidebar>
              <span>second</span>
            </Region.Sidebar>
          </Context>
        </Show>
      </>
    );
  };
  const dispose = render(
    () => (
      <RegionProvider>
        <Shell />
      </RegionProvider>
    ),
    root,
  );
  try {
    flush();
    const outlet = root.querySelector('[data-region="sidebar"]')!;
    expect(outlet.className).toBe("text-label");
    expect(outlet.textContent).toBe("provided:view contextsecond");
    expect(filled()).toBe(true);
    setText("updated");
    flush();
    expect(outlet.textContent).toBe("provided:updatedsecond");
    setVisible(false);
    flush();
    expect(outlet.textContent).toBe("");
    expect(filled()).toBe(false);
  } finally {
    dispose();
  }
});

test("regions wait for late outlets, including an outlet conditional on filled state", () => {
  const [outlet, setOutlet] = createSignal(false);
  const root = document.createElement("div");
  const Shell = () => {
    const filled = useRegionFilled("panel");
    return (
      <>
        <Region.Panel>
          <span>panel content</span>
        </Region.Panel>
        <Show when={outlet() && filled()}>
          <RegionOutlet name="panel" />
        </Show>
      </>
    );
  };
  const dispose = render(
    () => (
      <RegionProvider>
        <Shell />
      </RegionProvider>
    ),
    root,
  );
  try {
    flush();
    expect(root.textContent).toBe("");
    setOutlet(true);
    flush();
    expect(root.querySelector('[data-region="panel"]')?.textContent).toBe("panel content");
    setOutlet(false);
    flush();
    expect(root.textContent).toBe("");
    setOutlet(true);
    flush();
    expect(root.textContent).toBe("panel content");
  } finally {
    dispose();
  }
});

test("regions without a provider render nothing", () => {
  const root = document.createElement("div");
  let filled!: () => boolean;
  const View = () => {
    filled = useRegionFilled("header");
    return (
      <Region.Header>
        <span>hidden</span>
      </Region.Header>
    );
  };
  const dispose = render(() => <View />, root);
  try {
    flush();
    expect(root.textContent).toBe("");
    expect(filled()).toBe(false);
  } finally {
    dispose();
  }
});

test("region failures reach the view error boundary", () => {
  const root = document.createElement("div");
  const Broken = () => {
    throw new Error("region failure");
  };
  const dispose = render(
    () => (
      <RegionProvider>
        <RegionOutlet name="header" />
        <Errored fallback={() => <p>view fallback</p>}>
          <Region.Header>
            <Broken />
          </Region.Header>
        </Errored>
      </RegionProvider>
    ),
    root,
  );
  try {
    flush();
    expect(root.textContent).toBe("view fallback");
  } finally {
    dispose();
  }
});

test("a view names its page while mounted; the newest named view wins and blank falls back", () => {
  const [inner, setInner] = createSignal(true);
  const [name, setName] = createSignal("Fix the cache");
  let title!: () => string | undefined;
  const Shell = () => {
    title = usePageTitleValue();
    return (
      <Show when={true}>
        <Named title={() => "Chat"} />
        <Show when={inner()}>
          <Named title={name} />
        </Show>
      </Show>
    );
  };
  const Named = (props: { title: () => string | undefined }) => {
    usePageTitle(props.title);
    return null;
  };
  const dispose = render(
    () => (
      <RegionProvider>
        <Shell />
      </RegionProvider>
    ),
    document.createElement("div"),
  );
  try {
    flush();
    expect(title()).toBe("Fix the cache");
    setName("Rename the thread");
    flush();
    expect(title()).toBe("Rename the thread");
    setName("  ");
    flush();
    expect(title()).toBe("Chat");
    setInner(false);
    flush();
    expect(title()).toBe("Chat");
  } finally {
    dispose();
  }
});
