// Wires the KWin window model to the group store, the presentation policy and the
// tab strip UI. Everything the script does to real windows happens here.

import * as Util from "./util.mjs";
import * as Model from "./model.mjs";
import * as Policy from "./policy.mjs";
import * as Drag from "./drag.mjs";
import * as State from "./state.mjs";

var ui = null;
var ws = null;
var config = null;

var store = Model.createStore();
var registry = [];        // windows that may become tabs
var hooks = [];           // { window, handlers }
var drag = Drag.makeState();
var prompt = null;        // { target, dragged } while the user is asked
var suppress = false;     // true while the script itself changes window state
var timers = [];
var shuttingDown = false;
var overlayCaption = "tabgroups-overlay";   // replaced by init()
var overlayWindow = null;
var originalFlags = {};     // window identity -> the task bar state the window came with
var settings = null;         // QML Settings object used for both records
var restoreRecord = null;   // parsed "how to rebuild these groups later" record
var pendingRestore = null;  // { savedAt, entries } still waiting for their windows

// ------------------------------------------------------------------ lifecycle

// The QML workspace wrapper exposes `windows` as a list property, the JavaScript
// one exposes windowList(). Support both.
function allWindows() {
    var result = [];
    var source = ws.windows;
    if (source) {
        if (typeof source.length === "number") {
            for (var i = 0; i < source.length; ++i) {
                result.push(source[i]);
            }
        } else {
            for (var j = 0; source[j] !== undefined; ++j) {
                result.push(source[j]);
            }
        }
        return result;
    }
    if (typeof ws.windowList === "function") {
        return ws.windowList();
    }
    return result;
}

export function init(api) {
    ui = api.ui;
    ws = api.workspace;
    config = api.config;
    settings = api.settings || null;
    if (api.overlayCaption) {
        overlayCaption = api.overlayCaption;
    }

    ws.windowAdded.connect(onWindowAdded);
    ws.windowRemoved.connect(onWindowRemoved);
    ws.windowActivated.connect(onWindowActivated);

    var list = allWindows();
    for (var i = 0; i < list.length; ++i) {
        registerWindow(list[i]);
    }
    repairLeftovers();
    restoreSession();
    if (config.restoreAfterRestart) {
        loadRestoreRecord();
        startPendingRestore();
    }
    refresh();
}

export function reloadConfig(next) {
    config = next;
    if (restoreRecord) {
        State.pruneExpired(restoreRecord, config, Date.now());
    }
    if (config.restoreAfterRestart && !pendingRestore) {
        startPendingRestore();
    }
    applyActiveGroup();
    refresh();
}

// Unloading the script must leave the session as it was.
export function shutdown() {
    shuttingDown = true;
    persist();   // the last state is what a reload rebuilds from
    var groups = store.groups.slice();
    for (var i = 0; i < groups.length; ++i) {
        dissolveGroup(groups[i], true);
    }
    for (var j = 0; j < hooks.length; ++j) {
        disconnect(hooks[j]);
    }
    hooks = [];
    registry = [];
    store = Model.createStore();
    timers = [];
    setView({ visible: false, geometry: null, tabs: [], hint: "", prompt: null });
}

// ------------------------------------------------------------------ persistence

var saveScheduled = false;

function windowById(id) {
    for (var i = 0; i < registry.length; ++i) {
        if (String(registry[i].internalId) === id) {
            return registry[i];
        }
    }
    return null;
}

function groupForSignature(signature) {
    for (var i = 0; i < store.groups.length; ++i) {
        if (State.groupSignature(store.groups[i]) === signature) {
            return store.groups[i];
        }
    }
    return null;
}

function persist() {
    if (!settings) {
        return;
    }
    try {
        settings.session = JSON.stringify(State.sessionSnapshot(store));
        settings.restore = JSON.stringify(refreshedRestoreRecord());
        settings.sync();
    } catch (error) {
        console.warn("tabgroups: could not store state: " + error);
    }
}

function schedulePersist() {
    if (saveScheduled) {
        return;
    }
    saveScheduled = true;
    schedule(400, function () {
        saveScheduled = false;
        persist();
    });
}

