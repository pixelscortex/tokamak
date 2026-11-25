import { productOf, type Subscription } from "./api";

/**
 * "Claude Pro": the card's and the connected step's title. A plan the company
 * did not name is stored empty and the title is the product alone ("ChatGPT").
 */
export const titleOf = (subscription: Pick<Subscription, "company" | "plan">) =>
  [productOf[subscription.company], subscription.plan].filter(Boolean).join(" ");

/**
 * The data line under the emails: "fake organization · pro" (Paper sets it in
 * lower case). An unknown plan adds no word here, as in the title: the quiet
 * "plan unknown" sits beside the card's "Check again" (`card-actions.tsx`).
 */
export function planLine(subscription: Subscription): string {
  const organization = subscription.accounts.find((account) => account.organization)?.organization;
  return [organization, subscription.plan].filter(Boolean).join(" · ").toLowerCase();
}

/** A model as people know it: Claude's own names lead with "Claude ", which the logo already says. */
export const modelName = (name: string) => name.replace(/^Claude\s+/, "");

export const countOf = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** When a subscription last carried a turn: "now", "12m ago", "3h ago", "3d ago". */
export function lastUse(at: number | undefined, now: number): string {
  if (at === undefined) return "not used yet";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
