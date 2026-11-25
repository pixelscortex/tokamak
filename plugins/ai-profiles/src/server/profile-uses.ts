/**
 * The one place this plugin's subscription screens learn about profiles.
 *
 * Profiles (TKM-264) are built in parallel and are not in this checkout yet.
 * The subscription details ("Used by") and the remove confirmation ("taken
 * out of …") read `profilesUsing`, and removing a subscription calls
 * `subscriptionRemoved` in the same transaction. Wiring profiles in is a
 * change to these two bodies only: read the profiles whose ordered
 * subscriptions hold `subscription`, and take it out of each.
 *
 * `agent-proxy` never learns the word "profile": it removes the subscription,
 * and this plugin updates its own profiles.
 */

/** One profile that holds a subscription, as the details and the remove dialog show it. */
export interface ProfileUse {
  readonly id: string;
  /** The 4-character code, such as "ACME". */
  readonly code: string;
  readonly name: string;
  /** How many threads use the profile. */
  readonly threads: number;
}

/** The caller's profiles that hold `subscription` (an agent-proxy subscription id). None yet. */
export async function profilesUsing<C extends { db: unknown }>(
  _ctx: C,
  _subscription: string,
): Promise<ProfileUse[]> {
  return [];
}

/** Takes a removed subscription out of the caller's profiles. Nothing to do yet. */
export async function subscriptionRemoved<C extends { db: unknown }>(
  _ctx: C,
  _subscription: string,
): Promise<void> {}
