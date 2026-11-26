# Agent Proxy

A person's AI subscriptions, their provider accounts, logins and sign-in. It
draws no UI and publishes no parts. What a person sees of it is data it gives
`ai-profiles` through its plugin-only exports (`plugins/agent-proxy/src/server/api.ts`),
drawn by ai-profiles' Profiles screen. It never gives out a login.
No Paper page of its own: its data shows on `App 1:1 · AI profiles plugin`.

## Screens

None.

## Parts it offers

None.

## What it adds to others

| Target (ai-profiles)     | What                                                                                                                                                                                                                                                                                                                                | Export                                                               | Paper artboard                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Subscription card        | Company (`anthropic` or `openai`), plan (Claude: "Pro", "Max", "Team", "Enterprise", "Free"; ChatGPT: Codex's names, such as "Plus", "Business", "Free"; empty while the company has not named it, and never "Free" by guess), label, enabled, status, the accounts' emails and organisation or ChatGPT workspace, models, last use | `listSubscriptions`                                                  | `Profiles · subscriptions`, `Profiles · awaiting sign-in`, `Profiles · Claude and ChatGPT`                      |
| "Signed out" on the card | `status: "signed-out"` and the reason ("Claude would not renew the login. Sign in again.", or the same with "ChatGPT")                                                                                                                                                                                                              | `listSubscriptions`, `renewLogins`                                   | not drawn yet                                                                                                   |
| Awaiting sign-in card    | Each sign-in that has not ended: company, the link to open, whether it repairs a subscription, adds an account (`addTo`) or signs one account in (`repairAccount`)                                                                                                                                                                  | `listSubscriptions`                                                  | `Profiles · awaiting sign-in`                                                                                   |
| Dialog, sign-in step     | The sign-in link (the company's page with PKCE challenge and `state`)                                                                                                                                                                                                                                                               | `startSignIn`                                                        | `Profiles · add · sign-in`, `Profiles · add · sign-in, address pasted`                                          |
| Dialog, connected step   | Plan, email, organisation and models found                                                                                                                                                                                                                                                                                          | `finishSignIn`                                                       | `Profiles · add · connected`                                                                                    |
| Dialog lines             | Why a paste or a sign-in failed (`data.message` of each failure)                                                                                                                                                                                                                                                                    | `finishSignIn`                                                       | not drawn yet                                                                                                   |
| Card action row          | "Check again": plan, account details and models read anew through the subscription's own company; why it failed (`Unreachable`, `SignedOut`)                                                                                                                                                                                        | `checkAgain`                                                         | `Profiles · subscriptions`                                                                                      |
| Subscription details     | Each account's id, email, organisation, status and reason; "Add account" starts a sign-in with `addTo`; "Sign out" and "Sign in" on one account (`repairAccount`)                                                                                                                                                                   | `listSubscriptions`, `addAccount`, `signOutAccount`, `signInAccount` | `Profiles · subscription`, `Profiles · subscription · two accounts`, `Profiles · subscription · one signed out` |
| Remove confirmation      | Removes the subscription, its accounts, their logins and any sign-in waiting for it                                                                                                                                                                                                                                                 | `removeSubscription`                                                 | `Profiles · remove`                                                                                             |

## Claude proxy

The plugin-only `registerSet` export stores an ordered list of subscriptions
owned by the calling member and returns the set id. A caller can replace the
list without changing the id. `turnKey` gives the caller a fresh key and the
set's address under `/plugins/agent-proxy/<set>` on the configured public
origin. The proxy accepts the key only for that set until `endTurnKey` or
expiry. It stores a hash of the key and never returns a provider login.

Each HTTP request tries the enabled Claude subscriptions in set order. It
skips signed-out accounts and those with an active account quota limit and
renews the chosen login if needed. It forwards the request with the
subscription's OAuth headers, streams the answer back and records the last
use. If no Claude account can be used, it names Claude in the error. When a
key is missing or invalid, it names only the problem with the key.

## If you change X, check Y

- `SubscriptionView` or `SignInView` (`src/server/_functions.ts`): every field
  is drawn by ai-profiles' cards and dialog; the window tests there stand in for
  these shapes.
- A subscription's `status` is "ok" while at least one of its accounts is
  signed in, and "signed-out" only when every account is. The card reads the
  subscription's status ("OK", or "Signed out" with "Sign in"); the details
  read each account's own. With two accounts and one signed out, the card says
  "OK" and the details show that one "Signed out" with its own "Sign in".
- Failure kinds of an `addAccount` sign-in (`finishSignIn`): `AlreadyAdded`
  ends it, as for a new subscription; `OtherPlan` and `OtherCompany` keep it
  waiting. ai-profiles' dialog lists the ending kinds (`ENDED`).
- Failure messages in `src/server/claude.ts`, `src/server/openai.ts` and
  `src/server/signins.ts`: they are shown as written, in ai-profiles' dialog
  and its alert line.
- Plan names (`PLANS` in `claude.ts` and `openai.ts`): the card title is the
  product ("Claude", "ChatGPT") and the plan, and the line under the emails
  repeats it in lower case. A plan no read has named is stored empty
  (`reads.ts`, `planKnown`) and shown as no word at all.
- A new company: a module with the `SignInCompany` interface
  (`src/server/company.ts`), an entry in `companies.ts`, the `company` union in
  `schema.ts`, its words and return address in ai-profiles' `lib/companies.ts`,
  and its return port in the desktop listener (`design/shell.md`). Nothing
  else names a company: sign-in (`signins.ts`), renewal (`logins.ts`) and the
  subscription screens' functions (`manage.ts`: "Add account", an account's
  "Sign in", "Check again", the plan check of a second account) all go
  through `companies[subscription.company]`.
- Model names: ai-profiles drops a leading "Claude " from them, as ai does.

## Primitives used

None.

## Known limits

- **Without the desktop app the return address is pasted.** Both companies
  send the browser back to a fixed address on the person's computer: Claude
  to `http://localhost:54545/callback`, ChatGPT to
  `http://localhost:1455/auth/callback`. The server does not listen for it;
  the desktop app does, while the Profiles page is open and a sign-in waits
  (`design/shell.md`), and passes the address to `finishSignIn` as the paste
  field would. Without the desktop app (a plain browser, a Server used from
  another machine, or signing in on another device) the page fails to load and
  the person pastes its address, for both companies.
- **The tables changed shape across TKM-261, 262, 264 and 265, and there is no
  migration.** The SDK has none yet (schema migrations are deferred, and
  declared fields do not validate writes, `packages/sdk/README.md`). Since
  TKM-261: `company` may be `openai`; `accounts` gained `workspace` (ChatGPT's
  account id) and `models`; `signIns` gained `addTo` and `repairAccount`;
  `subscriptions.plan` may be empty (unknown). An early TKM-262 build stored an
  ID token on `logins`; none does now. A store made on an older branch should
  be recreated rather than reused.

- **Sign out is local.** `signOutAccount` (and `removeSubscription`) delete
  the login here; they do not revoke it at the company. A copied refresh token
  would keep working until the company retires it.
- **Any plugin that declares `agent-proxy` can sign out or remove** the
  calling member's subscriptions and accounts, as it can start their
  sign-ins; it never gets a login.
- **Renewal only when something asks.** A plugin's server code has no timer
  that may use the network, so a login is renewed only when a screen that
  lists subscriptions is open (it asks every minute) or when the
  proxy is about to use it. A login nobody asks for can run out; the next ask
  renews it if its refresh token still works.
- **Any plugin that depends on `agent-proxy` acts as the calling member.** Its
  server code can call every export for the person whose call it is handling:
  list their subscriptions and sign-ins (no logins, no verifiers), start,
  finish and cancel their sign-ins, label and switch their subscriptions, add
  an account to one, sign an account out, check one again, remove one, and
  trigger renewal. It can also register sets and issue or end keys for that
  member. It cannot reach another member's rows or read any login.
- **Logins sit in ordinary tables.** Whoever can read the server's database can
  read them (no secret store yet, TKM-292). When plugins can hook internal
  functions (Plugin API v2, decision D33), a hook on `logins:read` or
  `logins:fresh` could read logins; logins must move to a secret store, or
  out of hookable functions, before that ships.

## Open questions

- The Claude proxy works against fake Claude. The owner still needs to
  confirm a Claude Code turn through it on a live subscription.

- ChatGPT's return address is `http://localhost:1455/auth/callback`, as in
  CLIProxyAPI and Codex up to 0.150. Codex 0.170 sends
  `http://127.0.0.1:1455/auth/callback` instead (its PR #47927). Both reach a
  listener on the person's computer; whether OpenAI keeps accepting
  `localhost` for Codex's client id is confirmed only by the owner's real
  sign-in.
- The ChatGPT plan names are Codex's display names ("Pro (More)" for `pro`,
  "Pro" for `prolite`); whether to shorten them is the owner's call.
- The plan comes from the profile endpoint's `organization.organization_type`
  and `account.has_claude_max` / `has_claude_pro`, which CLIProxyAPI does not
  decode; the values are unconfirmed until the owner signs in with a real
  subscription.
