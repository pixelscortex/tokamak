# Issue tracker: Linear

Issues and specs for this repo live in Linear, team **TKM** (Tokamak). Use the Linear MCP tools (`mcp__linear-server__*`) for every operation. GitHub Issues on `pixelscortex/tokamak` are not used; GitHub holds code and pull requests only.

## Conventions

- **Create an issue**: `save_issue` with `team: "TKM"`, a `title` and a markdown `description`. Omit `id` to create. Before creating, search with `list_issues` (its `query` parameter) so you don't file a duplicate.
- **Read an issue**: `get_issue` with the identifier (e.g. `TKM-42`). It does not return the discussion; call `list_comments` for that.
- **List issues**: `list_issues` filtered by `team: "TKM"` plus `state`, `label`, `project`, `assignee` or `query`. Results are paginated: follow `cursor` while `hasNextPage` is true.
- **Projects**: work is grouped into Linear projects (e.g. `P-TKM-14` for v0 Friends). Pass `project` when the issue belongs to an existing one; `list_projects` finds them.
- **Sub-issues**: set `parentId` to the parent's identifier on `save_issue`.
- **Blocking**: use Linear's native relations (`blockedBy` / `blocks` on `save_issue`). An issue is unblocked when every blocker is in a completed or cancelled state.
- **Comment**: `save_comment` with the issue identifier and a markdown `body`.
- **Labels**: use `addLabels` / `removeLabels` on `save_issue`. Don't pass `labels`, which replaces the full set. Labels are per team; check `list_issue_labels` for TKM first.
- **Statuses**: per team; check `list_issue_statuses` for TKM before setting `state`.
- **Close**: post the explanation with `save_comment`, then move the issue to a completed (or cancelled) state with `save_issue`.

Write descriptions for people: short sentences, one term per concept. Put long agent detail (plans, file lists, repro logs) at the end in a collapsible section:

```
+++ Agent notes

...

+++
```

No AI attribution in titles, descriptions or comments.

## When a skill says "publish to the issue tracker"

Create a Linear issue in team TKM, attached to the relevant project when there is one.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above, plus its comments.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single Linear issue with **child** issues as tickets. The five `wayfinder:*` labels below already exist on team TKM.

- **Map**: one TKM issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
- **Child ticket**: a sub-issue of the map (`parentId`), labelled `wayfinder:<type>` (`research` / `prototype` / `grilling` / `task`). Once claimed, it is assigned to the driving dev.
- **Blocking**: see **Blocking** under Conventions.
- **Frontier query**: list the map's open children, drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: `save_issue` with `assignee: "me"`, the session's first write.
- **Resolve**: `save_comment` with the answer, move the issue to a completed state, then append a context pointer (gist + link) to the map's Decisions-so-far.
