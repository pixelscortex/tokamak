# AI Profiles

The Profiles screen: a page of its own in the rail. Today it draws the
Subscriptions section and the add-subscription dialog; the Profiles section
(TKM-264), the subscription and profile details and the picker column come
with later tickets. Subscriptions are `agent-proxy`'s data
(`design/agent-proxy.md`); company logos are the marks of the `claude` and
`codex` agent plugins, read from ai's agent list on this computer.
Paper page: `App 1:1 · AI profiles plugin`. Drawn from the owner's
"Flow · Profiles (proposal)" artboards `1 · Profiles · screen` and `2a` to `2d`.

## Screens

| Screen                                                                                  | Source                                                                          | Paper artboard                             |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| Profiles with one subscription card                                                     | `plugins/ai-profiles/src/client/pages/profiles.tsx`, `ui/subscription-card.tsx` | `Profiles · subscriptions`                 |
| The same with a sign-in left waiting: the "Awaiting sign-in" card                       | `ui/subscription-card.tsx` (`AwaitingCard`)                                     | `Profiles · awaiting sign-in`              |
| Dialog, step 1: company (Anthropic; OpenAI and "More later" listed, not offered)        | `ui/add-dialog.tsx` (`CompanyStep`)                                             | `Profiles · add · company`                 |
| Dialog, step 2: method for Anthropic ("Claude subscription"; "API key", marked "Later") | `ui/add-dialog.tsx` (`MethodStep`)                                              | `Profiles · add · method`                  |
| Dialog, step 3: sign-in, the address field shown, "Signed in on another device?" folded | `ui/add-dialog.tsx` (`SignInStep`)                                              | `Profiles · add · sign-in`                 |
| Dialog, step 3 with an address pasted and the other-device note open                    | `ui/add-dialog.tsx` (`SignInStep`)                                              | `Profiles · add · sign-in, address pasted` |
| Dialog, step 4: connected, plan, email, models, label                                   | `ui/add-dialog.tsx` (`ConnectedStep`)                                           | `Profiles · add · connected`               |

Not drawn yet: no subscriptions ("No subscriptions yet…"), a "Signed out" card
with "Sign in", a refused or wrong paste (the line under the field, the sign-in
still waiting), an ended sign-in ("Start again"), an expired one (card and
dialog), "Awaiting sign-in again" for a repair, the "Copied" state of Copy
link, "That sign-in was cancelled in another window.", and a plain browser
(neutral company marks). The window tests cover each of them.

Measured on the owner's artboards and kept: the column is 1220 wide and
centred (`max-w-profiles`, a token in this plugin's `styles.css`), 24 from
the header, 12 between rows; four cards across, 12 apart; a card is radius 12,
16 in, on the tray tone; logo 24 with 12 to the title; emails and the plan line
in data mono; "Signed out" in warn with a ghost `sm` "Sign in". The pending
card is an edge ring with an 18 px logo on a 32 px card-tone tile. The dialog
is 440 wide, 24 in, 20 between its parts; four 24 × 4 step pills 4 apart; the
title is `text-read` semibold; the address field is `Input` `md` `mono` with an
`sm` ghost "Continue" beside it, the label field `Input` `lg`.

Decided here, not drawn (or not on the scale): a card's gap is 12 (drawn 14)
and its height follows the tallest card in its row (drawn 236); icon-to-text
gaps are 8 (drawn 6); the pending card's 6 px dot is the 12 px waiting
spinner, as on the dialog's waiting line, and the card has ghost `sm`
"Continue" (reopens the dialog at its sign-in step) and "Cancel" buttons; the
method rows are a double `Row` in a 4 px padded box, 56 tall (drawn 60); the
company rows are `Row`s, so the logo is 8 from the name (drawn 12) and the
rows touch (drawn 2 apart, off the 4 px scale); the method rows have no band
at rest, and their hover is the `Row`'s own tray tone (drawn: the band, only
on hover), with a 16 px icon (drawn 18; `Icon` has 12, 14 and 16); OpenAI
sits at half strength with "Later" until TKM-262; model chips are `Chip` `sm`
with the company mark (drawn on the tray tone, 6 apart); the connected logo is
24 (drawn 28); the card's action row (models, refresh, settings, remove) and
its profile codes come with TKM-265 and TKM-264. Button `sm` keeps radius 8
(drawn 6) and ghost `sm` text is ink-2 (drawn ink), as the package draws them.

