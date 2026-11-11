# Blitz fork: rules

For a plain-language list of every change, why it exists and whether Tokamak
needs it, see `BLITZ_CHANGES.md` next to this file. Keep it up to date in the
same commit as any change to the fork.

Read this before changing anything in Blitz, or anything that depends on a
changed Blitz. The list of changes and their status lives in Linear, issue
TKM-76 ("Blitz fork: rules and list of changes"), with one sub-issue per
change. If this file and TKM-76 differ, TKM-76 wins; fix this file.

Status: the fork repository is `github.com/pixelscortex/blitz` and holds none
of our changes yet. Its `main` follows upstream `main`. The branch
`tokamak/base-0.3.0-beta.4` and the tag `v0.3.0-beta.4` mark upstream commit
`92b11f1`, the release Tokamak uses; every change of ours is a branch on top
of that base. Tokamak still uses Blitz `=0.3.0-beta.4` from crates.io across
the workspace.

Pushing to the fork: use SSH (`git@github.com:pixelscortex/blitz.git`). Blitz's
history contains GitHub workflow files, and an HTTPS push with the `gh` token
is refused without the `workflow` scope.

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
6. Adding a new change to the fork needs the owner's agreement first. Finding
   a bug in Blitz is not permission to fix it in the fork.
7. When Blitz releases a new version, each change is re-applied and re-tested,
   and the result is recorded on its sub-issue.
8. The same Blitz pin is used by other branches. Switching the workspace to a
   fork is a workspace-wide change and must be agreed before it lands.

## Steps a change goes through

Proposed, Trying, In the fork, Ready to offer, Approved to offer, Offered,
Accepted or declined. See TKM-76 for what each means.

## Where changes wait for review

A change that is not approved for upstream is parked as a draft pull request
inside our own fork: head `blitz/<short-name>`, base
`tokamak/base-0.3.0-beta.4`, in `pixelscortex/blitz`. The Blitz project is not
notified of pull requests inside a fork.

- Always pass the base repository explicitly
  (`gh pr create --repo pixelscortex/blitz --base tokamak/base-0.3.0-beta.4 ...`).
  Without it, GitHub targets the upstream project.
- Do not write upstream issue or pull request numbers or links (for example
  `#233` or a `github.com/DioxusLabs/...` URL) in commit messages, branch
  descriptions or pull request text in the fork. GitHub can show such
  references on the upstream issue. Describe the upstream item in words, and
  keep the links in Linear.
- A draft pull request on the upstream project is public and notifies its
  maintainers. It is not a private place to park work.

Current: change 1 is draft pull request 1 in the fork (Linear TKM-77).
