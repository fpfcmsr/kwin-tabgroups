// Session level checks for the controller: what happens to the tabs of a group and
// to the focus when a member leaves it, when a tab is switched, when the user
// minimizes the visible tab, and when KWin activates a tab on its own.
//
// The controller is driven through a fake KWin workspace - signal objects, window
// state, geometry, and the rule that KWin activates another window as soon as the
// focused one is minimized - so a whole session can be exercised without a
// compositor:  node dev/session-tests.mjs

// `Qt` is a QML global in the real runtime; only Qt.rect() is used.
globalThis.Qt = { rect: (x, y, width, height) => ({ x, y, width, height }) };

const base = new URL("../contents/code/", import.meta.url);
const Util = await import(new URL("util.mjs", base));
const Controller = await import(new URL("controller.mjs", base));

const results = [];
const check = (name, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    results.push({ ok: a === e, line: `${a === e ? "ok  " : "FAIL"} ${name}${a === e ? "" : ` got ${a} want ${e}`}` });
};
const rect = (x, y, width, height) => ({ x, y, width, height });

// --- fake KWin ---------------------------------------------------------------
// Only what the controller touches: the signals it connects to, the properties it
// reads, and the geometry/state setters it writes. The setters emit the matching
// signal, like KWin does, so the signal handlers are exercised as well. `events`
// records the order in which the session was touched, which is what tells a switch
// that keeps the focus with the group from one that makes KWin pick a window.
function signal() {
    const handlers = [];
    return {
        connect(handler) { if (handlers.indexOf(handler) < 0) handlers.push(handler); },
        disconnect(handler) { const index = handlers.indexOf(handler); if (index >= 0) handlers.splice(index, 1); },
        emit(...args) { for (const handler of handlers.slice()) handler(...args); }
    };
}

const events = [];
let windowSerial = 0;

// The window kinds KWin marks with a boolean property; the controller filters on
// all of them, so they have to exist.
const WINDOW_FLAGS = ["dock", "desktopWindow", "popupWindow", "appletPopup", "inputMethod", "outline",
                      "splash", "notification", "criticalNotification", "onScreenDisplay", "comboBox",
                      "dndIcon", "tooltip", "menu", "popupMenu", "dropdownMenu"];
const WINDOW_SIGNALS = ["interactiveMoveResizeStarted", "interactiveMoveResizeStepped",
                        "interactiveMoveResizeFinished", "frameGeometryChanged", "minimizedChanged",
                        "maximizedChanged", "demandsAttentionChanged", "captionChanged", "fullScreenChanged",
                        "closed"];

class FakeWindow {
    constructor(role, geometry) {
        this.internalId = "w" + (++windowSerial) + "-" + role;
        this._caption = role;
        this.resourceClass = "org.kde." + role;
        this.pid = 1000 + windowSerial;
        this.managed = true;
        this.deleted = false;
        this.normalWindow = true;
        this.noBorder = false;
        this.fullScreen = false;
        this.maximizeMode = 0;
        this.desktops = [1];
        this.onAllDesktops = true;
        this.output = "output-1";
        this.stackingOrder = windowSerial;
        for (const flag of WINDOW_FLAGS) {
            this[flag] = false;
        }
        for (const name of WINDOW_SIGNALS) {
            this[name] = signal();
        }
        this._frame = geometry;
        this._minimized = false;
        this._skipTaskbar = false;
        this._skipSwitcher = false;
        this._attention = false;
    }

    get frameGeometry() { return this._frame; }
    set frameGeometry(value) {
        this._frame = value;
        this.frameGeometryChanged.emit();
    }

    get clientGeometry() { return this._frame; }

    get minimized() { return this._minimized; }
    set minimized(value) {
        if (this._minimized === value) {
            return;
        }
        this._minimized = value;
        if (value) {
            // KWin moves the focus away from a window that gets minimized before it
            // reports the change (XdgToplevelWindow::doMinimize).
            workspace.leaveFocus(this);
        }
        events.push((value ? "minimize " : "unminimize ") + this.caption);
        this.minimizedChanged.emit();
    }

    get skipTaskbar() { return this._skipTaskbar; }
    set skipTaskbar(value) { this._skipTaskbar = value; }