// The restore record describes every group we know of: the live ones (fresh) and
// the ones whose windows are gone (kept until their time to live runs out), so
// that a restart can rebuild them. Deliberate ungrouping drops the entry.
function refreshedRestoreRecord() {
    var now = Date.now();
    var stale = [];
    if (restoreRecord && restoreRecord.groups) {
        for (var i = 0; i < restoreRecord.groups.length; ++i) {
            var entry = restoreRecord.groups[i];
            if (!groupForSignature(State.entrySignature(entry))) {
                stale.push(entry);
            }
        }
    }
    var combined = State.restoreSnapshot(store, now).groups.concat(stale);
    combined.sort(function (a, b) {
        return (b.savedAt || 0) - (a.savedAt || 0);
    });
    var seen = [];
    var kept = [];
    for (var j = 0; j < combined.length && kept.length < 8; ++j) {
        var signature = State.entrySignature(combined[j]);
        if (seen.indexOf(signature) >= 0) {
            continue;
        }
        seen.push(signature);
        kept.push(combined[j]);
    }
    restoreRecord = State.pruneExpired({ version: State.VERSION, groups: kept }, config, now);
    return restoreRecord;
}

function forgetRestoreEntry(group) {
    if (restoreRecord) {
        State.forgetGroup(restoreRecord, group);
    }
}

// Rebuilds the groups that were open when the script last ran. Only windows that
// are still open take part; a group that lost members keeps the rest.
function restoreSession() {
    if (!settings || !settings.session) {
        return;
    }
    var saved = null;
    try {
        saved = JSON.parse(settings.session);
    } catch (error) {
        return;
    }
    var plan = State.sessionPlan(saved, windowById);
    for (var i = 0; i < plan.length; ++i) {
        var item = plan[i];
        var group = null;
        for (var j = 0; j < item.members.length; ++j) {
            if (!group) {
                group = Model.createGroup(store, item.members[j], item.geometry);
            } else {
                Model.addMember(group, item.members[j], item.geometry);
            }
        }
        group.geometry = item.geometry;
        group.activeIndex = Math.min(item.activeIndex, group.members.length - 1);
        applyGroup(group);
    }
}

function loadRestoreRecord() {
    restoreRecord = null;
    if (!settings || !settings.restore) {
        return;
    }
    try {
        restoreRecord = State.pruneExpired(JSON.parse(settings.restore), config, Date.now());
    } catch (error) {
        restoreRecord = null;
    }
}

// Best effort restore after a restart: groups whose windows no longer exist are
// matched against the windows that are appearing now.
function startPendingRestore() {
    if (!config.restoreAfterRestart || !restoreRecord || !restoreRecord.groups || restoreRecord.groups.length === 0) {
        return;
    }
    var pending = [];
    for (var i = 0; i < restoreRecord.groups.length; ++i) {
        var entry = restoreRecord.groups[i];
        if (!groupForSignature(State.entrySignature(entry))) {
            pending.push({ entry: entry, group: null });
        }
    }
    if (pending.length === 0) {
        return;
    }
    pendingRestore = { savedAt: Date.now(), items: pending };
    resolvePendingRestore();
}

// Windows of a restarted session appear one at a time, so a saved group is
// rebuilt as soon as two of its windows are back and then grows while the rest
// arrive. An entry is only forgotten once all of its members are accounted for.
function resolvePendingRestore() {
    if (!pendingRestore) {
        return;
    }
    var now = Date.now();
    var ttl = config.restoreWindowMinutes * 60000;
    var taken = [];
    var entries = [];
    for (var i = 0; i < pendingRestore.items.length; ++i) {
        entries.push(pendingRestore.items[i].entry);
    }
    var results = State.coldMatches(entries, registry.slice(), config, now, taken);
    var changed = false;
    for (var j = 0; j < results.length; ++j) {
        var result = results[j];
        var item = null;
        for (var k = 0; k < pendingRestore.items.length; ++k) {
            if (pendingRestore.items[k].entry === result.entry) {
                item = pendingRestore.items[k];
                break;
            }
        }
        if (!item) {
            continue;
        }
        var fresh = [];
        for (var m = 0; m < result.members.length; ++m) {
            var window = result.members[m].window;
            if (!item.group || !Model.contains(store, window)) {
                fresh.push(result.members[m]);
            }
        }
        if (!item.group && fresh.length >= 2) {
            item.group = Model.createGroup(store, memberFromSlot(fresh[0]), result.entry.geometry);
            for (var n = 1; n < fresh.length; ++n) {
                Model.addMember(item.group, memberFromSlot(fresh[n]), result.entry.geometry);
            }
            changed = true;
        } else if (item.group) {
            for (var q = 0; q < fresh.length; ++q) {
                Model.addMember(item.group, memberFromSlot(fresh[q]), item.group.geometry);
                changed = true;
            }
        }
        if (item.group) {
            item.group.activeIndex = Math.min(result.entry.activeIndex || 0, item.group.members.length - 1);
            applyGroup(item.group);
        }
        if (result.complete || (now - (result.entry.savedAt || 0)) > ttl) {
            pendingRestore.items.splice(pendingRestore.items.indexOf(item), 1);
            changed = true;
        }
    }
    if (pendingRestore.items.length === 0) {
        pendingRestore = null;
    }
    if (changed) {
        persist();
        refresh();
    }
}

