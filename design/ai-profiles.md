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
| Dialog, step 1: company (Anthropic and OpenAI; "More later" listed, not offered)        | `ui/add-dialog.tsx` (`CompanyStep`)                                             | `Profiles · add · company`                 |
| Dialog, step 2: method for Anthropic ("Claude subscription"; "API key", marked "Later") | `ui/add-dialog.tsx` (`MethodStep`)                                              | `Profiles · add · method`                  |
| Dialog, step 2: method for OpenAI ("ChatGPT subscription"; "API key", marked "Later")   | `ui/add-dialog.tsx` (`MethodStep`), words in `lib/companies.ts`                 | `Profiles · add · method, OpenAI`          |
| Dialog, step 3: sign-in, the address field shown, "Signed in on another device?" folded | `ui/add-dialog.tsx` (`SignInStep`)                                              | `Profiles · add · sign-in`                 |
| Dialog, step 3 with an address pasted and the other-device note open                    | `ui/add-dialog.tsx` (`SignInStep`)                                              | `Profiles · add · sign-in, address pasted` |
| Dialog, step 4: connected, plan, email, models, label                                   | `ui/add-dialog.tsx` (`ConnectedStep`)                                           | `Profiles · add · connected`               |
| A Claude and a ChatGPT card side by side                                                | `ui/subscription-card.tsx`                                                      | `Profiles · Claude and ChatGPT`            |

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
on hover), with a 16 px icon (drawn 18; `Icon` has 12, 14 and 16); model chips are `Chip` `sm`
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
- The dialog is one flow for every company: the steps, the sign-in wording and
  the paste field are shared, and only the words in `lib/companies.ts` differ
  (name, method, plans, where an API key comes from, the sign-in title, the
  return address shown as the field's example). A new company adds an entry
  there, in `productOf` and `agentOf` (`lib/api.ts`), and its sign-in module
  in agent-proxy (`design/agent-proxy.md`).

## Primitives used

`Button` (`sm` ghost "Sign in", "Continue", "Cancel"; `md` ghost "Add
subscription", "Copy link", "Back"; brand "Open sign-in page" as a link,
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

- **The sign-in step differs from the drawing**, for Claude and ChatGPT alike
  (one step, the same words; only the title and the field's example address
  differ). The drawing puts the paste
  field under "Signed in on another device?" and expects Claude's page to show
  `code#state`. With the redirect as built (`http://localhost:54545/callback`,
  the Claude Code CLI's own), nothing listens there, so after signing in on
  this device the browser ends on a page that fails to load. The step says so
  ("After you sign in, your browser ends on a page that may not load. Copy the
  whole address…"), shows the field right away, and keeps "Signed in on
  another device?" only as a note for the other-device case. A pasted
  `code#state` or bare code is still accepted. Which redirect to use (this one,
  or Claude's hosted manual-code page) is the owner's call; the drawing can go
  back to the folded field if the hosted page is chosen. ChatGPT has no hosted
  code page: its return is always `http://localhost:1455/auth/callback`, so the
  paste stays until a forwarder in the Runner receives both companies' returns
  (`design/agent-proxy.md`, "Known limits").
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
