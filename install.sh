#!/bin/sh
# Installs the tab groups script for the current user. No root, no system paths, so
# it works on immutable systems such as KDE Linux / Fedora Atomic / SteamOS.
set -eu

SOURCE=$(cd "$(dirname "$0")" && pwd)
ID=tabgroups
TARGET="${XDG_DATA_HOME:-$HOME/.local/share}/kwin/scripts/$ID"

mkdir -p "$(dirname "$TARGET")"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -r "$SOURCE/metadata.json" "$SOURCE/contents" "$TARGET/"

# Compiled QML and JavaScript are cached on disk. Drop the cache so the next start
# is guaranteed to use the files that were just installed.
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/kwin/qmlcache"

kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" true
qdbus6 org.kde.KWin /KWin reconfigure >/dev/null 2>&1 || true
sleep 1

if [ "$(qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded "$ID" 2>/dev/null)" = "true" ]; then
    printf 'Installed and running: %s\n' "$TARGET"
else
    printf 'Installed: %s\n' "$TARGET"
    printf 'KWin has not picked it up yet; log out and back in (or run: qdbus6 org.kde.KWin /KWin reconfigure).\n'
fi

cat <<EOF

Usage
  drag one window's title bar onto another window (hold briefly) to group them
  Meta+G            group the active window with the next window
  Meta+Shift+G      ungroup
  Meta+PageUp/Down  cycle through the tabs
  Settings: System Settings > Window Management > KWin Scripts

Disable
  kwriteconfig6 --file kwinrc --group Plugins --key ${ID}Enabled false
  qdbus6 org.kde.KWin /KWin reconfigure

Uninstall
  rm -rf ${TARGET}

Updates
  KWin caches compiled QML/JS per URL for the lifetime of the process, so an
  update may not take effect until you log out and back in.
EOF