function memberFromSlot(member) {
    return {
        window: member.window,
        restore: member.slot.geometry,
        flags: originalFlagsOf(member.window)
    };
}

// ------------------------------------------------------------------ registry

export function registerWindow(window) {
    if (!window || findHook(window) || !isGroupable(window)) {
        return;
    }
    registry.push(window);
    connectWindow(window);
}

export function isGroupable(window) {
    if (!window.managed || window.deleted) {
        return false;
    }
    if (window.pid <= 0) {
        return false;   // KWin's own internal windows have no client process
    }
    if (window.dock || window.desktopWindow || window.popupWindow || window.appletPopup) {
        return false;
    }
    if (window.inputMethod || window.outline || window.splash) {
        return false;
    }
    if (window.notification || window.criticalNotification || window.onScreenDisplay) {
        return false;
    }
    if (window.comboBox || window.dndIcon || window.tooltip || window.menu) {
        return false;
    }
    if (window.popupMenu || window.dropdownMenu) {
        return false;
    }
    if (window.caption === overlayCaption) {
        return false;   // our own tab strip
    }
    return window.normalWindow || window.dialog || window.utility || window.toolbar;
}

export function connectWindow(window) {
    var handlers = {
        started: function () { onInteractiveStarted(window); },
        stepped: function (geometry) { onInteractiveStepped(window, geometry); },
        finished: function () { onInteractiveFinished(window); },
        geometry: function () { onFrameGeometryChanged(window); },
        minimized: function () { onMinimizedChanged(window); },
        maximized: function () { onMaximizedChanged(window); },
        attention: function () { refreshMember(window); },
        caption: function () { refreshMember(window); },
        fullscreen: function () { refresh(); },
        closed: function () { onWindowClosed(window); }
    };
    window.interactiveMoveResizeStarted.connect(handlers.started);
    window.interactiveMoveResizeStepped.connect(handlers.stepped);
    window.interactiveMoveResizeFinished.connect(handlers.finished);
    window.frameGeometryChanged.connect(handlers.geometry);
    window.minimizedChanged.connect(handlers.minimized);
    window.maximizedChanged.connect(handlers.maximized);
    window.demandsAttentionChanged.connect(handlers.attention);
    window.captionChanged.connect(handlers.caption);
    window.fullScreenChanged.connect(handlers.fullscreen);
    window.closed.connect(handlers.closed);
    hooks.push({ window: window, handlers: handlers });
}

export function disconnect(hook) {
    hook.window.interactiveMoveResizeStarted.disconnect(hook.handlers.started);
    hook.window.interactiveMoveResizeStepped.disconnect(hook.handlers.stepped);
    hook.window.interactiveMoveResizeFinished.disconnect(hook.handlers.finished);
    hook.window.frameGeometryChanged.disconnect(hook.handlers.geometry);
    hook.window.minimizedChanged.disconnect(hook.handlers.minimized);
    hook.window.maximizedChanged.disconnect(hook.handlers.maximized);
    hook.window.demandsAttentionChanged.disconnect(hook.handlers.attention);
    hook.window.captionChanged.disconnect(hook.handlers.caption);
    hook.window.fullScreenChanged.disconnect(hook.handlers.fullscreen);
    hook.window.closed.disconnect(hook.handlers.closed);
}

export function findHook(window) {
    for (var i = 0; i < hooks.length; ++i) {
        if (hooks[i].window === window) {
            return hooks[i];
        }
    }
    return null;
}

