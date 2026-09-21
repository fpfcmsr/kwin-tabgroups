// Serialisation of group state and the matching rules used to restore it.
//
// Two records are kept:
//   session snapshot - groups keyed by window identity, used when the script is
//                      reloaded while the same windows are still open.
//   restore snapshot - groups described by application, title and geometry, used
//                      after a restart when the windows are new objects.
//
// Both are plain data, so the matching rules can be tested without a compositor.

import * as Util from "./util.mjs";

export var VERSION = 1;

export function appIdOf(window) {
    return window.resourceClass || window.desktopFileName || "";
}

// Groups as they are now, keyed by window identity. Used by the session restore.
export function sessionSnapshot(store) {
    var groups = [];
    for (var i = 0; i < store.groups.length; ++i) {
        var group = store.groups[i];
        var members = [];
        for (var j = 0; j < group.members.length; ++j) {
            var member = group.members[j];
            members.push({
                id: String(member.window.internalId),
                restore: Util.copy(member.restore),
                skipTaskbar: !!member.flags.skipTaskbar,
                skipSwitcher: !!member.flags.skipSwitcher
            });
        }
        groups.push({
            geometry: Util.copy(group.geometry),
            activeIndex: group.activeIndex,
            members: members
        });
    }
    return { version: VERSION, groups: groups };
}

// Groups as they are now, described by what survives a restart. Used by the
// best effort restore.
export function restoreSnapshot(store, now) {
    var groups = [];
    for (var i = 0; i < store.groups.length; ++i) {
        var group = store.groups[i];
        var members = [];
        for (var j = 0; j < group.members.length; ++j) {
            var window = group.members[j].window;
            members.push({
                appId: appIdOf(window),
                caption: window.caption,
                geometry: Util.geometryOf(window)
            });
        }
        groups.push({
            savedAt: now,
            geometry: Util.copy(group.geometry),
            activeIndex: group.activeIndex,
            members: members
        });
    }
    return { version: VERSION, groups: groups };
}

// A stable description of a group used to tell "the user ungrouped this" from
// "these windows went away".
export function signatureOf(appIds, captions) {
    var parts = [];
    for (var i = 0; i < appIds.length; ++i) {
        parts.push(appIds[i] + "\u0001" + captions[i]);
    }
    return parts.sort().join("\u0002");
}

export function groupSignature(group) {
    var appIds = [];
    var captions = [];
    for (var i = 0; i < group.members.length; ++i) {
        appIds.push(appIdOf(group.members[i].window));
        captions.push(group.members[i].window.caption);
    }
    return signatureOf(appIds, captions);
}

export function entrySignature(entry) {
    var appIds = [];
    var captions = [];
    for (var i = 0; i < entry.members.length; ++i) {
        appIds.push(entry.members[i].appId);
        captions.push(entry.members[i].caption);
    }
    return signatureOf(appIds, captions);
}

// Plan for a reload in the same session: match members by window identity.
// Entries with fewer than two surviving members cannot form a group.
export function sessionPlan(saved, windowById) {
    var plan = [];
    if (!saved || saved.version !== VERSION || !saved.groups) {
        return plan;
    }
    for (var i = 0; i < saved.groups.length; ++i) {
        var entry = saved.groups[i];
        var members = [];
        for (var j = 0; j < entry.members.length; ++j) {
            var slot = entry.members[j];
            var window = windowById(slot.id);
            if (!window) {
                continue;
            }
            members.push({
                window: window,
                restore: slot.restore,
                flags: { skipTaskbar: !!slot.skipTaskbar, skipSwitcher: !!slot.skipSwitcher }
            });
        }
        if (members.length >= 2) {
            plan.push({
                geometry: entry.geometry,
                activeIndex: entry.activeIndex || 0,
                members: members,
                missing: entry.members.length - members.length
            });
        }
    }
    return plan;
}

function withinTolerance(a, b, tolerance) {
    return Util.withinTolerance(a, b, tolerance);
}

// A window matches a saved member when it is the same application and either
// carries the same title or sits where the saved window sat. Both a wrong title
// and a moved window are normal, so either signal is accepted, never neither.
export function matchMember(slot, windows, taken, tolerance) {
    if (!slot.appId) {
        return null;
    }
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < windows.length; ++i) {
        var window = windows[i];
        if (taken.indexOf(window) >= 0 || appIdOf(window) !== slot.appId) {
            continue;
        }
        var score = 0;
        if (slot.caption && window.caption === slot.caption) {
            score += 2;
        }
        if (slot.geometry && withinTolerance(Util.geometryOf(window), slot.geometry, tolerance)) {
            score += 1;
        }
        if (score > bestScore) {
            bestScore = score;
            best = window;
        }
    }
    return bestScore > 0 ? best : null;
}

// Match the saved entries against the windows that exist now. Entries are
// matched in the order given (newest first) and a window is only used once.
// Partial matches are reported too: a restarted session brings its windows back
// one at a time, so a group has to be able to grow as they appear.
export function coldMatches(entries, windows, config, now, taken) {
    var results = [];
    if (!entries) {
        return results;
    }
    var ttl = config.restoreWindowMinutes * 60000;
    for (var i = 0; i < entries.length; ++i) {
        var entry = entries[i];
        if (!entry.savedAt || (now - entry.savedAt) > ttl) {
            continue;
        }
        var members = [];
        var claimed = [];
        for (var j = 0; j < entry.members.length; ++j) {
            var window = matchMember(entry.members[j], windows, taken.concat(claimed), config.matchTolerancePx);
            if (window) {
                claimed.push(window);
                members.push({ window: window, slot: entry.members[j] });
            }
        }
        for (var k = 0; k < claimed.length; ++k) {
            taken.push(claimed[k]);
        }
        results.push({
            entry: entry,
            members: members,
            complete: members.length === entry.members.length
        });
    }
    return results;
}

export function pruneExpired(saved, config, now) {
    if (!saved || !saved.groups) {
        return saved;
    }
    var ttl = config.restoreWindowMinutes * 60000;
    saved.groups = saved.groups.filter(function (entry) {
        return entry.savedAt && (now - entry.savedAt) <= ttl;
    });
    return saved;
}

// Drop the entry that describes `group`, used when the user dissolves a group on
// purpose so that it is not restored later.
export function forgetGroup(saved, group) {
    if (!saved || !saved.groups) {
        return saved;
    }
    var signature = groupSignature(group);
    saved.groups = saved.groups.filter(function (entry) {
        return entrySignature(entry) !== signature;
    });
    return saved;
}
