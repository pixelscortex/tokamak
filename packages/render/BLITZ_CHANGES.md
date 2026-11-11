# Changes we made to Blitz, in plain words

One entry per change. Each says what it is, why we made it, what it helps
with, and whether Tokamak needs it right now. The rules for working on the
fork are in `BLITZ_FORK.md`; the discussion for each change is in Linear under
TKM-76.

Words: "Blitz" is the engine that draws the interface. "The fork" is our own
copy of it at `github.com/pixelscortex/blitz`. "Upstream" is the original
Blitz project.

**Right now one branch uses the fork: `feature/ui-shell`, as a trial of
change 1.** Every other branch uses the published Blitz 0.3.0-beta.4. Nothing
has been offered to Blitz.

---

## Change 1: a button can carry our drawing code and still be a button

| | |
|---|---|
| Status | In use on `feature/ui-shell` as a trial, not offered to Blitz. |
| Where | Draft pull request 1 inside our fork, branch `blitz/widget-event-result`, commit `99c448f` |
| Size | One commit: 41 lines added, 22 removed, 6 files |
| Linear | TKM-77 |
| Needed right now | On `feature/ui-shell`, yes: every plate there draws itself. Elsewhere, no. |
| Blitz issue it answers | [Issue 233, "Custom widget support"](https://github.com/DioxusLabs/blitz/issues/233), open. The unchecked item "Event result" on that list describes this exact gap. |

**The problem.** Tokamak draws its own bevelled backgrounds ("plates"). The
simplest way is to attach our drawing code to the button itself. But when
you press an element that has our drawing code attached, Blitz gives the
press to that code and stops. The button never finds out it was clicked,
focused or held down. So a button with our drawing code on it was dead.

**What the change does.** Our drawing code can answer "I did not use this
press". Blitz then treats the button as a normal button. Nothing changes for
anyone who does not use that answer.

**How Tokamak used to do without it.** The drawing code lived on a separate,
invisible element behind the buttons ("the sheet"), which ignores all
presses, and our build step turns ordinary background colours into fills
for that sheet. That way still exists, and an area can ask for it.

**What we found when we adopted it** (on `feature/ui-shell`; each point is
checked by a test that looks at the drawn pixels
(`the_two_painters_differ_where_documented`, on the lab's fixtures view,
which holds each case twice: with the sheet and the new way):

- **A background that should cover what is under it now does.** A bar above
  a scrolling list hides the lines that scroll under it. With the sheet the
  lines showed through the bar. Fixed.
- **A faded parent now fades the plate, and a moved or enlarged parent moves
  and enlarges it.** With the sheet the plate stayed solid and stayed where
  it was before the move. Fixed.
- **A plate inside a small scrolling box is now cut off at the box's edge.**
  With the sheet it stuck out over the edge. Fixed.
- **Of two overlapping plates, the one told to be on top now is.** With the
  sheet the later one in the page always won. Fixed.
- A button with a plate on it still behaves as a button in every way we
  test: it takes focus, shows its pressed look, clicks, answers the Enter
  key, and scrolling the wheel over it scrolls the page.
- Where the sheet had no problem, both ways draw the same picture, checked
  point by point.

**What it did not fix, and what got worse.**

- Text fields, images and tables cannot carry our drawing code in Blitz: an
  element has room for one kind of extra data, and a text field already
  uses it for the text being edited. We worked around it on our side: the
  plate they sit on (a card around a text field) draws their background for
  them, and where there is none the sheet does. Letting them draw
  themselves would need a second, larger change to Blitz; we have not made
  it and do not need it now.
- A plate drawn inside an enlarged parent is enlarged as a picture, so its
  edges are slightly soft.
- A plate on an element that hides its overflow and also has a CSS border
  is cut off at the inside of the border.
- Blitz asks every element that carries drawing code to draw on every frame
  it draws, including elements scrolled out of view. The cost is small (see
  the numbers in `SURFACES.md`), we keep no picture in memory for plates
  outside the window, and a window where nothing changes still draws
  nothing.
- Each bevelled plate now keeps its own small picture, where the sheet kept
  one picture per area. Hundreds of small plates are fine. Many large
  bevelled plates on screen at once would cost more than with the sheet.

**What it does not help with.** Lighting that spreads from one plate onto
its neighbours is easier with the sheet, because one sheet sees every plate
in its area. That is why an area can still choose the sheet.

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