export function unregisterWindow(window) {
    delete originalFlags[String(window.internalId)];
    var hook = findHook(window);
    if (hook) {
        disconnect(hook);
        hooks.splice(hooks.indexOf(hook), 1);
    }
    var index = registry.indexOf(window);
    if (index >= 0) {
        registry.splice(index, 1);
    }
}

export function onWindowAdded(window) {
    registerWindow(window);
    resolveOverlay();
    if (pendingRestore) {
        resolvePendingRestore();
    }
}

export function onWindowRemoved(window) {
    unregisterWindow(window);
    refresh();
}

export function onWindowClosed(window) {
    var group = Model.groupForWindow(store, window);
    unregisterWindow(window);
    if (!group) {
        refresh();
        return;
    }
    var member = Model.memberFor(group, window);
    var wasActive = !!member && Model.activeMember(group) === member;
    Model.removeMember(group, window);
    if (group.members.length < 2) {
        // The last tab of the group: dissolving restores its window, so that
        // closing one tab never takes the remaining window with it.
        dissolveGroup(group, true);
    } else {
        if (wasActive && !group.collapsed) {
            activate(group, Model.activeMember(group).window);
        } else {
            // A collapsed group stays collapsed: closing a tab must not bring the
            // remaining ones back on screen.
            applyGroup(group);
        }
    }
    refresh();
}

export function onWindowActivated() {
    if (suppress) {
        return;   // a consequence of our own state changes, the caller refreshes
    }
    adoptActiveWindow();
    refresh();
}

// The strip shows the tabs of a group and nothing else, so a title or attention
// change of a window that is not in one has nothing to update.
function refreshMember(window) {
    if (Model.contains(store, window)) {
        refresh();
    }
}

// KWin is the authority on which window has the focus. When it activates another
// tab of a group - a task bar entry, the window switcher, the application itself -
// that tab becomes the visible one, instead of the session and the group ending up
// disagreeing about which window is on screen.
function adoptActiveWindow() {
    var window = ws.activeWindow;
    var group = window ? Model.groupForWindow(store, window) : null;
    var member = group ? Model.memberFor(group, window) : null;
    if (member && (Model.activeMember(group) !== member || group.collapsed)) {
        activate(group, window);
    }
}

// ------------------------------------------------------------------ grouping

export function activeGroup() {
    return Model.groupForWindow(store, ws.activeWindow);
}

export function makeMember(window) {
    return {
        window: window,
        restore: Util.geometryOf(window),
        flags: originalFlagsOf(window)
    };
}

// The flags a window came with. Recorded once, so that a window which was an
// inactive tab before does not hand our own skip flags to its next group.
function originalFlagsOf(window) {
    var key = String(window.internalId);
    if (!originalFlags[key]) {
        originalFlags[key] = {
            skipTaskbar: !!window.skipTaskbar,
            skipSwitcher: !!window.skipSwitcher
        };
    }
    return originalFlags[key];
}

// A previous run can be interrupted (unloaded script, crashed compositor) and
// leave hidden-from-taskbar-and-switcher windows behind. They are invisible to
// the user, so they are released on startup.
function repairLeftovers() {
    for (var i = 0; i < registry.length; ++i) {
        var window = registry[i];
        if (!window.skipTaskbar || !window.skipSwitcher || Model.contains(store, window)) {
            continue;
        }
        suppress = true;
        window.minimized = false;
        window.skipTaskbar = false;
        window.skipSwitcher = false;
        suppress = false;
    }
}

export function groupActiveWithNext() {
    var active = ws.activeWindow;
    if (!active || !isGroupable(active)) {
        return;
    }
    var partner = findPartner(Model.groupForWindow(store, active));
    if (partner) {
        groupPair(partner, active);
    }
}

export function findPartner(excludeGroup) {
    var active = ws.activeWindow;
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < registry.length; ++i) {
        var window = registry[i];
        if (window === active || window.minimized || window.deleted) {
            continue;
        }
        var group = Model.groupForWindow(store, window);
        if (excludeGroup && group === excludeGroup) {
            continue;
        }
        if (!onCurrentDesktop(window)) {
            continue;
        }
        var score = 0;
        if (window.output === active.output) {
            score += 2;
        }
        if (window.stackingOrder > active.stackingOrder) {
            score += 1;
        }
        if (score > bestScore) {
            bestScore = score;
            best = window;
        }
    }
    return best;
}