## Parts it offers

None. It publishes no `component`.

## What it adds to others

| Target (shell)     | What                                                                   | File                                 | Paper artboard                                                 |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| Rail, tabs, search | The Profiles page (`/p/ai-profiles`), marked with a person (user-line) | `pages/profiles.tsx`, `lib/icons.ts` | every `Profiles ·` artboard (its tab); the rail is not on them |

## If you change X, check Y

- Card or column sizes: four 296 px cards and three 12 px gaps make the 1220
  column (`max-w-profiles` in `src/client/styles.css`); change both together.
- The card's lines read `agent-proxy`'s `SubscriptionView` (plan, accounts,
  models, status, reason); a new status there needs a line here.
- `CompanyMark` keeps only path outlines, like ai's `AgentMark`: the marks
  `claude` and `codex` ship must stay single-colour paths. A model chip shows
  the mark only when it is one path in a 24 × 24 box (Claude's is).
- The dialog's text column is `Dialog.Content`'s 440 (`max-w-dialog`); the
  step pills and the close button share its header line.
- The desktop sign-in step uses the shell's return listener (listen and
  cancel) and HTTPS opener; see `design/shell.md`. Keep the company callback
  map in `lib/sign-in-return.ts` aligned with the provider redirects. Later,
  derive the port and path from the company's `returnAddress` in
  `lib/companies.ts` once that file lands.
- Adding OpenAI (TKM-262): the company row becomes a button, a method step and
  a sign-in title per company; `productOf` and `agentOf` in `lib/api.ts`.

## Primitives used

`Button` (`sm` ghost "Sign in", "Continue", "Cancel"; `md` ghost "Add
subscription", "Copy link", "Back"; brand "Open sign-in page" (a link in a browser),
"Done", "Start again"), `Chip` (`sm`), `Collapsible` (`quiet` trigger),
`Dialog`, `Icon`, `icons`, `Input` (`md` `mono`, `lg`), `Row` (single and
double), `Switch` (solid-js's `Switch` is imported as `Choose`); its own `CompanyMark`.

How the Paper copies were made: `e2e/browser/screens.spec.ts` ("profiles
screens") takes each screen; `e2e/paper-html.ts` turns the page with
`PAPER_DROP="dialog-"` and the dialog and its backdrop with `--page`, since
the converter clips the dialog to the stage while the browser draws it in the
top layer. The dialog screens share the shell of `Profiles · subscriptions`
and swap only the Subscriptions section. The Switch's transparent 2 px border
is left out (Paper measures from inside it). Matched to this branch,
`feature/tkm-261`.

## Open questions

- **The sign-in step differs from the drawing.** The address field stays
  visible. The Paper copy shows the browser wording. With a desktop listener,
  the dialog says Tokamak can finish automatically; if the listener is busy
  or unavailable, it shows the browser wording. Desktop opens the sign-in
  page in the system browser; the Windows opener is unverified. The Profiles
  page keeps listening for the newest waiting sign-in per company even
  after the dialog closes. Cancel, expiry, completion, or leaving the
  Profiles page stops it.
- The company rows' 2 px gap, the method row's 18 px icon and its band-on-hover
  are not available without restyling `Row` or `Icon` (see above).

- In the browser test run the dialog sits at the window's top-left corner, as
  the shell's sign-in dialog does (`design/shell.md`); the Paper copies draw
  it there. Check where the desktop app puts it.
- Rows show their text in ink-2 at rest (the `Row` look); the owner's drawing
  has the company and method names in ink.
- The rail now has a Profiles mark whenever ai-profiles is installed (it is in
  the starter set); the `App 1:1 · Shell` copy still shows the rail without it.
