#!/usr/bin/env bash
# Installs the Tokamak desktop app the first time and updates it after that.
#
#   ./install.sh
#
# Order matters, so a failure never leaves the machine worse off:
#   1. Build the release app. If the build fails, stop: the installed app and
#      a running app are left exactly as they were.
#   2. If the installed Tokamak is running, ask it to quit and wait for it to
#      stop. If it will not stop, stop here and leave it alone.
#   3. Copy the new bundle next to the old one, swap them with two renames, and
#      only then move the old bundle to the Trash.
#   4. Print the Tokamak commit that was installed.
#
# The script only ever replaces the app bundle. It never reads, writes or
# deletes the app's data folder
# (~/Library/Application Support/com.pixelscortex.Tokamak), so threads,
# settings and installed plugins are the same after an update. Nothing is
# deleted with rm: old bundles and leftovers are moved to the Trash.
#
# Overrides, for testing against a stand-in instead of the real app:
#   TOKAMAK_INSTALL_DIR     folder that holds Tokamak.app (default /Applications)
#   TOKAMAK_BUILD_COMMAND   build command run from the repository root
#                           (default: the release Tauri build of the app bundle)
#   TOKAMAK_BUILT_APP       bundle the build produces
#                           (default <cargo target>/release/bundle/macos/Tokamak.app)
#   TOKAMAK_QUIT_TIMEOUT    seconds to wait for the app to quit (default 30)
#   TOKAMAK_TRASH_DIR       where replaced bundles go (default ~/.Trash)
set -euo pipefail

repo="$(cd "$(dirname "$0")" && pwd)"
cd "$repo"

if [ "$(uname -s)" != Darwin ]; then
  echo "install.sh supports macOS only for now." >&2
  exit 1
fi

install_dir="${TOKAMAK_INSTALL_DIR:-/Applications}"
app="$install_dir/Tokamak.app"
built_app="${TOKAMAK_BUILT_APP:-${CARGO_TARGET_DIR:-$repo/target}/release/bundle/macos/Tokamak.app}"
quit_timeout="${TOKAMAK_QUIT_TIMEOUT:-30}"
trash_dir="${TOKAMAK_TRASH_DIR:-$HOME/.Trash}"
stamp="$(date +%Y%m%d-%H%M%S)"
staged="$install_dir/.Tokamak.app.installing-$$"
old="$install_dir/.Tokamak.app.old-$$"

# Moves a path to the Trash under a unique name. Used instead of rm.
to_trash() {
  [ -e "$1" ] || return 0
  mkdir -p "$trash_dir"
  mv "$1" "$trash_dir/Tokamak-$2-$stamp-$$.app"
}

# A failure after the copy started leaves the staged copy behind; move it out.
cleanup() { to_trash "$staged" partial || true; }
trap cleanup EXIT

commit="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
if [ "$commit" != unknown ] && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  commit="$commit (with uncommitted changes)"
fi

# 1. Build first. set -e stops here on failure, before anything is touched.
echo "==> Building Tokamak $commit"
if [ -n "${TOKAMAK_BUILD_COMMAND:-}" ]; then
  bash -c "$TOKAMAK_BUILD_COMMAND"
else
  proto run bun -- install --frozen-lockfile
  proto run bun -- run --cwd app tauri build --no-sign --bundles app
fi
if [ ! -d "$built_app/Contents" ]; then
  echo "The build finished but $built_app is missing. Nothing was installed." >&2
  exit 1
fi

# 2. Quit the installed app if it is running. Every Tokamak process (the app
# and the Runner it starts) runs from inside the bundle, so matching the
# bundle path finds them and leaves other copies (dev builds) alone.
running() { pgrep -f "$app/Contents/" >/dev/null 2>&1; }

was_running=0
if running; then
  was_running=1
  echo "==> Quitting Tokamak"
  # Addressing the app by path, not bundle id, quits only this copy.
  osascript -e "with timeout of 10 seconds" \
    -e "tell application \"$app\" to quit" \
    -e "end timeout" >/dev/null 2>&1 || true
  waited=0
  while running && [ "$waited" -lt "$quit_timeout" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if running; then
    echo "Tokamak did not quit within ${quit_timeout}s. Quit it yourself and run ./install.sh again." >&2
    echo "The installed app was not changed." >&2
    exit 1
  fi
fi

# 3. Swap the bundle. The copy happens beside the target so the swap is two
# renames on one volume; the old bundle is put back if the second rename fails.
echo "==> Installing to $app"
mkdir -p "$install_dir"
ditto "$built_app" "$staged"
if [ -e "$app" ]; then
  mv "$app" "$old"
  if ! mv "$staged" "$app"; then
    mv "$old" "$app"
    echo "Could not move the new app into place. The old app was restored." >&2
    exit 1
  fi
  to_trash "$old" previous || echo "The previous app was left at $old." >&2
else
  mv "$staged" "$app"
fi

# 4. Report.
echo "==> Installed Tokamak $commit at $app"
if [ "$was_running" = 1 ]; then
  open "$app" || echo "Open Tokamak again from $app." >&2
fi