export function onCurrentDesktop(window) {
    return window.onAllDesktops || window.desktops.indexOf(ws.currentDesktop) >= 0;
}

// Makes `dragged` a tab of the group that owns `target`.
export function groupPair(target, dragged) {
    if (!target || !dragged || target === dragged || !isGroupable(dragged)) {
        return;
    }
    var targetGroup = Model.groupForWindow(store, target);
    var draggedGroup = Model.groupForWindow(store, dragged);
    if (targetGroup && targetGroup === draggedGroup) {
        return;
    }

    var geometry = Util.geometryOf(target);
    leaveEveryGroup(dragged);

    var group = targetGroup;
    if (!group) {
        group = Model.createGroup(store, makeMember(target), geometry);
    }
    Model.addMember(group, makeMember(dragged), geometry);
    group.geometry = geometry;
    Model.setActive(group, dragged);

    applyGroup(group);
    activate(group, dragged);
    refresh();
}

// Turns the active group back into independent windows.
export // Removes the window from whichever group still lists it, so that a group can
// never end up with a member that belongs to another group.
function leaveEveryGroup(window) {
    var key = String(window.internalId);
    for (var i = store.groups.length - 1; i >= 0; --i) {
        var group = store.groups[i];
        for (var j = group.members.length - 1; j >= 0; --j) {
            if (String(group.members[j].window.internalId) === key) {
                Model.removeMember(group, window);
                if (group.members.length < 2) {
                    dissolveGroup(group, false);
                } else {
                    applyGroup(group);
                }
                break;
            }
        }
    }
}

export function ungroupActive() {
    var group = activeGroup();
    if (group) {
        forgetRestoreEntry(group);
        dissolveGroup(group, true);
        persist();
        refresh();
    }
}

export function dissolveGroup(group, restoreGeometry) {
    var members = group.members.slice();
    for (var i = 0; i < members.length; ++i) {
        restoreMember(members[i], restoreGeometry);
    }
    Model.dissolve(store, group);
}

export function detachTab(index) {
    var group = activeGroup();
    if (!group || index < 0 || index >= group.members.length) {
        return;
    }
    forgetRestoreEntry(group);
    detachFromGroup(group, group.members[index].window, true);
    persist();
    refresh();
}

export function detachFromGroup(group, window, restoreGeometry) {
    var member = Model.memberFor(group, window);
    if (!member) {
        return;
    }
    var wasActive = Model.activeMember(group) === member;
    Model.removeMember(group, window);
    restoreMember(member, restoreGeometry);

    if (group.members.length < 2) {
        dissolveGroup(group, true);
        return;
    }
    if (wasActive && !group.collapsed) {
        activate(group, Model.activeMember(group).window);
    } else {
        applyGroup(group);
    }
}

export function switchTo(index) {
    var group = activeGroup();
    if (!group || index < 0 || index >= group.members.length) {
        return;
    }
    activate(group, group.members[index].window);
    refresh();
}

export function nextTab(delta) {
    var group = activeGroup();
    if (!group || group.members.length < 2) {
        return;
    }
    var count = group.members.length;
    var index = ((Model.activeIndex(group) + delta) % count + count) % count;
    switchTo(index);
}

export function reorderTab(from, to) {
    var group = activeGroup();
    if (group && Model.reorder(group, from, to)) {
        refresh();
    }
}

export function moveGroupBy(dx, dy) {
    var group = activeGroup();
    if (!group || !config.groupDragOnStrip) {
        return;
    }
    group.geometry = Util.translated(group.geometry, dx, dy);
    applyGroup(group);
    refresh();
}

// Makes `window` the visible tab of its group. The tab that is brought forward
// takes the focus before the tab that was shown before it is hidden: minimizing
// the focused window makes KWin activate some other window, which is what the task
// manager then reports as the active task.
export function activate(group, window) {
    var member = Model.memberFor(group, window);
    if (!member) {
        return;
    }
    group.collapsed = false;
    Model.setActive(group, window);
    showMember(group, member);
    requestFocus(window);
    hideMembers(group, window);
    ensureFocus(window);
}

// ------------------------------------------------------------------ application

