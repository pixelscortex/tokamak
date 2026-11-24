// Keep worker pipes and per-worker tables bounded even when a plugin is busy.
export const WORKER_FRAME_BYTES = 1024 * 1024;
export const WORKER_CAPACITY = 128;
// Leave room for operation, invocation and channel envelopes.
export const WORKER_DATA_BYTES = WORKER_FRAME_BYTES - 16 * 1024;
