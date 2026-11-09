(function (host, network) {
  "use strict";
  const sync = (op, args = {}) => host.op("web.sync", { op, ...args });
  const asyncOp = (op, args) => host.op("web.async", { op, ...args });
  const chunkSize = 65536;
  const effects = () => { if (!network) throw new Error("web effects are only available in actions; fetch is forbidden in queries and mutations"); };
  const unsupported = name => { throw new TypeError(`${name} is not supported by Tokamak web APIs`); };

  class DOMException extends Error {
    constructor(message = "", name = "Error") { super(message); this.name = name; }
  }
  class Event {
    constructor(type) { this.type = String(type); this.target = null; this.defaultPrevented = false; }
    preventDefault() { this.defaultPrevented = true; }
  }
  class EventTarget {
    #listeners = new Map();
    addEventListener(type, callback, options = {}) {
      if (callback == null) return;
      let list = this.#listeners.get(type);
      if (!list) this.#listeners.set(type, list = []);
      if (!list.some(x => x.callback === callback)) list.push({ callback, once: !!options.once });
    }
    removeEventListener(type, callback) {
      this.#listeners.set(type, (this.#listeners.get(type) || []).filter(x => x.callback !== callback));
    }
    dispatchEvent(event) {
      event.target = this;
      let failure;
      for (const item of [...(this.#listeners.get(event.type) || [])]) {
        if (item.once) this.removeEventListener(event.type, item.callback);
        // One throwing application listener must not suppress the listener
        // which cancels native HTTP I/O. Report its error after all listeners.
        try { typeof item.callback === "function" ? item.callback.call(this, event) : item.callback.handleEvent(event); }
        catch (error) { failure ??= { error }; }
      }
      if (failure) throw failure.error;
      return !event.defaultPrevented;
    }
  }
  const signalKey = Symbol();
  class AbortSignal extends EventTarget {
    #aborted = false; #reason;
    constructor(key) { super(); if (key !== signalKey) throw new TypeError("Illegal constructor"); }
    get aborted() { return this.#aborted; }
    get reason() { return this.#reason; }
    throwIfAborted() { if (this.#aborted) throw this.#reason; }
    _abort(reason = new DOMException("The operation was aborted", "AbortError")) {
      if (this.#aborted) return;
      this.#aborted = true; this.#reason = reason;
      this.dispatchEvent(new Event("abort"));
      if (typeof this.onabort === "function") this.onabort(new Event("abort"));
    }
    static abort(reason) { const s = new AbortSignal(signalKey); s._abort(reason); return s; }
    static timeout(ms) { const c = new AbortController(); setTimeout(() => c.abort(new DOMException("The operation timed out", "TimeoutError")), ms); return c.signal; }
    static any(signals) {
      const c = new AbortController();
      const listeners = [];
      for (const s of signals) {
        if (!(s instanceof AbortSignal)) throw new TypeError("Expected AbortSignal");
        if (s.aborted) { c.abort(s.reason); break; }
        const listener = () => c.abort(s.reason);
        listeners.push([s, listener]); s.addEventListener("abort", listener, { once: true });
      }
      const clean = () => { for (const [s,l] of listeners) s.removeEventListener("abort",l); };
      if (c.signal.aborted) clean(); else c.signal.addEventListener("abort", clean, { once: true });
      return c.signal;
    }
  }
  class AbortController {
    #signal = new AbortSignal(signalKey);
    get signal() { return this.#signal; }
    abort(reason) { this.#signal._abort(reason); }
  }

  class TextEncoder {
    get encoding() { return "utf-8"; }
    encode(text = "") { return new Uint8Array(sync("encode", { text: String(text).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,"\uFFFD") })); }
    encodeInto(text, destination) {
      if (!(destination instanceof Uint8Array)) throw new TypeError("Expected Uint8Array");
      let read = 0, written = 0;
      for (const c of String(text)) {
        const bytes = this.encode(c);
        if (written + bytes.length > destination.length) break;
        destination.set(bytes, written); written += bytes.length; read += c.length;
      }
      return { read, written };
    }
  }
  const byteView = value => {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError("Expected an ArrayBuffer or typed array");
  };
  const closeDecoder = Symbol();
  class TextDecoder {
    #id;
    constructor(label = "utf-8", options = {}) {
      this.encoding = String(label).toLowerCase(); this.fatal = !!options.fatal; this.ignoreBOM = !!options.ignoreBOM;
      // Validate even before the first decode, without retaining a native slot.
      const id = sync("decoder", { label: this.encoding, ignoreBOM: this.ignoreBOM }); sync("closeDecoder", { id });
    }
    [closeDecoder]() {
      if (this.#id !== undefined) { sync("closeDecoder", { id: this.#id }); this.#id = undefined; }
    }
    decode(input = new Uint8Array(), options = {}) {
      let keep = false;
      try {
        const bytes = byteView(input);
        this.#id ??= sync("decoder", { label: this.encoding, ignoreBOM: this.ignoreBOM });
        let output = "";
        for (let offset = 0; offset < bytes.length || offset === 0; offset += chunkSize) {
          const last = offset + chunkSize >= bytes.length && !options.stream;
          output += sync("decode", { id: this.#id, bytes: Array.from(bytes.subarray(offset, offset + chunkSize)), last, fatal: this.fatal });
        }
        keep = !!options.stream;
        return output;
      } finally {
        // Fatal decoding and invalid inputs reset streaming state too.
        if (!keep) this[closeDecoder]();
      }
    }
  }
  class TextDecoderStream {
    constructor(label, options) {
      const decoder = new TextDecoder(label, options);
      this.encoding = decoder.encoding; this.fatal = decoder.fatal; this.ignoreBOM = decoder.ignoreBOM;
      const stream = new TransformStream({
        transform(chunk, controller) {
          try { const text = decoder.decode(chunk, { stream: true }); if (text) controller.enqueue(text); }
          catch (e) { decoder[closeDecoder](); throw e; }
        },
        flush(controller) { const text = decoder.decode(); if (text) controller.enqueue(text); },
        cancel() { decoder[closeDecoder](); },
      });
      this.readable = stream.readable; this.writable = stream.writable;
    }
  }
  const formEncode = value => encodeURIComponent(value).replace(/%20/g,"+").replace(/[!'()~]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const formDecode = value => { try { return decodeURIComponent(value.replace(/\+/g," ")); } catch { return value.replace(/\+/g," "); } };
  const replaceParams = Symbol();
  class URLSearchParams {
    #pairs = []; #change;
    constructor(init = "", change) {
      this.#change = change; this[replaceParams](init);
    }
    [replaceParams](init) {
      this.#pairs = [];
      if (typeof init === "string") {
        for (const pair of init.replace(/^\?/,"").split("&")) if (pair) {
          const i = pair.indexOf("="); this.#pairs.push([formDecode(i < 0 ? pair : pair.slice(0,i)), formDecode(i < 0 ? "" : pair.slice(i+1))]);
        }
      } else for (const pair of (init[Symbol.iterator] ? init : Object.entries(init))) {
        if (pair.length !== 2) throw new TypeError("Expected key/value pair");
        this.#pairs.push(pair.map(String));
      }
    }
    get size() { return this.#pairs.length; }
    append(k,v) { this.#pairs.push([String(k),String(v)]); this.#change?.(this.toString()); }
    delete(k,v) { this.#pairs = this.#pairs.filter(p=>p[0]!==String(k)||(v!==undefined&&p[1]!==String(v))); this.#change?.(this.toString()); }
    get(k) { return this.#pairs.find(p=>p[0]===String(k))?.[1] ?? null; }
    getAll(k) { return this.#pairs.filter(p=>p[0]===String(k)).map(p=>p[1]); }
    has(k,v) { return this.#pairs.some(p=>p[0]===String(k)&&(v===undefined||p[1]===String(v))); }
    set(k,v) { const i = this.#pairs.findIndex(p=>p[0]===String(k)); this.delete(k); this.#pairs.splice(i<0?this.#pairs.length:i,0,[String(k),String(v)]); this.#change?.(this.toString()); }
    sort() { this.#pairs.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0); this.#change?.(this.toString()); }
    *entries() { for (const p of this.#pairs) yield [...p]; }
    *keys() { for (const p of this.#pairs) yield p[0]; }
    *values() { for (const p of this.#pairs) yield p[1]; }
    [Symbol.iterator]() { return this.entries(); }
    forEach(fn, arg) { for (const [k,v] of this) fn.call(arg,v,k,this); }
    toString() { return this.#pairs.map(p=>p.map(formEncode).join("=")).join("&"); }
  }
  class URL {
    #parts; #params;
    constructor(url, base) { this.#parts = sync("url", { url: String(url), ...(base === undefined ? {} : { base: String(base) }) }); }
    get href() { return this.#parts.href; }
    set href(value) { this.#update(sync("url", { url: String(value) })); }
    get origin() { return this.#parts.origin; }
    get searchParams() { return this.#params ??= new URLSearchParams(this.search, s => { this.#parts = sync("url", { url: this.href, set: "search", value: s }); }); }
    _get(k) { return this.#parts[k]; }
    #update(parts) {
      this.#parts = parts;
      // Retained references stay linked after either search or href changes.
      // Replace the pairs without firing the reverse URL-update callback.
      this.#params?.[replaceParams](parts.search);
    }
    _set(k,v) { this.#update(sync("url", { url: this.href, set:k, value:String(v) })); }
    toString() { return this.href; }
    toJSON() { return this.href; }
    static canParse(url, base) { try { new URL(url,base); return true; } catch { return false; } }
    static parse(url,base) { try { return new URL(url,base); } catch { return null; } }
  }
  for (const key of ["protocol","host","hostname","port","pathname","search","hash","username","password"]) Object.defineProperty(URL.prototype,key,{get(){return this._get(key);},set(v){this._set(key,v);}});
  const headerName = name => { name = String(name).toLowerCase(); if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) throw new TypeError("Invalid header name"); return name; };
  const headerValue = value => { value = String(value).trim(); if (/[\r\n\0]/.test(value)) throw new TypeError("Invalid header value"); return value; };
  class Headers {
    #values = new Map();
    constructor(init = []) { for (const [k,v] of (init[Symbol.iterator] ? init : Object.entries(init))) this.append(k,v); }
    append(k,v) { k = headerName(k); v = headerValue(v); this.#values.set(k,this.#values.has(k)?`${this.#values.get(k)}, ${v}`:v); }
    set(k,v) { this.#values.set(headerName(k),headerValue(v)); }
    get(k) { return this.#values.get(headerName(k)) ?? null; }
    has(k) { return this.#values.has(headerName(k)); }
    delete(k) { this.#values.delete(headerName(k)); }
    *entries() { yield* [...this.#values].sort((a,b)=>a[0]<b[0]?-1:1); }
    *keys() { for (const [k] of this) yield k; }
    *values() { for (const [,v] of this) yield v; }
    [Symbol.iterator]() { return this.entries(); }
    forEach(fn,arg) { for (const [k,v] of this) fn.call(arg,v,k,this); }
    getSetCookie() { return this.has("set-cookie") ? [this.get("set-cookie")] : []; }
  }
  const bodyStream = (body, headers) => {
    if (body == null) return null;
    if (body instanceof ReadableStream) {
      if (body.locked || body._disturbed) throw new TypeError("Body has already been consumed");
      return body;
    }
    let bytes;
    if (typeof body === "string" || body instanceof URLSearchParams) {
      if (!headers.has("content-type")) headers.set("content-type", body instanceof URLSearchParams ? "application/x-www-form-urlencoded;charset=UTF-8" : "text/plain;charset=UTF-8");
      bytes = new TextEncoder().encode(String(body));
    } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) bytes = byteView(body).slice();
    else unsupported("body type");
    let offset = 0;
    return new ReadableStream({ pull(c) { if (offset >= bytes.length) { c.close(); return; } c.enqueue(bytes.slice(offset,offset+chunkSize)); offset += chunkSize; } });
  };
  class Body {
    constructor(body, headers) { this.headers = new Headers(headers); this.body = bodyStream(body,this.headers); }
    // The pinned streams polyfill owns disturbance tracking, including direct
    // readers, cancellation, tee, piping and async iteration. Do not duplicate
    // that state only in the convenience body readers or the fetch pump.
    get bodyUsed() { return !!this.body && (this.body.locked || this.body._disturbed); }
    async bytes() {
      if (this.bodyUsed || this.body?.locked) throw new TypeError("Body has already been consumed");
      if (!this.body) return new Uint8Array();
      const reader = this.body.getReader(); const chunks = []; let length = 0;
      try { while (true) { const {done,value} = await reader.read(); if (done) break; const b = byteView(value); chunks.push(b); length += b.length; } }
      catch (e) { reader.cancel(e).catch(()=>{}); throw e; }
      finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length); let offset = 0; for (const b of chunks) { bytes.set(b,offset); offset += b.length; } return bytes;
    }
    async arrayBuffer() { return (await this.bytes()).buffer; }
    async text() { return new TextDecoder().decode(await this.bytes()); }
    async json() { return JSON.parse(await this.text()); }
    blob() { unsupported("Blob"); }
    formData() { unsupported("FormData"); }
    _cloneBody() { if (this.bodyUsed || this.body?.locked) throw new TypeError("Body has already been consumed"); if (!this.body) return null; const [a,b] = this.body.tee(); this.body = a; return b; }
  }
  class Request extends Body {
    constructor(input, init = {}) {
      const source = input instanceof Request ? input : null;
      const sourceBody = init.body == null ? source?.body : null;
      super(init.body ?? sourceBody,init.headers ?? source?.headers);
      this.url = new URL(source ? source.url : String(input)).href;
      this.method = String(init.method ?? source?.method ?? "GET").toUpperCase();
      if (!/^[A-Z]+$/.test(this.method) || ["CONNECT","TRACE","TRACK"].includes(this.method)) throw new TypeError("Unsupported request method");
      if (["GET","HEAD"].includes(this.method) && this.body) throw new TypeError("GET/HEAD cannot have a body");
      this.signal = init.signal ?? source?.signal ?? new AbortController().signal;
      if (!(this.signal instanceof AbortSignal)) throw new TypeError("Expected AbortSignal");
      this.redirect = init.redirect ?? source?.redirect ?? "follow";
      if (!["follow","manual","error"].includes(this.redirect)) throw new TypeError("Invalid redirect mode");
      for (const key of Object.keys(init)) if (!["method","headers","body","signal","redirect","duplex"].includes(key)) unsupported(`Request.${key}`);
      if (init.duplex !== undefined && init.duplex !== "half") unsupported("Request.duplex");
      // Transfer through a proxy stream: constructing from a Request makes its
      // original body unusable immediately, even before fetch starts the upload.
      if (sourceBody) this.body = sourceBody.pipeThrough(new TransformStream());
    }
    clone() { return new Request(this,{body:this._cloneBody()}); }
  }
  class Response extends Body {
    constructor(body = null, init = {}) {
      super(body,init.headers); this.status = init.status ?? 200; this.statusText = init.statusText ?? ""; this.url = init.url ?? ""; this.redirected = !!init.redirected; this.type = "basic";
      if (this.status < 200 || this.status > 599) throw new RangeError("Invalid response status");
      if ([204,205,304].includes(this.status) && this.body) throw new TypeError("This response status cannot have a body");
    }
    get ok() { return this.status >= 200 && this.status < 300; }
    clone() { return new Response(this._cloneBody(),this); }
    static json(data, init = {}) { const headers = new Headers(init.headers); if (!headers.has("content-type")) headers.set("content-type","application/json"); return new Response(JSON.stringify(data),{...init,headers}); }
    static redirect(url, status = 302) { if (![301,302,303,307,308].includes(status)) throw new RangeError("Invalid redirect status"); return new Response(null,{status,headers:{location:new URL(url).href}}); }
  }

  async function fetch(input, init) {
    effects();
    const request = new Request(input,init);
    try { return await fetchRequest(request); }
    catch (e) {
      // Abort/permission failures can happen before an exchange or upload reader
      // exists. Cancel the transferred body too, including native fetch sources.
      // Do not await: a tee branch can wait for its sibling's cancellation.
      if (request.body && !request.body.locked) request.body.cancel(e).catch(()=>{});
      throw e;
    }
  }
  async function fetchRequest(request) {
    for (let redirects = 0; ; redirects++) {
      request.signal.throwIfAborted();
      const id = sync("open", { url:request.url, stream:!!request.body });
      let controller, reader, finished = false;
      const cancel = reason => {
        // An upload can still be running after the response has completed.
        reader?.cancel(reason).catch(()=>{});
        if (finished) return;
        finished = true; sync("cancel", {id});
        if (controller) { try { controller.error(reason); } catch {} }
        request.signal.removeEventListener("abort",onAbort);
      };
      const onAbort = () => cancel(request.signal.reason);
      const close = () => { finished = true; reader?.cancel().catch(()=>{}); request.signal.removeEventListener("abort",onAbort); };
      request.signal.addEventListener("abort",onAbort,{once:true});
      // Both futures stay on the world's executor. A one-chunk native channel
      // applies backpressure without buffering the upload or spawning a task.
      const send = asyncOp("send", {id,url:request.url,method:request.method,headers:[...request.headers]});
      const pump = (async () => {
        if (!request.body) return;
        reader = request.body.getReader();
        try {
          while (true) {
            const {done,value} = await reader.read(); if (done) break;
            const bytes = byteView(value);
            for (let offset = 0; offset < bytes.length; offset += chunkSize) await asyncOp("write", {id,bytes:Array.from(bytes.subarray(offset,offset+chunkSize))});
          }
          sync("finish", {id});
        } catch (e) { cancel(e); throw e; }
        finally { reader.releaseLock(); reader = undefined; }
      })();
      pump.catch(()=>{});
      try {
        const info = await send;
        // Do not wait for the upload: servers may respond before consuming it.
        const headers = new Headers(info.headers);
        if ([301,302,303,307,308].includes(info.status) && headers.has("location") && request.redirect !== "manual") {
          cancel(new DOMException("Redirected", "AbortError"));
          if (request.redirect === "error") throw new TypeError("fetch redirect rejected");
          if (redirects >= 20) throw new TypeError("fetch exceeded redirect limit");
          const next = new URL(headers.get("location"),request.url);
          if (next.origin !== new URL(request.url).origin) for (const name of ["authorization","proxy-authorization","cookie"]) request.headers.delete(name);
          const changeMethod = (info.status === 303 && request.method !== "HEAD") || ([301,302].includes(info.status) && request.method === "POST");
          if (request.body && !changeMethod) unsupported("redirect replay of a streamed request body");
          if (changeMethod) { request.headers.delete("content-type"); request.headers.delete("content-length"); }
          request = new Request(next,{method:changeMethod?"GET":request.method,headers:request.headers,signal:request.signal,redirect:request.redirect});
          continue;
        }
        let body = null;
        if (request.method === "HEAD" || [204,205,304].includes(info.status)) { sync("cancel",{id}); close(); }
        else body = new ReadableStream({
          start(c) { controller = c; if (request.signal.aborted) onAbort(); },
          async pull(c) {
            try {
              request.signal.throwIfAborted();
              const bytes = await asyncOp("read",{id});
              if (bytes === null) { close(); c.close(); }
              else c.enqueue(new Uint8Array(bytes));
            } catch (e) { cancel(request.signal.aborted ? request.signal.reason : e); }
          },
          cancel(reason) { cancel(reason); },
        },{highWaterMark:0});
        return new Response(body,{...info,headers,redirected:redirects>0});
      } catch (e) { cancel(e); throw request.signal.aborted ? request.signal.reason : e; }
    }
  }
  const timers = new Map();
  function schedule(callback, delay, repeat, args) {
    effects(); if (typeof callback !== "function") throw new TypeError("Timer callback must be a function");
    // Coercion can run application code and throw; allocate only after it succeeds.
    const ms = Math.min(2147483647,Math.max(0,Math.trunc(Number(delay)||0)));
    const handle = sync("timer"); const entry = {native:handle}; timers.set(handle,entry);
    const tick = async () => {
      const fired = await asyncOp("sleep",{id:entry.native,ms});
      if (!fired || !timers.has(handle)) return;
      if (!repeat) timers.delete(handle);
      try { callback(...args); } finally {
        if (repeat && timers.has(handle)) { entry.native = sync("timer"); tick().catch(() => clearTimer(handle)); }
      }
    };
    tick().catch(() => clearTimer(handle)); return handle;
  }
  function clearTimer(id) { const entry = timers.get(id); if (entry) { timers.delete(id); sync("clearTimer",{id:entry.native}); } }
  const crypto = {
    getRandomValues(array) {
      effects();
      if (!ArrayBuffer.isView(array) || array instanceof DataView || array instanceof Float32Array || array instanceof Float64Array) throw new TypeError("getRandomValues requires an integer typed array");
      const bytes = byteView(array); if (bytes.length > chunkSize) throw new DOMException("getRandomValues quota exceeded", "QuotaExceededError");
      bytes.set(sync("random",{size:bytes.length})); return array;
    },
    randomUUID() {
      const b = this.getRandomValues(new Uint8Array(16)); b[6] = (b[6]&15)|64; b[8] = (b[8]&63)|128;
      const h = Array.from(b,x=>x.toString(16).padStart(2,"0")).join(""); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
    },
    get subtle() { return unsupported("crypto.subtle"); },
  };
  Object.assign(globalThis,{DOMException,Event,EventTarget,AbortSignal,AbortController,TextEncoder,TextDecoder,TextDecoderStream,URLSearchParams,URL,Headers,Request,Response,fetch:network?fetch:()=>effects(),crypto,
    setTimeout:(fn,ms,...args)=>schedule(fn,ms,false,args),setInterval:(fn,ms,...args)=>schedule(fn,ms,true,args),clearTimeout:clearTimer,clearInterval:clearTimer,
  });
  for (const name of ["WebSocket","XMLHttpRequest","Blob","File","FormData","Worker","EventSource","TextEncoderStream"]) Object.defineProperty(globalThis,name,{configurable:true,get:()=>unsupported(name)});
})
