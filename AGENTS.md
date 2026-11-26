# Tokamak

## Agent skills

### Issue tracker

Issues live in Linear, team TKM, through the Linear MCP tools (GitHub holds code and PRs only). See `docs/agents/issue-tracker.md`.

### Plugins

Plugins live in the `tokamak-plugins` repository (pixelscortex/tokamak-plugins), one folder per plugin, and build against a Tokamak checkout. The app ships with no plugins; it loads the builds in its plugins folder. The `develop-tokamak-plugin` skill in `skills/` describes the flow. The plugins still in `plugins/` here are being moved there and will be deleted.

Nothing inside the app names, links to or runs the plugin install script or `tokamak-plugins`. Docs, skills and READMEs may.

### Design sync

Paper and the app stay in sync. Every change to what a screen looks like, in the same piece of work: (1) updates its design note, `design/shell.md` for the shell here or the plugin's `DESIGN.md` in its folder in `tokamak-plugins`, (2) updates its `App 1:1` page in Paper so it looks the same as the app, and (3) checks the "If you change X, check Y" notes of every plugin listed as affected. Review checks all three. See the `tokamak-design` skill and `design/README.md`.

The owner's Paper pages (Chat, Plugins · coding, notes, System · rules, moodboard) are not edited; the `App 1:1` pages are kept by whoever changes the UI.

### Skills

`skills/` holds the skills other repositories install with `npx skills add pixelscortex/tokamak`: `develop-tokamak-plugin` and `tokamak-design`. `plugin create` writes `skills/develop-tokamak-plugin/SKILL.md` into each new plugin as its skill file, so edit that one file.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
