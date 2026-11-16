// Paged plugin catalog transfers. A server reload can retire the generation that
// a multi-page catalog fetch is reading, so the client must never splice pages
// from two generations together. These use a scripted fake connection because a
// real reload cannot be timed to land between two specific pages.
import { test, expect } from "bun:test";
import { InProcessTransport } from "../src/index.ts";

// Splits a catalog into the 8 KiB-style pages the server sends, but tiny so a
// few pages cover every continuation branch.
function pagesOf(revision, catalog, size = 12) {
  const json = JSON.stringify(catalog),
    pages = [];
  for (let offset = 0; offset < json.length; offset += size) {
    const next = Math.min(json.length, offset + size);
    pages.push({ revision, text: json.slice(offset, next), next, done: next === json.length });
  }
  return pages;
}
const catalogOf = (revision) => ({ revision, plugins: [{ plugin: { id: `p-${revision}` } }], functions: [] });

// `answer(request, index)` returns the `result` of each request, in order.
function fake(answer) {
  const sent = [];
  let deliver;
  const transport = new InProcessTransport({
    send(request) {
      sent.push(request);
      const result = answer(request, sent.length - 1);
      queueMicrotask(() => deliver({ type: "response", id: request.id, result }));
    },
    listen(event) {
      deliver = event;
      return () => {};
    },
    close() {},
  });
  return { transport, sent, types: () => sent.map((request) => request.type) };
}

// Prevents a catalog assembled from two generations. Without the revision pin the
// client concatenates revision A's first page with revision B's second page and
// either throws a JSON error or publishes a catalog that never existed. A mixed
// transfer must restart from page one and return the newer generation intact.
test("a page from a different revision restarts the whole catalog transfer", async () => {
  const stale = pagesOf("A", catalogOf("A")),
    fresh = pagesOf("B", catalogOf("B"));
  let restarted = false;
  const wire = fake((request) => {
    if (request.type === "plugins") {
      const first = restarted ? fresh[0] : stale[0];
      return { Ok: first };
    }
    // The first transfer's second page already belongs to the new generation.
    if (!restarted) {
      restarted = true;
      return { Ok: fresh[1] };
    }
    return { Ok: fresh.find((page) => page.next - page.text.length === request.offset) };
  });
  const result = await wire.transport.plugins();
  expect(result.revision).toBe("B");
  expect(result.plugins[0].plugin.id).toBe("p-B");
  // The abandoned partial transfer is discarded: a second first-page request.
  expect(wire.types().filter((type) => type === "plugins")).toHaveLength(2);
  // Every continuation is pinned to the revision of the page that started it.
  const pinned = wire.sent
    .filter((request) => request.type === "pluginspage")
    .map((request) => request.revision);
  expect(pinned).toEqual(["A", ...Array(pinned.length - 1).fill("B")]);
});

// Prevents trusting pages that agree with each other but not with the assembled
// document: a catalog whose own `revision` differs from the pinned page revision
// was built from another generation and must not be published.
test("an assembled catalog with a different revision restarts the transfer", async () => {
  const lying = pagesOf("A", catalogOf("B")),
    honest = pagesOf("B", catalogOf("B"));
  let attempts = 0;
  const wire = fake((request) => {
    if (request.type === "plugins") attempts++;
    const pages = attempts === 1 ? lying : honest;
    return {
      Ok:
        request.type === "plugins"
          ? pages[0]
          : pages.find((page) => page.next - page.text.length === request.offset),
    };
  });
  expect((await wire.transport.plugins()).revision).toBe("B");
  expect(attempts).toBe(2);
});

// Prevents infinite retry under constant churn. After three attempts the failure
// must surface so the shell can report it, instead of spinning the connection.
test("persistent revision churn rejects after three bounded attempts", async () => {
  let counter = 0;
  const wire = fake((request) => {
    // Every response is a first page of yet another revision.
    const revision = `R${counter++}`;
    return { Ok: pagesOf(revision, catalogOf(revision))[request.type === "plugins" ? 0 : 1] };
  });
  await expect(wire.transport.plugins()).rejects.toThrow("Plugin generation changed");
  expect(wire.types().filter((type) => type === "plugins")).toHaveLength(3);
});

// Prevents a server-side stale-page refusal from being fatal. The server rejects
// a pinned revision it has retired with exactly this message; that is a normal
// reload race, and the client recovers by re-reading the current catalog.
test("a stale-revision refusal from the server restarts the transfer", async () => {
  const stale = pagesOf("A", catalogOf("A")),
    fresh = pagesOf("B", catalogOf("B"));
  let refused = false;
  const wire = fake((request) => {
    if (request.type === "plugins") return { Ok: (refused ? fresh : stale)[0] };
    if (!refused) {
      refused = true;
      return { Err: "Plugin generation changed" };
    }
    return { Ok: fresh.find((page) => page.next - page.text.length === request.offset) };
  });
  expect((await wire.transport.plugins()).revision).toBe("B");
  expect(wire.types().filter((type) => type === "plugins")).toHaveLength(2);
});

// Prevents the retry from masking real failures. Only the generation race may
// restart; any other server error must reach the caller after a single attempt.
test("other server errors are not retried", async () => {
  const wire = fake(() => ({ Err: "catalog unavailable" }));
  await expect(wire.transport.plugins()).rejects.toThrow("catalog unavailable");
  expect(wire.sent).toHaveLength(1);
});
