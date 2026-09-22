#!/bin/sh
# Loads the script into the running KWin session without installing it.
#
# Three KWin details shape this script:
#   * unloadScript() removes a single instance per call and isScriptLoaded() keeps
#     reporting true until the deferred delete lands, so unload in a loop,
#   * compiled QML and JavaScript are cached per URL, so a reload of the same path
#     can keep running the previous revision. Each reload uses a fresh copy,
#   * a command line D-Bus client has to be found first, it has no fixed name.
set -eu

SOURCE=$(cd "$(dirname "$0")/.." && pwd)
TARGET="/tmp/tabgroups-dev-$(date +%s%N)"

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

QDBUS=$(find_qdbus) || {
    printf 'reload.sh: no qdbus command found, install the Qt 6 D-Bus tool:\n' >&2
    printf '  Arch, SteamOS   qt6-tools\n' >&2
    printf '  Debian, Ubuntu  qdbus-qt6\n' >&2
    printf '  Fedora          qt6-qttools\n' >&2
    printf '  openSUSE        qt6-tools-qdbus\n' >&2
    exit 1
}

unload() {
    i=0
    while [ "$("$QDBUS" org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded tabgroups 2>/dev/null)" != "false" ]; do
        "$QDBUS" org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript tabgroups >/dev/null 2>&1 || true
        i=$((i + 1))
        [ "$i" -gt 20 ] && break
        sleep 0.5
    done
}

cp -r "$SOURCE" "$TARGET"
unload
"$QDBUS" org.kde.KWin /Scripting org.kde.kwin.Scripting.loadDeclarativeScript "$TARGET/contents/ui/main.qml" tabgroups
"$QDBUS" org.kde.KWin /Scripting org.kde.kwin.Scripting.start

printf 'loaded %s\n' "$TARGET"
