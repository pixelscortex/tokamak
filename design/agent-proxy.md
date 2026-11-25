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

| Target (ai-profiles)     | What                                                                                                                                        | Export                             | Paper artboard                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| Subscription card        | Company, plan ("Pro", "Max", "Team", "Enterprise", "Free"), label, enabled, status, the accounts' emails and organisation, models, last use | `listSubscriptions`                | `Profiles · subscriptions`, `Profiles · awaiting sign-in`              |
| "Signed out" on the card | `status: "signed-out"` and the reason ("Claude would not renew the login. Sign in again.")                                                  | `listSubscriptions`, `renewLogins` | not drawn yet                                                          |
| Awaiting sign-in card    | Each sign-in that has not ended: company, the link to open, whether it repairs a subscription                                               | `listSubscriptions`                | `Profiles · awaiting sign-in`                                          |
| Dialog, sign-in step     | The sign-in link (Claude's page with PKCE challenge and `state`)                                                                            | `startSignIn`                      | `Profiles · add · sign-in`, `Profiles · add · sign-in, address pasted` |
| Dialog, connected step   | Plan, email, organisation and models found                                                                                                  | `finishSignIn`                     | `Profiles · add · connected`                                           |
| Dialog lines             | Why a paste or a sign-in failed (`data.message` of each failure)                                                                            | `finishSignIn`                     | not drawn yet                                                          |

## If you change X, check Y

- `SubscriptionView` or `SignInView` (`src/server/_functions.ts`): every field
  is drawn by ai-profiles' cards and dialog; the window tests there stand in for
  these shapes.
- Failure messages in `src/server/claude.ts` and `src/server/signins.ts`: they
  are shown as written, in ai-profiles' dialog and its alert line.
- Plan names (`PLANS` in `claude.ts`): the card title is "Claude " and the plan,
  and the line under the emails repeats it in lower case.
- Model names: ai-profiles drops a leading "Claude " from them, as ai does.

## Primitives used

None.

## Known limits

- **Renewal only when something asks.** A plugin's server code has no timer
  that may use the network, so a login is renewed only when a screen that
  lists subscriptions is open (it asks every minute) or, from TKM-263, when the
  proxy is about to use it. A login nobody asks for can run out; the next ask
  renews it if its refresh token still works.
- **Any plugin that depends on `agent-proxy` acts as the calling member.** Its
  server code can call every export for the person whose call it is handling:
  list their subscriptions and sign-ins (no logins, no verifiers), start,
  finish and cancel their sign-ins, label and switch their subscriptions, and
  trigger renewal. It cannot reach another member's rows, nor any login.
- **Logins sit in ordinary tables.** Whoever can read the server's database can
  read them (no secret store yet, TKM-292). When plugins can hook internal
  functions (Plugin API v2, decision D33), a hook on `logins:read` or
  `logins:fresh` could read logins; logins must move to a secret store, or
  out of hookable functions, before that ships.

## Open questions

- The plan comes from the profile endpoint's `organization.organization_type`
  and `account.has_claude_max` / `has_claude_pro`, which CLIProxyAPI does not
  decode; the values are unconfirmed until the owner signs in with a real
  subscription.