    get skipSwitcher() { return this._skipSwitcher; }
    set skipSwitcher(value) { this._skipSwitcher = value; }

    get demandsAttention() { return this._attention; }
    set demandsAttention(value) {
        if (this._attention === value) {
            return;
        }
        this._attention = value;
        this.demandsAttentionChanged.emit();
    }

    get caption() { return this._caption; }
    set caption(value) {
        if (this._caption === value) {
            return;
        }
        this._caption = value;
        this.captionChanged.emit();
    }
}

const config = { promptOnDrop: false, groupDragOnStrip: true, overlap: 0.6, dwell: 250,
                 hideInactive: 1, rightInset: 150, barHeight: 30, dragOut: 48,
                 restoreAfterRestart: false, restoreWindowMinutes: 1440, matchTolerancePx: 40 };

// Everything the fake KWin does: focus changes, windows going away, and the view
// the controller pushes to the tab strip.
const workspace = {
    windowAdded: signal(),
    windowRemoved: signal(),
    windowActivated: signal(),
    windows: [],
    currentDesktop: 1,
    focusHistory: [],
    raiseWindow(window) { workspace.activeWindow = window; },
    // Workspace::activateNextWindow(): when the focused window stops being usable,
    // KWin hands the focus to the next window of its focus chain.
    leaveFocus(window) {
        if (workspace.activeWindow !== window) {
            return;
        }
        const next = workspace.focusHistory.find((candidate) => candidate !== window
                                                                  && !candidate.minimized
                                                                  && !candidate.deleted);
        events.push("kwin-focus " + (next ? next.caption : "none"));
        workspace.activeWindow = next || null;
    }
};

let active = null;
Object.defineProperty(workspace, "activeWindow", {
    get() { return active; },
    set(window) {
        if (active === window) {
            return;
        }
        active = window;
        if (window) {
            const index = workspace.focusHistory.indexOf(window);
            if (index >= 0) {
                workspace.focusHistory.splice(index, 1);
            }
            workspace.focusHistory.unshift(window);
        }
        events.push("focus " + (window ? window.caption : "none"));
        workspace.windowActivated.emit(window);
    }
});

let view = null;
const open = (...windows) => {
    workspace.windows = workspace.windows.concat(windows);
    for (const window of windows) {
        workspace.windowAdded.emit(window);
        if (!workspace.activeWindow) {
            workspace.activeWindow = window;   // KWin focuses the first window of a session
        }
    }
};
// The user (or an application) putting a window in front.
const focus = (window) => {
    workspace.activeWindow = window;
};
// A window going away, in the order KWin reports it: the window is gone, another
// one takes the focus, then the signals arrive.
const close = (window, successor) => {
    window.deleted = true;
    focus(successor);
    window.closed.emit();
    workspace.windows = workspace.windows.filter((candidate) => candidate !== window);
    workspace.windowRemoved.emit(window);
};
// The controller defers some decisions to the next timer tick; move the clock on
// instead of sleeping. Qt's JS engine refuses to move Date.now, so the checks that
// need it are skipped there.
function advance(milliseconds) {
    const realNow = Date.now;
    let moved = false;
    try {
        Date.now = () => realNow() + milliseconds;
        moved = Date.now() !== realNow();
    } catch (error) {
        moved = false;
    }
    if (moved) {
        Controller.tick();
        Date.now = realNow;
    }
    return moved;
}
const strip = () => ({ visible: view.visible, tabs: view.tabs.map((tab) => tab.title) });
const tabStates = () => view.tabs.map((tab) => [tab.title, tab.active, tab.attention]);
const state = (window) => ({ minimized: window.minimized,
                             skipTaskbar: window.skipTaskbar,
                             skipSwitcher: window.skipSwitcher,
                             geometry: Util.geometryOf(window) });
// A window that is a regular window again: not minimized, in the task bar, in the
// switcher, and back at the geometry it had before it joined a group.
const plain = (geometry) => ({ minimized: false, skipTaskbar: false, skipSwitcher: false, geometry: geometry });
// A tab that is hidden behind the visible one.
const hidden = (geometry) => ({ minimized: true, skipTaskbar: false, skipSwitcher: true, geometry: geometry });