export function applyActiveGroup() {
    var group = activeGroup();
    if (group) {
        applyGroup(group);
    }
}

// Makes the windows match the model: the visible tab first, so that hiding the
// others cannot take the focus away from it, then everyone else.
export function applyGroup(group) {
    var active = group ? Model.activeMember(group) : null;
    if (!active) {
        return;
    }
    showMember(group, active);
    if (!group.collapsed) {
        // A rebuilt group can have the focus on a tab other than its own visible
        // one; hiding that tab would bounce the focus onto an unrelated window.
        focusVisibleTab(group, active);
    }
    hideMembers(group, active.window);
}

// Geometry plus the state of the tab that is on screen.
function showMember(group, member) {
    suppress = true;
    setGeometry(member.window, group.geometry);
    applyState(member.window, memberState(group, member, true));
    suppress = false;
}

// Geometry plus the hidden state of every other tab.
function hideMembers(group, activeWindow) {
    suppress = true;
    for (var i = 0; i < group.members.length; ++i) {
        var member = group.members[i];
        if (member.window === activeWindow) {
            continue;
        }
        setGeometry(member.window, group.geometry);
        applyState(member.window, memberState(group, member, false));
    }
    suppress = false;
}

function memberState(group, member, isActive) {
    return Policy.desiredState(member, isActive, config.hideInactive, group.collapsed);
}

function focusVisibleTab(group, active) {
    var focused = ws.activeWindow;
    if (!focused || focused === active.window) {
        return;
    }
    if (!Model.memberFor(group, focused)) {
        return;   // the focus is elsewhere, the group can wait
    }
    requestFocus(active.window);
}

// Activation is a request: KWin can turn it down (blocked focus changes, a window
// that cannot take input), so it is never assumed to have happened.
function requestFocus(window) {
    if (!window || window.deleted || ws.activeWindow === window) {
        return;
    }
    ws.raiseWindow(window);
    ws.activeWindow = window;
}

// KWin activates another window as soon as the focused one is minimized, so a
// switch that did not take is repeated once the state changes have settled.
function ensureFocus(window) {
    if (ws.activeWindow === window) {
        return;
    }
    schedule(60, function () {
        if (shuttingDown || ws.activeWindow === window || !Model.contains(store, window)) {
            return;
        }
        requestFocus(window);
        refresh();
    });
}

export function applyState(window, state) {
    if (window.minimized !== state.minimized) {
        window.minimized = state.minimized;
    }
    if (window.skipTaskbar !== state.skipTaskbar) {
        window.skipTaskbar = state.skipTaskbar;
    }
    if (window.skipSwitcher !== state.skipSwitcher) {
        window.skipSwitcher = state.skipSwitcher;
    }
}

export function setGeometry(window, rect) {
    if (Util.same(Util.geometryOf(window), rect)) {
        return;
    }
    var wasSuppressed = suppress;
    suppress = true;
    window.frameGeometry = Util.toQtRect(rect);
    if (!Util.same(Util.geometryOf(window), rect)) {
        // Wayland clients may refuse a configure request once; nudge and retry.
        var actual = Util.geometryOf(window);
        window.frameGeometry = Util.toQtRect(Util.rect(rect.x, rect.y, actual.width, actual.height));
        window.frameGeometry = Util.toQtRect(rect);
    }
    suppress = wasSuppressed;
}

export function restoreMember(member, restoreGeometry) {
    var window = member.window;
    suppress = true;
    if (restoreGeometry && member.restore) {
        setGeometry(window, member.restore);
    }
    window.minimized = false;
    window.skipTaskbar = member.flags.skipTaskbar;
    window.skipSwitcher = member.flags.skipSwitcher;
    suppress = false;
}

// ------------------------------------------------------------------ window signals

export function onFrameGeometryChanged(window) {
    if (suppress) {
        return;
    }
    var group = Model.groupForWindow(store, window);
    if (!group) {
        return;
    }
    var active = Model.activeMember(group);
    if (!active || active.window !== window) {
        return;   // only the visible tab drives the shared geometry
    }
    var geometry = Util.geometryOf(window);
    if (Util.same(geometry, group.geometry)) {
        return;
    }
    group.geometry = geometry;
    applyGroup(group);
    refresh();
}

