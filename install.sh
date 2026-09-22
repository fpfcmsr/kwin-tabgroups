#!/bin/sh
# Installs the tab groups script for the current user.
set -eu

SOURCE=$(cd "$(dirname "$0")" && pwd)
ID=tabgroups
TARGET="${XDG_DATA_HOME:-$HOME/.local/share}/kwin/scripts/$ID"

# The Qt D-Bus client has no stable name: qdbus6, qdbus-qt, qdbus in use
# scan the Qt bin directories and PATH for client shaped names and use the first one
# that runs. Qt 6 names come first: Fedora keeps a Qt 4 /usr/bin/qdbus around.
find_qdbus() {
    _ifs=$IFS
    IFS=:
    # shellcheck disable=SC2086  # PATH is meant to split on IFS here
    set -- /usr/lib*/qt6/bin /usr/lib/*/qt6/bin /usr/libexec/qt6 ${PATH:-}
    IFS=$_ifs

    for pass in qt6 any; do
        for dir in "$@"; do
            for f in "$dir"/qdbus* "$dir"/qt*-qdbus; do
                case ${f##*/} in
                    qdbus6|qdbus-qt6|qt6-qdbus) ;;
                    # qdbus, also version suffixed, possibly a Qt 4 leftover
                    qdbus|qdbus[0-9]|qdbus-qt[0-9]|qt[0-9]-qdbus)
                        [ "$pass" = any ] || continue ;;
                    *) continue ;; # qdbusviewer, qdbuscpp2xml, qdbusxml2cpp
                esac
                [ -x "$f" ] || continue
                # --help needs no bus connection, so a broken install is skipped
                "$f" --help >/dev/null 2>&1 || continue
                printf '%s' "$f"
                return 0
            done
        done
    done
    return 1
}

QDBUS=$(find_qdbus) || QDBUS=

mkdir -p "$(dirname "$TARGET")"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -r "$SOURCE/metadata.json" "$SOURCE/contents" "$TARGET/"

# Compiled QML and JavaScript are cached on disk. Drop the cache so the next start
# is guaranteed to use the files that were just installed.
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/kwin/qmlcache"

kwriteconfig6 --file kwinrc --group Plugins --key "${ID}Enabled" true
LOADED=
if [ -n "$QDBUS" ]; then
    "$QDBUS" org.kde.KWin /KWin reconfigure >/dev/null 2>&1 || true
    sleep 1
    LOADED=$("$QDBUS" org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded "$ID" 2>/dev/null || true)
fi

if [ "$LOADED" = "true" ]; then
    printf 'Installed and running: %s\n' "$TARGET"
else
    printf 'Installed: %s\n' "$TARGET"
    if [ -n "$QDBUS" ]; then
        printf 'KWin has not picked it up yet; log out and back in (or run: %s org.kde.KWin /KWin reconfigure).\n' "$QDBUS"
    else
        printf 'KWin has not picked it up yet; log out and back in to load it.\n'
        printf 'No qdbus command found, so the running session could not be asked to reconfigure.\n'
    fi
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
  ${QDBUS:-qdbus6} org.kde.KWin /KWin reconfigure

Uninstall
  rm -rf ${TARGET}

Updates
  KWin caches compiled QML/JS per URL for the lifetime of the process, so an
  update may not take effect until you log out and back in.
EOF