// --- grouping two windows
const pairA = new FakeWindow("editor", rect(100, 100, 800, 600));
const pairB = new FakeWindow("files", rect(300, 250, 500, 400));
Controller.init({ ui: { setView: (next) => { view = next; } }, workspace: workspace, config: config,
                  settings: null, overlayCaption: "tabgroups-test-strip" });
open(pairA, pairB);

Controller.groupPair(pairA, pairB);
focus(pairB);
check("the dropped window becomes the shown tab", state(pairB), plain(rect(100, 100, 800, 600)));
check("the tab behind it is minimized but stays in the task bar", state(pairA), hidden(rect(100, 100, 800, 600)));
check("two windows form one group", strip(), { visible: true, tabs: ["editor", "files"] });

// --- minimizing the visible tab puts the whole group away ----------------------
// The group is the only thing on screen, so KWin has nothing else to focus and the
// strip goes with the group.
pairB.minimized = true;
check("every tab is minimized", [pairA.minimized, pairB.minimized], [true, true]);
check("the strip is gone while the group is collapsed", strip(), { visible: false, tabs: [] });
pairB.minimized = false;
focus(pairB);
check("only the visible tab comes back", [pairA.minimized, pairB.minimized], [true, false]);
check("the strip is back", strip(), { visible: true, tabs: ["editor", "files"] });
check("the tab behind it kept its minimized state", state(pairA), hidden(rect(100, 100, 800, 600)));

// --- switching tabs keeps the focus with the group -----------------------------
// KWin activates another window as soon as the focused one is minimized, so the
// incoming tab has to take the focus before the outgoing one is hidden.
const other = new FakeWindow("browser", rect(600, 400, 500, 400));
open(other);
focus(other);
focus(pairB);
events.length = 0;
Controller.switchTo(0);
check("the incoming tab takes the focus before the old one is minimized",
    [events.indexOf("focus editor") >= 0 && events.indexOf("focus editor") < events.indexOf("minimize files"),
     events.filter((event) => event.indexOf("kwin-focus") === 0)],
    [true, []]);
check("the tab that was shown is hidden now", state(pairB), hidden(rect(100, 100, 800, 600)));
check("the visible tab is a regular window", state(pairA), plain(rect(100, 100, 800, 600)));
check("the unrelated window was left alone", state(other), plain(rect(600, 400, 500, 400)));

// --- a tab that something else brings forward becomes the visible one ----------
// This is how a click on a tab's task bar entry arrives: KWin shows the window and
// moves the focus, without asking the script. The group was showing its first tab.
focus(pairA);
pairB.minimized = false;
focus(pairB);
check("the activated tab becomes the visible one",
    [strip(), tabStates()], [{ visible: true, tabs: ["editor", "files"] },
                             [["editor", false, false], ["files", true, false]]]);
check("the tab it replaced is hidden again", state(pairA), hidden(rect(100, 100, 800, 600)));
check("the activated tab is a regular window", state(pairB), plain(rect(100, 100, 800, 600)));

// --- closing the shown tab of a two window group -------------------------------
// The remaining tab sat minimized behind the shown one; closing the shown window
// must leave that window as regular as it was before it joined the group.
close(pairB, pairA);
check("the remaining window is a regular window again", state(pairA), plain(rect(100, 100, 800, 600)));
check("the group is gone once one window is left", strip(), { visible: false, tabs: [] });

// --- closing the tab behind the group -----------------------------------------
// The shown tab had been moved onto the covered one, so it goes back to its own
// geometry instead of keeping the geometry of the group.
const closeCoveredA = new FakeWindow("editor", rect(100, 100, 800, 600));
const closeCoveredB = new FakeWindow("files", rect(300, 250, 500, 400));
open(closeCoveredA, closeCoveredB);
Controller.groupPair(closeCoveredA, closeCoveredB);
focus(closeCoveredB);
close(closeCoveredA, closeCoveredB);
check("closing a hidden tab restores the shown one", state(closeCoveredB), plain(rect(300, 250, 500, 400)));