export function onMinimizedChanged(window) {
    if (suppress) {
        return;
    }
    var group = Model.groupForWindow(store, window);
    var member = group ? Model.memberFor(group, window) : null;
    if (!member) {
        return;
    }
    if (Model.activeMember(group) === member) {
        // The user minimized or restored the visible tab: the group follows it as
        // one unit, and keeps following while it is collapsed.
        group.collapsed = !!window.minimized;
        applyGroup(group);
        refresh();
        return;
    }
    if (window.minimized) {
        return;   // an inactive tab was minimized behind the group
    }
    // An inactive tab that becomes visible on its own is either the beginning of an
    // activation - KWin shows a window before it moves the focus - or a window that
    // was restored behind the group. Give KWin its moment, then put it back.
    schedule(60, function () {
        var current = Model.groupForWindow(store, window);
        var currentMember = current ? Model.memberFor(current, window) : null;
        if (shuttingDown || !currentMember || current.collapsed) {
            return;
        }
        if (Model.activeMember(current) === currentMember || ws.activeWindow === window) {
            return;   // it is the visible tab now
        }
        if (!memberState(current, currentMember, false).minimized) {
            return;   // cover mode keeps the tab mapped
        }
        applyGroup(current);
        refresh();
    });
}

export function onMaximizedChanged(window) {
    if (suppress) {
        return;
    }
    var group = Model.groupForWindow(store, window);
    if (!group) {
        return;
    }
    var active = Model.activeMember(group);
    if (!active || active.window !== window) {
        return;
    }
    var mode = window.maximizeMode;
    var vertical = mode === 1 || mode === 3;
    var horizontal = mode === 2 || mode === 3;
    suppress = true;
    for (var i = 0; i < group.members.length; ++i) {
        group.members[i].window.setMaximize(vertical, horizontal);
    }
    suppress = false;
    // KWin needs a moment to settle on the maximized geometry.
    schedule(120, function () {
        var current = Model.activeMember(group);
        if (!current) {
            return;
        }
        group.geometry = Util.geometryOf(current.window);
        applyGroup(group);
        refresh();
        });
}

// ------------------------------------------------------------------ mouse drags

export function onInteractiveStarted(window) {
    Drag.begin(drag, window, Util.geometryOf(window));
}

export function onInteractiveStepped(window, geometry) {
    if (drag.dragging !== window) {
        return;
    }
    var rect = Util.rect(Math.round(geometry.x), Math.round(geometry.y),
                         Math.round(geometry.width), Math.round(geometry.height));
    var target = Drag.update(drag, rect, Date.now(), dropCandidates(window), config);
    if (!target && !drag.candidate) {
        refresh();
    } else if (target) {
        refresh();
    }
}

export function onInteractiveFinished(window) {
    if (drag.dragging !== window) {
        return;
    }
    var target = drag.armed && drag.candidate ? drag.candidate.window : null;
    Drag.reset(drag);
    if (target) {
        if (config.promptOnDrop) {
            prompt = { target: target, dragged: window };
        } else {
            groupPair(target, window);
        }
    }
    refresh();
}

export function dropCandidates(dragged) {
    var candidates = [];
    var draggedGroup = Model.groupForWindow(store, dragged);
    for (var i = 0; i < registry.length; ++i) {
        var window = registry[i];
        if (window === dragged || window.minimized || window.deleted) {
            continue;
        }
        var group = Model.groupForWindow(store, window);
        if (group && group === draggedGroup) {
            continue;
        }
        if (!onCurrentDesktop(window)) {
            continue;
        }
        candidates.push({
            window: window,
            geometry: group ? group.geometry : Util.geometryOf(window)
        });
    }
    return candidates;
}

export function acceptPrompt() {
    if (!prompt) {
        return;
    }
    var pending = prompt;
    prompt = null;
    groupPair(pending.target, pending.dragged);
}

export function cancelPrompt() {
    prompt = null;
    refresh();
}

// ------------------------------------------------------------------ tab strip window

// The strip is an internal window: KWin owns it, puts it above every other window
// and delivers mouse events to it without stealing the keyboard focus.
function resolveOverlay() {
    var list = allWindows();
    for (var i = 0; i < list.length; ++i) {
        if (list[i].caption !== overlayCaption) {
            continue;
        }
        var window = list[i];
        overlayWindow = window;
        if (!window.noBorder) {
            window.noBorder = true;
        }
        if (!window.skipTaskbar) {
            window.skipTaskbar = true;
        }
        return true;
    }
    overlayWindow = null;
    return false;
}

