# AI Profiles

The Profiles screen: a page of its own in the rail. Today it draws the
Subscriptions section, the add-subscription dialog, the subscription details
and the remove confirmation (TKM-265); the Profiles section (TKM-264), the
profile details and the picker column come with later tickets. Subscriptions are `agent-proxy`'s data
(`design/agent-proxy.md`); company logos are the marks of the `claude` and
`codex` agent plugins, read from ai's agent list on this computer.
Paper page: `App 1:1 · AI profiles plugin`. Drawn from the owner's
"Flow · Profiles (proposal)" artboards `1 · Profiles · screen`, `2a` to `2d`
and `3 · Subscription · details`.

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
| Subscription details, one account: accounts, label, models, "Used by"                   | `pages/subscription.tsx`                                                        | `Profiles · subscription`                  |
| The same with a second account added through "Add account"                              | `pages/subscription.tsx`, the dialog's sign-in step                             | `Profiles · subscription · two accounts`   |
| The same with one of the two signed out (its own "Sign in"; the card still "OK")        | `pages/subscription.tsx` (`AccountRow`)                                         | `Profiles · subscription · one signed out` |
| Remove confirmation, no profile using it                                                | `ui/remove-dialog.tsx`                                                          | `Profiles · remove`                        |

Not drawn yet: no subscriptions ("No subscriptions yet…"), a "Signed out" card
with "Sign in", a refused or wrong paste (the line under the field, the sign-in
still waiting), an ended sign-in ("Start again"), an expired one (card and
dialog), "Awaiting sign-in again" for a repair, the "Copied" state of Copy
link, "That sign-in was cancelled in another window.", a plain browser
(neutral company marks), the card actions' tooltips, a failed "Check again"
(the line under the card's buttons), "Used by" with profiles and the remove
confirmation naming them (no profiles exist before TKM-264). The window tests
cover each of them.

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
24 (drawn 28); the card's profile codes come with TKM-264. Button `sm` keeps
radius 8 (drawn 6) and ghost `sm` text is ink-2 (drawn ink), as the package
draws them.

**Subscription details and card actions (TKM-265).** Measured on `1 · Profiles
· screen` and `3 · Subscription · details` and kept: the card's action row is
four ghost `sm` icon-only buttons (24 × 24, 14 px icons in ink-3), 2 px apart
(`gap-hair`, a token in this plugin's `styles.css`; under the 32 px target
rule, an exception pending the owner): Models, Check again, Details, Remove,
each with a `Tooltip` and a name that says which subscription ("Remove Claude
Team"). The details column is 912 wide (`max-w-subscription`) and centred, 24
from the header, 32 between the title row and the columns; the title row is
32 tall: logo, title (`text-read` semibold) and label (`text-row` ink-3), 12
apart. The accounts column is 536 (`w-accounts`), 48 from the right column. A
section header is 24 + 8 + a 1 px edge line (33), its name `text-label` ink-3
with the count in data mono. An account row is 12 + 36 + 12 + its edge line
(61): `Avatar` 24, the email `text-row` medium ink over its status in
`text-label` ink-3 ("Signed out" in warn), and a ghost `sm` "Sign out" or
"Sign in". The right column's sections are 32 apart and 12 inside; model chips
are `Chip` `sm` with the company mark, 8 apart; a "Used by" row is 24 tall,
the profile mark 12 and code in data mono ink-3, the name `text-row` medium,
the thread count in data mono ink-3.

Decided here, not drawn: the details replace the Subscriptions section on the
same page (window state `openSubscription`), with "Profiles / Claude Team" in
the page header, where "Profiles" is a `bare` Button that goes back (drawn as
plain ink-3 text 16 from the edge; the Button's padding puts it 28 from the
edge). The shell's Back does not leave the details: a plugin cannot open a
route of its own with a parameter, nor navigate. The label is edited in the
details, in a "Label" section above "Models" (`Input` `md`, saved on Enter or
when the field is left). "Add account" and an account's "Sign in" open the
add-subscription dialog at its sign-in step and close it when the account is
in (no "Connected" step). Models and Details on the card both open the
details; the Models tooltip lists the model names. A failed Check again says
why in a line under the card's buttons. The card's icon row is not pulled 6 px
left as drawn (no negative margins), so its first icon sits 5 px in from the
text. The details logo is 24 (drawn 28). An account's status line is "OK" or
"Signed out · why" (drawn "OK · in use" and "Cooling down · resets 14:00",
which need the proxy, TKM-263). The remove confirmation is not drawn: a
`Dialog` titled "Remove Claude Team, Acme?", what is deleted, the profiles
that lose it (or "No profile uses it."), "Cancel" and a destructive "Remove".

## Where profiles come in (TKM-264)

`src/server/profile-uses.ts` is the one seam: `profilesUsing(ctx, id)` answers
the details' "Used by" and the remove confirmation (through `manage:usedBy`),
and `subscriptionRemoved(ctx, id)` runs in the same transaction as
`manage:remove`. Both are empty today.

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
  models, status, reason); a new status there needs a line here. The card
  shows the subscription's status, the details each account's.
- The details hide the Subscriptions section (`hidden`) while open; a section
  added under it (the Profiles section, TKM-264) must hide with it.
- The card's action buttons are named from `titleOf` ("Remove Claude Team");
  the tests and the browser screens find them by those names.
- `CompanyMark` keeps only path outlines, like ai's `AgentMark`: the marks
  `claude` and `codex` ship must stay single-colour paths. A model chip shows
  the mark only when it is one path in a 24 × 24 box (Claude's is).
- The dialog's text column is `Dialog.Content`'s 440 (`max-w-dialog`); the
  step pills and the close button share its header line.
- Adding OpenAI (TKM-262): the company row becomes a button, a method step and
  a sign-in title per company; `productOf` and `agentOf` in `lib/api.ts`.

## Primitives used

`Avatar`, `Button` (`sm` ghost "Sign in", "Sign out", "Add account",
"Continue", "Cancel"; `md` ghost "Add subscription", "Copy link", "Back";
`bare` "Profiles" in the header; brand "Open sign-in page" as a link, "Done",
"Start again"; destructive "Remove"), `Chip` (`sm`), `Collapsible` (`quiet`
trigger), `Dialog`, `Icon`, `icons`, `Input` (`md`, `md` `mono`, `lg`), `Row`
(single and double), `Switch` (solid-js's `Switch` is imported as `Choose`),
`Tooltip` (`sm` ghost icon triggers); its own `CompanyMark`.

How the Paper copies were made: `e2e/browser/screens.spec.ts` ("profiles
screens") takes each screen; `e2e/paper-html.ts` turns the page with
`PAPER_DROP="dialog-"` and the dialog and its backdrop with `--page`, since
the converter clips the dialog to the stage while the browser draws it in the
top layer. The dialog screens share the shell of `Profiles · subscriptions`
and swap only the Subscriptions section. The Switch's transparent 2 px border
is left out (Paper measures from inside it). The TKM-265 artboards
(`Profiles · subscription`, `· two accounts`, `· one signed out`,
`Profiles · remove`) share that shell too and swap the page header and the
content; `PAPER_DROP` leaves out the fixture plugins' rail marks
(`FixtureView,PanelView,ThrowingView,WindowStateView,OtherDraftView`).
`Profiles · subscriptions` was refreshed by swapping its Subscriptions section
for the card with the action row. Matched to `feature/tkm-265`.

## Open questions

- **The sign-in step differs from the drawing.** The drawing puts the paste
  field under "Signed in on another device?" and expects Claude's page to show
  `code#state`. With the redirect as built (`http://localhost:54545/callback`,
  the Claude Code CLI's own), nothing listens there, so after signing in on
  this device the browser ends on a page that fails to load. The step says so
  ("After you sign in, your browser ends on a page that may not load. Copy the
  whole address…"), shows the field right away, and keeps "Signed in on
  another device?" only as a note for the other-device case. A pasted
  `code#state` or bare code is still accepted. Which redirect to use (this one,
  or Claude's hosted manual-code page) is the owner's call; the drawing can go
  back to the folded field if the hosted page is chosen.
- The company rows' 2 px gap, the method row's 18 px icon and its band-on-hover
  are not available without restyling `Row` or `Icon` (see above).

- "Open sign-in page" is a link that opens a new window. In a browser it opens
  a tab; the desktop app has no opener for outside links (no Tauri opener
  plugin), so it may do nothing there, and "Copy link" is the way. The owner's
  real check covers it.
- In the browser test run the dialog sits at the window's top-left corner, as
  the shell's sign-in dialog does (`design/shell.md`); the Paper copies draw
  it there. Check where the desktop app puts it.
- Rows show their text in ink-2 at rest (the `Row` look); the owner's drawing
  has the company and method names in ink.
- The rail now has a Profiles mark whenever ai-profiles is installed (it is in
  the starter set); the `App 1:1 · Shell` copy still shows the rail without it.
