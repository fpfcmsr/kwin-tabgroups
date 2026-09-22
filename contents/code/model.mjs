// Bookkeeping for tab groups. Deliberately free of KWin calls so the grouping
// rules can be exercised on their own.
//
// A group is { id, geometry, members, activeIndex }.
// A member is { window, restore, flags } where `restore` is the frame geometry the
// window had before it joined and `flags` remembers the task bar / switcher state.

export // Windows are compared by their identity id, not by object identity: the QML
// engine may hand out different wrappers for the same window.
function keyOf(window) {
    return String(window.internalId);
}

export function createStore() {
    return { groups: [], nextId: 1 };
}

export function memberIndex(group, window) {
    var key = keyOf(window);
    for (var i = 0; i < group.members.length; ++i) {
        if (keyOf(group.members[i].window) === key) {
            return i;
        }
    }
    return -1;
}

export function memberFor(group, window) {
    var index = memberIndex(group, window);
    return index < 0 ? null : group.members[index];
}

export function groupForWindow(store, window) {
    for (var i = 0; i < store.groups.length; ++i) {
        if (memberIndex(store.groups[i], window) >= 0) {
            return store.groups[i];
        }
    }
    return null;
}

export function activeMember(group) {
    if (!group || group.members.length === 0) {
        return null;
    }
    var index = Math.min(Math.max(group.activeIndex, 0), group.members.length - 1);
    return group.members[index];
}

export function activeIndex(group) {
    var member = activeMember(group);
    return member ? memberIndex(group, member.window) : -1;
}

export function createGroup(store, member, geometry) {
    var group = {
        id: store.nextId++,
        geometry: geometry,
        members: [member],
        activeIndex: 0
    };
    store.groups.push(group);
    return group;
}

export function addMember(group, member, geometry) {
    if (memberIndex(group, member.window) >= 0) {
        return;
    }
    group.members.push(member);
    group.geometry = geometry;
}

// Removes the window from the group and returns the removed member, or null.
// Only the membership changes: a group that drops below two members is left for
// the caller to dissolve, because the remaining member's window still has to be
// turned back into a regular window before the group can go away.
export function removeMember(group, window) {
    var index = memberIndex(group, window);
    if (index < 0) {
        return null;
    }
    var member = group.members[index];
    group.members.splice(index, 1);
    if (index < group.activeIndex) {
        group.activeIndex -= 1;
    }
    group.activeIndex = Math.min(Math.max(group.activeIndex, 0), Math.max(group.members.length - 1, 0));
    return member;
}

export function dissolve(store, group) {
    var index = store.groups.indexOf(group);
    if (index >= 0) {
        store.groups.splice(index, 1);
    }
    group.members = [];
    group.activeIndex = 0;
}

export function setActive(group, window) {
    var index = memberIndex(group, window);
    if (index >= 0) {
        group.activeIndex = index;
    }
}

// Moves the member at `from` to position `to` (both indices within the group).
export function reorder(group, from, to) {
    if (from < 0 || from >= group.members.length) {
        return false;
    }
    var target = Math.min(Math.max(to, 0), group.members.length - 1);
    if (from === target) {
        return false;
    }
    var active = activeMember(group);
    var member = group.members.splice(from, 1)[0];
    group.members.splice(target, 0, member);
    setActive(group, active.window);
    return true;
}

export function contains(store, window) {
    return groupForWindow(store, window) !== null;
}
