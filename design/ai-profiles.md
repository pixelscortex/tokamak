# AI Profiles

The Profiles screen: a page of its own in the rail. Today it draws the
Subscriptions section, the add-subscription dialog, and the Profiles section
with its "New profile" dialog (TKM-264); the subscription and profile details
and the picker column come with later tickets. Subscriptions are `agent-proxy`'s data
(`design/agent-proxy.md`); company logos are the marks of the `claude` and
`codex` agent plugins, read from ai's agent list on this computer.
Paper page: `App 1:1 · AI profiles plugin`. Drawn from the owner's
"Flow · Profiles (proposal)" artboards `1 · Profiles · screen`, `2a` to `2d`,
`4a · Profiles · hover a profile` and `4b · Profiles · dragging a card`.

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
| "New profile": name and code (typed "pers", shown "PERS")                               | `ui/profile-dialog.tsx`                                                         | `Profiles · new profile`                   |
| Two profiles, the card in one; its code on the card                                     | `ui/profiles-section.tsx`, `ui/profile-box.tsx`, `ui/card-profiles.tsx`         | `Profiles · profiles`                      |
| Pointing at a profile: the cards it does not hold dim                                   | `ui/profile-box.tsx`, `lib/builder.ts` (`dimmed`)                               | `Profiles · hover a profile`               |
| Dragging the card: the box that holds it says "added", the other rings with a slot      | `lib/drag.ts`, `ui/profile-box.tsx`, the ghost in `ui/profiles-section.tsx`     | `Profiles · dragging a card`               |

Not drawn yet: no subscriptions ("No subscriptions yet…"), a "Signed out" card
with "Sign in", a refused or wrong paste (the line under the field, the sign-in
still waiting), an ended sign-in ("Start again"), an expired one (card and
dialog), "Awaiting sign-in again" for a repair, the "Copied" state of Copy
link, "That sign-in was cancelled in another window.", and a plain browser
(neutral company marks). The window tests cover each of them. For profiles:
no profiles yet ("No profiles yet. Make one, then drag subscriptions into
it."), an empty box ("Drag a subscription here"), a code refused in the dialog,
a row's menu (Move up, Move down, Remove from PERS) and a card's "Add to
profile" menu; the window tests in `profiles-section.test.tsx` cover them.

Measured on the owner's artboards and kept: the column is 1220 wide and
centred (`max-w-profiles`, a token in this plugin's `styles.css`), 24 from
the header, 12 between rows; four cards across, 12 apart; a card is radius 12,
16 in, on the tray tone; logo 24 with 12 to the title; emails and the plan line
in data mono; "Signed out" in warn with a ghost `sm` "Sign in". The pending
card is an edge ring with an 18 px logo on a 32 px card-tone tile. The dialog
is 440 wide, 24 in, 20 between its parts; four 24 × 4 step pills 4 apart; the
title is `text-read` semibold; the address field is `Input` `md` `mono` with an
`sm` ghost "Continue" beside it, the label field `Input` `lg`.

The Profiles section, measured on `1 · Profiles · screen`, `4a` and `4b`: the
header is 40 under the cards (`pt-10`), "Profiles", the count in data mono and
the hint "Drag subscriptions into a profile. Top one is used first." in
`text-label` ink-3, 8 after the count; "New profile" is a ghost `md` with the
add icon. Boxes share the column, 12 apart; a box is radius 12, 4 in, on the
tray tone, 4 between its parts. Its head is 40 tall: the stack icon at 14 in
ink-3, the code in `text-code` (13 mono) medium ink, the name in `text-row`
ink-2, and "Fill first" in `text-label` ink-3 at the end. A row is 40 tall,
radius 8, on the card tone, 8 in at the start: the grip at 12 in ink-3, the
number in data mono ink-3, the logo at 16, the name in `text-row` medium ink,
and the label in `text-label` ink-3 at the end ("2 accounts" in its place for
a subscription with several). On a card the codes follow the model line, each
a 12 px stack icon and the code in data mono ink-3, 4 apart, 8 between codes.
Pointing at a box ("4a") turns it to the card tone with an edge ring, and
every card it does not hold, the awaiting one too, goes to 40%. Dragging
("4b"): the carried card waits at 40%, a box that holds it goes to 40% and
says "✓ added" instead of "Fill first", the box under the pointer turns to the
card tone with the strong edge ring, and a dashed strong-edge slot, 40 tall
and radius 8, shows the number the card would get; the ghost follows the
pointer, tilted 2°, on the band tone with the raised shadow.

Decided here for the Profiles section, not drawn (or not on the scale): the
pointed box's ring is the edge (drawn at 20% ink, between `edge` 12% and
`edge-strong` 40%); the head is 12 in (drawn 10) and the number column 12 wide
(drawn 10); boxes sit three to a row and wrap; the drop slot's number is 32 in
(drawn 28); the ghost is radius 12 (drawn 10) and as tall as its text with 4 in
(drawn 44 fixed, 300 wide); a box with no rows says "Drag a subscription
here"; a disabled subscription's row says "Off" where the label goes; the
"New profile" dialog is the add-subscription dialog's frame with two `Input`
`md` fields (`mono` for the code) and the help "Up to 4 letters or digits.
Threads show it in the picker."; each row ends in a ghost `sm` "more" button
and each card's model line in a ghost `sm` add button (its "Add to profile"
menu), both shown only while the row or card is pointed at or focused.

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
24 (drawn 28); the card's action row (models, refresh, settings, remove) comes with TKM-265. Button `sm` keeps radius 8
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
- Adding OpenAI (TKM-262): the company row becomes a button, a method step and
  a sign-in title per company; `productOf` and `agentOf` in `lib/api.ts`.
