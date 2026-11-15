# Blitz fork

This branch uses `https://github.com/JustKira/blitz`, branch `traversal-api`,
commit `c12afcd220456e01f671bd8304f76cbffb615d46`. All Blitz crates share
that revision. Its element traversal API paints fused vector groups directly.

AnyRender uses its `main` git source, held in `Cargo.lock` at
`3e7fc16bc0223aaf0f053f1162b36146070e2f75`. Stylo 0.23.0 uses
`2dca34592ced37c6aa01733e94206a767194cf9d`, taffy uses
`4aca4f4933aa9cb7a3266050c788aad4c90288d2`, and winit is `=0.31.0-beta.4`.

## Rules

1. Nothing goes to the Blitz project without the owner's written approval.
   No pull request, issue, comment or discussion post on
   `github.com/DioxusLabs/blitz` or any related project (anyrender, vello,
   stylo, taffy, parley). Approval is per change, written by the owner on that
   change's Linear sub-issue. Reading upstream is fine.
2. No automatic pull requests. An approved change is offered by hand, and the
   owner sees the title and text first.
3. Every change has a Linear sub-issue under TKM-76 before it is built. It
   explains in plain language what the change does, why we need it, what it
   looks like on screen, what it costs, and which open upstream issue or pull
   request it relates to.
4. One change, one branch (`blitz/<short-name>`), one commit series. Changes
   are not mixed.
5. Quick versions are allowed for trying things out and are marked as such. A
   change is rewritten cleanly before it is offered upstream. The sub-issue
   says which state it is in.
6. A new change to the fork is allowed without asking first when Blitz is
   blocking our work or a small change removes a real obstacle (owner,
   2026-11-11: "if there is an issue blocking us, let's fix it"). It is not
   allowed silently: the change gets its own branch, its Linear sub-issue and
   its entry in `BLITZ_CHANGES.md` in the same piece of work, and the owner is
   told what was changed and why. Rules 1 and 2 still hold: nothing is offered
   upstream without approval.
7. When Blitz releases a new version, each change is re-applied and re-tested,
   and the result is recorded on its sub-issue.
8. The same Blitz pin is used by other branches. Switching the workspace to a
   fork is a workspace-wide change and must be agreed before it lands.
