// Keep the HTTP adapter outside the normal action entry and its JSON protocol.
export async function serve(handlers, head, bytes, writeHead, writeChunk, waitForAbort) {
  const { context, method, url, headers, pattern } = JSON.parse(head);
  const handler = handlers[pattern];
  if (typeof handler !== "function") throw new Error("HTTP action is missing from its bundle");

  const controller = new AbortController();
  void waitForAbort().then(() => controller.abort());
  if (context.serverUrl === null) {
    Object.defineProperty(context, "serverUrl", {
      get() {
        throw new Error("Set TOKAMAK_PUBLIC_URL to read ctx.serverUrl on a hosted Server");
      },
    });
  }
  // Avoid a second whole-body copy in Request; only copy slices as JS pulls.
  let offset = 0;
  const body = bytes.length
    ? new ReadableStream({
        pull(stream) {
          const end = Math.min(bytes.length, offset + 65536);
          stream.enqueue(bytes.slice(offset, end));
          offset = end;
          if (offset === bytes.length) stream.close();
        },
      })
    : undefined;
  const request = new Request(url, {
    method: body ? "POST" : "GET",
    headers,
    body,
    signal: controller.signal,
  });
  // The inbound method has already been parsed by Hyper. The fetch
  // constructor rejects some valid inbound methods and GET/HEAD bodies.
  request.method = method;
  const pathname = new URL(request.url).pathname;
  const remainder = pathname.indexOf("/", "/plugins/".length);
  context.path = remainder === -1 ? "/" : pathname.slice(remainder);
  const response = await handler(context, request);
  if (!(response instanceof Response)) throw new TypeError("HTTP action must return a Response");
  if (response.status >= 100 && response.status < 200)
    throw new TypeError("HTTP actions cannot return informational statuses");
  writeHead(JSON.stringify({ status: response.status, headers: [...response.headers] }));
  if (!response.body || method === "HEAD") return;

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!(value instanceof Uint8Array)) throw new TypeError("Response stream must yield Uint8Array");
      writeChunk(value);
    }
  } finally {
    reader.releaseLock();
  }
}
