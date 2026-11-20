# Tokamak

Tokamak is an app where everything a person sees is a plugin. This glossary fixes the words used for where plugins and their data live.

## Language

**Workspace**:
One plugin list, one data store and one member list, sealed from every other workspace. Every member of a workspace gets the same plugins.
_Avoid_: Space, project, team

**Server**:
The program that runs a workspace and that people connect to. A server holds exactly one workspace.
_Avoid_: Hub, host, backend

**Shared server**:
A server that several people connect to. Its workspace lives only there.
_Avoid_: Hub, remote, cloud server

**Local server**:
The server that runs on a person's own computer. The desktop app or CLI can start it. The owner can invite members to its workspace.
_Avoid_: This Mac, desktop server, embedded server

**Machine**:
Any real computer with an operating system and files: a personal computer, a company computer or a remote sandbox. A shared server is not a machine to a plugin: it runs on the database and offers no files or programs.
_Avoid_: Runner, device, host, local

**Window**:
The UI of the app. A plugin's window part is the code in `src/client`. It only calls functions and never changes data or files directly.
_Avoid_: Client, frontend, desktop

**Server part**:
A plugin's code in `src/server`: its tables, queries, mutations and actions.
_Avoid_: Backend

**Reload**:
Rebuild a plugin and swap its new version into the running server. The old version serves until the new one is ready.
_Avoid_: Hot swap, refresh, redeploy

**Remount**:
The window drops a plugin's views and mounts them again from the new code. The window itself stays open, and nothing inside the views is kept.
_Avoid_: Refresh, window reload

**Build id**:
The SHA-256 of a built plugin's `manifest.json`. The manifest holds the hash of every other file, so the build id names one exact build. The version is only a label.
_Avoid_: Revision, hash, version

**Starter set**:
The plugins every server needs to be usable, `chat` and `acp` today. CI packs them onto the GitHub Release, and a server fetches them at start when they are missing or do not fit its version. After that they are ordinary plugins.
_Avoid_: Built-in plugins, core plugins, bundled plugins

**Plugin log**:
One file per plugin in the computer's temp folder. It holds what the active build printed and the errors it threw, on the server and in the window. A successful reload replaces the log only for plugins whose build changes.
_Avoid_: Server log, console, output

**Skill file**:
The instructions written into a plugin's folder that teach an agent the plugin API and the edit loop.
_Avoid_: Docs, prompt, rules file