- The card's model line holds the profile codes and the "Add to profile"
  button (`profiles` slot of `SubscriptionCard`); the card's action row
  (TKM-265) sits under it. A card is a drag source: a press on anything but a
  button, link, field or switch starts a drag (`lib/drag.ts`, `INTERACTIVE`).
- Dimming reads `data-dimmed` on the cards (`SubscriptionCard`, `AwaitingCard`);
  a new kind of card in the grid needs it too, or it stays bright while a
  profile is pointed at.
- A drop is found from the page: boxes carry `data-profile`, rows `data-entry`.
  Renaming those breaks dragging, not the tests of the menus.
- Profiles hold `agent-proxy` subscription ids. When a subscription is removed
  (TKM-265), its flow calls `internal.profiles.forgetSubscription`; the screen
  already hides one `agent-proxy` no longer lists.
- The picker column (TKM-266) reads a profile's subscriptions in use order with
  `internal.profiles.inUseOrder`; the order shown here is that order.

## Primitives used

`Button` (`sm` ghost "Sign in", "Continue", "Cancel"; `md` ghost "Add
subscription", "Copy link", "Back", "New profile"; brand "Open sign-in page" as
a link, "Done", "Start again", "Create"), `Chip` (`sm`), `Collapsible`
(`quiet` trigger), `Dialog` (also "New profile"), `Icon` (12, 14, 16), `icons`,
`Input` (`md` `mono`, `md`, `lg`), `Menu` (`Root`, `Trigger` as a ghost `sm`
icon button, `Content`, `Group`, `GroupLabel`, `Item`, `Separator`), `Row`
(single and double), `Switch` (solid-js's `Switch` is imported as `Choose`);
its own `CompanyMark`, profile box, row and drop slot (`ui/profile-box.tsx`),
and drag ghost.

How the Paper copies were made: `e2e/browser/screens.spec.ts` ("profiles
screens") takes each screen; `e2e/paper-html.ts` turns the page with
`PAPER_DROP="dialog-"` and the dialog and its backdrop with `--page`, since
the converter clips the dialog to the stage while the browser draws it in the
top layer. The dialog screens share the shell of `Profiles · subscriptions`
and swap only the Subscriptions section. The Switch's transparent 2 px border
is left out (Paper measures from inside it). Matched to this branch,
`feature/tkm-261`.

## Open questions

- **Profiles: fields and dialog.** No "New profile" dialog or field is drawn;
  it uses `Input` `md` (40) for both fields, since there is no 32 px dense
  `Input` (TKM-291's open question 3). Should the code field be dense, or sit
  beside the name?
- **Profiles: keyboard controls are not drawn.** The keyboard does what dragging
  does through two menus: a ghost `sm` button at the end of each row (Move up,
  Move down, Remove from the profile) and one at the end of each card's model
  line ("Add to profile", the profiles that hold it marked "added"). Both show
  only while the row or card is pointed at or focused. Where should they sit
  in the drawing, and should removing a row also be drawn (an × on the row)?
- **Profiles: the pointed box's ring** is drawn at 20% ink, which no token has;
  it uses `edge` (12%).
- **Profiles: touch.** A touch on a card scrolls the page; only a mouse or pen
  drags. Touch users use the menus.
- **Profiles: rename and delete** are not on this screen (TKM-269 adds the
  profile details).

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
