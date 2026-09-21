// Entry point of the tab groups script: configuration, global shortcuts and the
// bridge between the tab strip and the controller.

import QtQuick
import QtCore
import org.kde.kwin 3.0 as KWinApi
import "../code/controller.mjs" as Controller

Item {
    id: shell

    property var configuration: readConfiguration()
    property var barWindow: null

    // Everything the tab strip may call back into.
    readonly property var ctl: ({
        switchTo: function (index) { Controller.switchTo(index); },
        detachTab: function (index) { Controller.detachTab(index); },
        reorderTab: function (from, to) { Controller.reorderTab(from, to); },
        moveGroupBy: function (dx, dy) { Controller.moveGroupBy(dx, dy); },
        ungroupAll: function () { Controller.ungroupActive(); },
        acceptPrompt: function () { Controller.acceptPrompt(); },
        cancelPrompt: function () { Controller.cancelPrompt(); }
    })

    // The controller pushes a view model; the strip lives in its own window.
    function setView(view) {
        if (barWindow) {
            barWindow.applyView(view);
        }
    }

    // The strip must not be a child of an item: a Window declared inside an item
    // only becomes a transient child of a parent window, and a script has none.
    function createBar() {
        var component = Qt.createComponent("TabBarWindow.qml");
        if (component.status !== Component.Ready) {
            throw new Error("tabgroups: strip component failed: " + component.errorString());
        }
        barWindow = component.createObject(null);
        if (!barWindow) {
            throw new Error("tabgroups: strip window was not created");
        }
        barWindow.ctl = shell.ctl;
        barWindow.shown.connect(Controller.overlayShown);
    }

    function readConfiguration() {
        return {
            promptOnDrop: KWin.readConfig("PromptOnDrop", true),
            groupDragOnStrip: KWin.readConfig("GroupDragOnStrip", true),
            overlap: Number(KWin.readConfig("OverlapThreshold", 60)) / 100,
            dwell: Number(KWin.readConfig("DwellTimeMs", 250)),
            hideInactive: Number(KWin.readConfig("HideInactive", 1)),
            rightInset: Number(KWin.readConfig("RightInset", 150)),
            barHeight: Number(KWin.readConfig("BarHeight", 30)),
            dragOut: Number(KWin.readConfig("DragOutDistance", 48)),
            restoreAfterRestart: KWin.readConfig("RestoreAfterRestart", false),
            restoreWindowMinutes: Number(KWin.readConfig("RestoreWindowMinutes", 1440)),
            matchTolerancePx: Number(KWin.readConfig("MatchTolerancePx", 40))
        };
    }

    function reloadConfiguration() {
        shell.configuration = readConfiguration();
        Controller.reloadConfig(shell.configuration);
    }

    // Group state. `session` rebuilds groups when the script is reloaded while the
    // windows are still open, `restore` describes them well enough to rebuild them
    // after a restart (see the RestoreAfterRestart option).
    Settings {
        id: stateStore

        category: "tabgroups"
        property string session: ""
        property string restore: ""
    }

    Connections {
        target: KWinApi.Options

        function onConfigChanged() {
            shell.reloadConfiguration();
        }
    }

    // Mouse-free access to the same actions.
    KWinApi.ShortcutHandler {
        name: "tabgroups-group-with-next"
        text: i18n("Tab Groups: group window with the next window")
        sequence: "Meta+G"
        onActivated: Controller.groupActiveWithNext()
    }

    KWinApi.ShortcutHandler {
        name: "tabgroups-ungroup"
        text: i18n("Tab Groups: ungroup")
        sequence: "Meta+Shift+G"
        onActivated: Controller.ungroupActive()
    }

    KWinApi.ShortcutHandler {
        name: "tabgroups-next-tab"
        text: i18n("Tab Groups: next tab")
        sequence: "Meta+PageDown"
        onActivated: Controller.nextTab(1)
    }

    KWinApi.ShortcutHandler {
        name: "tabgroups-previous-tab"
        text: i18n("Tab Groups: previous tab")
        sequence: "Meta+PageUp"
        onActivated: Controller.nextTab(-1)
    }

    // Drives the controller's short timers (overlay lookup, focus re-assertion).
    Timer {
        interval: 100
        repeat: true
        running: true
        onTriggered: Controller.tick()
    }

    Component.onCompleted: {
        shell.createBar();
        Controller.init({
            ui: shell,
            workspace: KWinApi.Workspace,
            config: shell.configuration,
            settings: stateStore,
            overlayCaption: barWindow.title
        });
    }

    Component.onDestruction: {
        Controller.shutdown();
        if (barWindow) {
            barWindow.destroy();
            barWindow = null;
        }
    }
}