// KWin places internal windows itself, so the position has to be applied through
// the window's geometry (the size is under the strip's own control).
function positionOverlay(rect) {
    if (!overlayWindow || overlayWindow.deleted) {
        if (!resolveOverlay()) {
            schedule(80, function () {
                positionOverlay(rect);
            });
            return;
        }
    }
    var current = Util.geometryOf(overlayWindow);
    if (current.x === Math.round(rect.x) && current.y === Math.round(rect.y)) {
        return;
    }
    suppress = true;
    overlayWindow.frameGeometry = Util.toQtRect(Util.rect(rect.x, rect.y, current.width, current.height));
    suppress = false;
}

export function overlayShown() {
    // The strip is unmapped while hidden, so its window object is recreated on
    // every show; make sure KWin treats the fresh one correctly.
    if (!resolveOverlay()) {
        schedule(80, resolveOverlay);
    }
}

// ------------------------------------------------------------------ view model

export function setView(view) {
    if (shuttingDown) {
        return;   // the strip may already be gone while the script is unloaded
    }
    if (ui && typeof ui.setView === "function") {
        ui.setView(view);
        return;
    }
    throw new Error("tabgroups: cannot push view, ui=" + String(ui));
}

export function refresh() {
    if (shuttingDown) {
        return;
    }
    if (!ui) {
        return;
    }
    var view = { visible: false, geometry: null, tabs: [], hint: "", prompt: null,
                 dragOut: config.dragOut };

    if (prompt) {
        var targetGroup = Model.groupForWindow(store, prompt.target);
        if (targetGroup) {
            var activeMember = Model.activeMember(targetGroup);
            view.geometry = Policy.barRect(targetGroup, activeMember ? activeMember.window : null, config);
            view.tabs = tabsFor(targetGroup);
        } else {
            view.geometry = Policy.barRect({ geometry: Util.geometryOf(prompt.target), members: [] },
                                           prompt.target, config);
        }
        view.prompt = {
            text: "Group with " + Util.elide(prompt.target.caption, 24) + "?",
            accept: "Group",
            cancel: "Cancel"
        };
        view.visible = true;
    } else if (drag.armed && drag.candidate) {
        var candidateGroup = Model.groupForWindow(store, drag.candidate.window);
        if (candidateGroup) {
            var member = Model.activeMember(candidateGroup);
            view.geometry = Policy.barRect(candidateGroup, member ? member.window : null, config);
            view.tabs = tabsFor(candidateGroup);
        } else {
            view.geometry = Policy.barRect({ geometry: drag.candidate.geometry, members: [] },
                                           drag.candidate.window, config);
        }
        view.hint = "Release to group with " + Util.elide(drag.candidate.window.caption, 24);
        view.visible = true;
    } else {
        var group = activeGroup();
        if (Policy.barVisible(group)) {
            var active = Model.activeMember(group);
            if (active && !active.window.fullScreen) {
                view.geometry = Policy.barRect(group, active.window, config);
                view.tabs = tabsFor(group);
                view.visible = true;
            }
        }
    }
    setView(view);
    if (view.visible && view.geometry) {
        positionOverlay(view.geometry);
    }
    schedulePersist();
}

export function tabsFor(group) {
    var active = Model.activeMember(group);
    var tabs = [];
    for (var i = 0; i < group.members.length; ++i) {
        var window = group.members[i].window;
        tabs.push({
            title: window.caption,
            active: !!active && window === active.window,
            attention: !!window.demandsAttention
        });
    }
    return tabs;
}

// ------------------------------------------------------------------ timers

export function schedule(delay, callback) {
    timers.push({ due: Date.now() + delay, callback: callback });
}

export function tick() {
    if (timers.length === 0) {
        return;
    }
    var now = Date.now();
    var due = [];
    var pending = [];
    for (var i = 0; i < timers.length; ++i) {
        if (timers[i].due <= now) {
            due.push(timers[i]);
        } else {
            pending.push(timers[i]);
        }
    }
    timers = pending;
    for (var j = 0; j < due.length; ++j) {
        try {
            due[j].callback();
        } catch (error) {
            console.warn("tabgroups: " + error);
        }
    }
}
