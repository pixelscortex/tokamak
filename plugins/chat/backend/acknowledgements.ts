export function toolAcknowledgements() {
  const acknowledgements = new Map<string, {
    promise: Promise<unknown>; resolve: (status: unknown) => void; reject: (error: unknown) => void;
  }>();
  const acknowledgement = (callId: string) => {
    let entry = acknowledgements.get(callId);
    if (!entry) {
      let resolve!: (status: unknown) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
      // Validation may reject before execute starts waiting.
      void promise.catch(() => {});
      entry = { promise, resolve, reject };
      acknowledgements.set(callId, entry);
    }
    return entry;
  };

  return { get: acknowledgement, close: () => {
    for (const ack of acknowledgements.values()) ack.reject(new Error("Run ended"));
  } };
}
