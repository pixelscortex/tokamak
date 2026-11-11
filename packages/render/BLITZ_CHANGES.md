# Changes we made to Blitz, in plain words

One entry per change. Each says what it is, why we made it, what it helps
with, and whether Tokamak needs it right now. The rules for working on the
fork are in `BLITZ_FORK.md`; the discussion for each change is in Linear under
TKM-76.

Words: "Blitz" is the engine that draws the interface. "The fork" is our own
copy of it at `github.com/pixelscortex/blitz`. "Upstream" is the original
Blitz project.

**Right now Tokamak does not use the fork.** It uses the published Blitz
0.3.0-beta.4. Every change below is waiting in the fork until the owner has
reviewed it.

---

## Change 1: a button can carry our drawing code and still be a button

| | |
|---|---|
| Status | Waiting for the owner's review. Not used by Tokamak. Not offered to Blitz. |
| Where | Draft pull request 1 inside our fork, branch `blitz/widget-event-result` |
| Size | One commit: 41 lines added, 22 removed, 6 files |
| Linear | TKM-77 |
| Needed right now | No |
| Blitz issue it answers | [Issue 233, "Custom widget support"](https://github.com/DioxusLabs/blitz/issues/233), open. The unchecked item "Event result" on that list describes this exact gap. |

**The problem.** Tokamak draws its own bevelled backgrounds ("plates"). The
simplest way would be to attach our drawing code to the button itself. But
when you press an element that has our drawing code attached, Blitz gives the
press to that code and stops. The button never finds out it was clicked,
focused or held down. So a button with our drawing code on it was dead.

**What the change does.** Our drawing code can answer "I did not use this
press". Blitz then treats the button as a normal button. Nothing changes for
anyone who does not use that answer.

**Why Tokamak does not need it today.** We reach the same picture another
way, without touching Blitz: the drawing code lives on a separate, invisible
element behind the buttons ("the sheet"), which ignores all presses, and our
build step turns ordinary background colours into fills for that sheet. The
button itself never carries drawing code, so Blitz's behaviour never gets in
the way. That is what runs in the lab now.

**What the change would improve if we adopted it.** Each button would draw
itself in its own place, so these limits of the sheet would go away:

- A background that is meant to cover other content in the same area is
  currently drawn underneath that content.
- A parent's transparency, or a CSS transform or filter, does not apply to a
  plate.
- A plate inside a scrolling box other than the main stage is not clipped by
  that box.

It would also remove the need for the build step to hide backgrounds from
Blitz.

**What it would not help with.** Lighting that spreads from one plate onto
its neighbours is easier with the sheet, because one sheet sees every plate
in its area.

**Does Blitz want it.** Their own to-do list for this plug-in point has an
open item describing the same gap ("Event result"). No one from Blitz has
been asked.

---

## Ideas not started

These are written up in Linear and are not built. Starting one needs the
owner's agreement first.

- **Keep the scroll position in range when content gets shorter** (TKM-78).
  Fixes the "page looks scrolled but cannot scroll" problem. Can also be
  solved on our side. Blitz issue: not searched for yet; that comes first.
- **Redraw custom elements only when they change** (TKM-79). Saves power when
  the window is idle. Blitz issue: the item "Paint invalidation" on
  [issue 233](https://github.com/DioxusLabs/blitz/issues/233); Blitz is
  already working in this area themselves
  ([pull request 1323](https://github.com/DioxusLabs/blitz/pull/1323)).