// --- closing a tab of a three window group ------------------------------------
const trioA = new FakeWindow("editor", rect(100, 100, 800, 600));
const trioB = new FakeWindow("files", rect(200, 150, 700, 500));
const trioC = new FakeWindow("photos", rect(300, 200, 600, 400));
open(trioA, trioB, trioC);
Controller.groupPair(trioA, trioB);
Controller.groupPair(trioB, trioC);
focus(trioC);
check("three windows form one group", strip(), { visible: true, tabs: ["editor", "files", "photos"] });
close(trioC, trioB);
check("the group survives losing a tab", strip(), { visible: true, tabs: ["editor", "files"] });
check("the tab that takes over is shown", state(trioB), plain(rect(100, 100, 800, 600)));
check("the other tab stays hidden", state(trioA), hidden(rect(100, 100, 800, 600)));

// --- detaching a tab from a two window group ----------------------------------
const detachA = new FakeWindow("editor", rect(100, 100, 800, 600));
const detachB = new FakeWindow("files", rect(300, 250, 500, 400));
open(detachA, detachB);
Controller.groupPair(detachA, detachB);
focus(detachB);
check("the detach starts from a group", strip(), { visible: true, tabs: ["editor", "files"] });
Controller.detachTab(0);
check("the detached window goes back to its own geometry", state(detachA), plain(rect(100, 100, 800, 600)));
check("the window left behind goes back to its own geometry", state(detachB), plain(rect(300, 250, 500, 400)));

// --- dragging a tab of a two window group into another window -----------------
const moveA = new FakeWindow("editor", rect(100, 100, 800, 600));
const moveB = new FakeWindow("files", rect(300, 250, 500, 400));
const moveC = new FakeWindow("photos", rect(500, 400, 400, 300));
open(moveA, moveB, moveC);
Controller.groupPair(moveA, moveB);
Controller.groupPair(moveC, moveB);
focus(moveB);
check("the tab left behind is a regular window again", state(moveA), plain(rect(100, 100, 800, 600)));
check("the new group holds both windows", strip(), { visible: true, tabs: ["photos", "files"] });
check("the new group has taken over the geometry", state(moveB), plain(rect(500, 400, 400, 300)));

// --- a tab restored behind the group is put back -------------------------------
const backA = new FakeWindow("editor", rect(100, 100, 800, 600));
const backB = new FakeWindow("files", rect(300, 250, 500, 400));
open(backA, backB);
Controller.groupPair(backA, backB);
focus(backB);
backA.minimized = false;
if (advance(100)) {
    check("a tab restored behind the group is hidden again", backA.minimized, true);
} else {
    console.log("skip: a tab restored behind the group (the clock cannot be moved)");
}

// --- a tab that wants attention is marked in the strip -------------------------
backA.demandsAttention = true;
check("the strip marks the tab that wants attention", tabStates(),
    [["editor", false, true], ["files", true, false]]);

// --- cover mode keeps the tabs mapped -----------------------------------------
Controller.reloadConfig(Object.assign({}, config, { hideInactive: 0 }));
const coverA = new FakeWindow("editor", rect(100, 100, 800, 600));
const coverB = new FakeWindow("files", rect(300, 250, 500, 400));
open(coverA, coverB);
Controller.groupPair(coverA, coverB);
focus(coverB);
check("a covered tab stays mapped and only leaves the switcher", state(coverA),
    { minimized: false, skipTaskbar: false, skipSwitcher: true, geometry: rect(100, 100, 800, 600) });
events.length = 0;
Controller.switchTo(0);
check("switching still leaves the other tab mapped", [state(coverA).minimized, state(coverB).minimized], [false, false]);
check("the switch kept the focus with the group", events, ["focus editor"]);

// --- a window that retitles itself is renamed in the strip ---------------------
// What a file manager or browser does while it works: the title changes on its own,
// with no click and no tab switch involved.
coverA.caption = "editor: Downloads";
coverB.caption = "files: Home";
check("the strip follows a window title that changes on its own", strip().tabs, ["editor: Downloads", "files: Home"]);

const failures = results.filter((result) => !result.ok);
for (const result of results) {
    console.log(result.line);
}
console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
if (typeof process !== "undefined") {
    process.exit(failures.length === 0 ? 0 : 1);
}
