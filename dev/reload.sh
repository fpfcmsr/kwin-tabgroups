#!/bin/sh
# Loads the script into the running KWin session without installing it.
#
# Two KWin details shape this script:
#   * unloadScript() removes a single instance per call and isScriptLoaded() keeps
#     reporting true until the deferred delete lands, so unload in a loop,
#   * compiled QML and JavaScript are cached per URL, so a reload of the same path
#     can keep running the previous revision. Each reload uses a fresh copy.
set -eu

SOURCE=$(cd "$(dirname "$0")/.." && pwd)
TARGET="/tmp/tabgroups-dev-$(date +%s%N)"

unload() {
    i=0
    while [ "$(qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded tabgroups 2>/dev/null)" != "false" ]; do
        qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript tabgroups >/dev/null 2>&1 || true
        i=$((i + 1))
        [ "$i" -gt 20 ] && break
        sleep 0.5
    done
}

cp -r "$SOURCE" "$TARGET"
unload
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadDeclarativeScript "$TARGET/contents/ui/main.qml" tabgroups
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start

printf 'loaded %s\n' "$TARGET"
