/** Native transport fixture, NOT the app workflow: observe ordered SDK stream
 * delivery across a real session and surface close events from each observer. */
import { createSignal, onCleanup } from "solid-js";
import { mount, onHostEvent } from "@tokamak/render";
import { createMessageConnection } from "@tokamak/render/connection";
import { InProcessTransport, TokamakClient } from "@tokamak/sdk";
import type { ArgsOf, Event, Request } from "@tokamak/sdk";
import type { PluginLoader, SlotContribution } from "@tokamak/runtime/plugins";
import { Message } from "../src/chat/message";
import { Map } from "../src/chat/map";
import { useMap } from "../src/chat/use-map";
import type { ChatState, Message as ChatMessage } from "../src/chat/use-chat";
import { Markdown } from "../src/chat/markdown";
import { api } from "../dist/tests/todo/backend/_legacyApi";

function Trace() {
  const [markdown, setMarkdown] = createSignal("");
  onHostEvent<string>("markdown:text", setMarkdown);
  const [trace, setTrace] = createSignal<string[]>([]);
  const [firstTitles, setFirstTitles] = createSignal<string[]>([]);
  const [secondTitles, setSecondTitles] = createSignal<string[]>([]);
  const [firstRows, setFirstRows] = createSignal("[]");
  const [secondRows, setSecondRows] = createSignal("[]");
  const [readback, setReadback] = createSignal("[]");
  const [failureReasons, setFailureReasons] = createSignal<string[]>([]);
  const record = (event: string) => setTrace(before => [...before, event]);
  const transport = new InProcessTransport(createMessageConnection<Request, Event>());
  const client = new TokamakClient(transport);
  onCleanup(() => transport.close());
  for (const panel of ["first", "second"]) {
    const stop = client.subscribe(api.todo.list, {}, event => {
      if ("value" in event) {
        const update = panel === "first" ? setFirstTitles : setSecondTitles;
        update(event.value.map(todo => todo.title));
        (panel === "first" ? setFirstRows : setSecondRows)(JSON.stringify(event.value));
      } else {
        setFailureReasons(previous => [...previous, event.error.message]);
      }
      record("value" in event ? panel : `error:${panel}`);
    });
    onCleanup(stop);
  }
  onHostEvent<null>("write", () => {
    void client.mutation(api.todo.add, { title: "Ordered native write" })
      .then(() => record("reply"), () => record("write:error"));
  });
  onHostEvent<string>("write:title", title => {
    void client.mutation(api.todo.add, { title })
      .then(() => record("title:accepted"), error => record(`title:rejected:${String(error)}`));
  });
  onHostEvent<ArgsOf<typeof api.todo.toggle>["id"]>("toggle:id", id => {
    void client.mutation(api.todo.toggle, { id })
      .then(() => record("toggle:accepted"), error => record(`toggle:rejected:${String(error)}`));
  });
  onHostEvent<null>("read", () => {
    void client.query(api.todo.list, {}).then(rows => {
      setReadback(JSON.stringify(rows));
      record("query:reply");
    }, error => record(`query:rejected:${String(error)}`));
  });
  return (
    <div>
      <ToolMessage />
      <PermissionFixture />
      <div id="markdown"><Markdown text={markdown()} /></div>
      <p id="trace">{JSON.stringify(trace())}</p>
      <p id="first-titles">{JSON.stringify(firstTitles())}</p>
      <p id="second-titles">{JSON.stringify(secondTitles())}</p>
      <p id="first-rows">{firstRows()}</p>
      <p id="second-rows">{secondRows()}</p>
      <p id="readback">{readback()}</p>
      <p id="failure-reasons">{JSON.stringify(failureReasons())}</p>
    </div>
  );
}
mount(Trace);

function ToolMessage() {
  const part = { type: "tool" as const, callId: "call-one", plugin: "todo", toolName: "todos.create", args: { title: "Buy milk" }, status: "done" as const, summary: "Created a task in Todo", result: { id: "todo-one" }, view: "todo.card" };
  const [renderers, setRenderers] = createSignal<SlotContribution[]>([]);
  onHostEvent<string>("tool:renderer", plugin => setRenderers(plugin ? [{ plugin, id: "Card", kind: "itemRenderer", options: { type: "todo.card" } }] : []));
  const loader = {
    contributions: () => renderers(), version: () => 0, onError: () => () => {},
    load: async () => ({ Card: (props: { part: unknown; threadId: string }) => <p id="tool-card-props">{JSON.stringify(props)}</p> }),
  } as unknown as PluginLoader;
  const message = { _id: "message-one", role: "assistant", status: "complete", parts: [{ type: "text", text: "Before tool" }, part, { type: "text", text: "After tool" }] } as ChatMessage;

  return <div id="tool-message"><Message loader={loader} threadId="thread-one" message={message} /></div>;
}

function PermissionFixture() {
  const [part, setPart] = createSignal({ type: "permission" as const, requestId: "permission-one", callId: "call-one", title: "Run command",
    options: [{ optionId: "no", name: "Reject", kind: "reject_once" }, { optionId: "yes", name: "Allow once", kind: "allow_once" }],
    status: "pending" as "pending" | "answered", optionId: undefined as string | undefined });
  const chat = {
    threads: { data: () => [{ _id: "running", title: "Running thread", updatedAt: 2 }, { _id: "waiting", title: "Waiting thread", updatedAt: 1 }], loading: () => false },
    runs: () => ({ waiting: { waiting: part().status === "pending" }, running: { waiting: false } }),
  } as unknown as ChatState;
  const map = useMap(chat, () => {});
  const message = () => ({ _id: "permission-message", role: "assistant", status: "streaming", parts: [part()] }) as ChatMessage;
  return <div id="permission-fixture">
    <Message loader={{} as PluginLoader} threadId="waiting" message={message()} onAnswer={(_, optionId) => setPart(before => ({ ...before, status: "answered", optionId }))} />
    <Map chat={chat} map={map} />
  </div>;
}
