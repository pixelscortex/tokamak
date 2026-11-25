// Keep the HTTP adapter outside the normal action entry and its JSON protocol.
export async function serve(handlers, head, bytes, writeHead, writeChunk) {
  const { context, method, url, headers, pattern } = JSON.parse(head);
  const handler = handlers[pattern];
  if (typeof handler !== "function") throw new Error("HTTP action is missing from its bundle");

  const body = bytes.length ? bytes : undefined;
  const request = new Request(url, {
    method: body ? "POST" : "GET",
    headers,
    body,
  });
  // The inbound method has already been parsed by Hyper. The fetch
  // constructor rejects some valid inbound methods and GET/HEAD bodies.
  request.method = method;
  const response = await handler(context, request);
  if (!(response instanceof Response)) throw new TypeError("HTTP action must return a Response");
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
