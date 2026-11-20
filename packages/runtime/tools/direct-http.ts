import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export const loopback = (host: string) =>
  host === "localhost" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127."));

export type RequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array<ArrayBuffer>;
};

// A fresh socket cannot inherit proxy settings or follow redirects.
export function direct(url: URL, headers: Headers, signal: AbortSignal, { method, body }: RequestOptions) {
  return new Promise<Response>((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(
      url,
      { agent: false, method, headers: Object.fromEntries(headers), signal },
      (incoming) => {
        const status = incoming.statusCode ?? 500;
        const bodyless = status === 204 || status === 205 || status === 304;
        if (bodyless) incoming.resume();
        resolve(
          new Response(bodyless ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), {
            status,
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}
