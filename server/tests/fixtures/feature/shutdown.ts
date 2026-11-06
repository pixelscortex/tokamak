// TKM7 shutdown regression: an awaited write remains uncommitted while real
// synchronous JS occupies the worker. Shutdown must drain it, not abort storage.
import { mutation } from '@tokamak/sdk';

export const slowInsert = mutation({
  handler: async ({ db }) => {
    const id = await db.insert('items', { value: 'accepted before shutdown' });
    const end = Date.now() + 1500;
    while (Date.now() < end) { /* deliberate production-worker occupancy */ }
    return id;
  },
});
