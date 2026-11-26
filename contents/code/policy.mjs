// Presentation rules: what a grouped window should look like.
// Pure decisions only, the controller applies them to real windows.

import * as Util from "./util.mjs";

export var HIDE_COVER = 0;
export var HIDE_MINIMIZE = 1;

// Only the active tab is a regular window: the others are hidden from the window
// switcher and either minimized or merely covered by the active tab. Windows keep
// their own task bar state in every case: the task manager lists each tab, so that
// an application is never reported as not running while one of its windows is a
// hidden tab, and a tab can be brought forward by clicking its task bar entry.
export function desiredState(member, isActive, hideMode, collapsed) {
    if (isActive) {
        return {
            minimized: !!collapsed,
            skipTaskbar: member.flags.skipTaskbar,
            skipSwitcher: member.flags.skipSwitcher
        };
    }
    return {
        minimized: !!collapsed || hideMode === HIDE_MINIMIZE,
        skipTaskbar: member.flags.skipTaskbar,
        skipSwitcher: true
    };
}

// The tab strip sits on the title bar of the group, leaving room on the right for
// the window buttons of the active tab.
export function barRect(group, activeWindow, config) {
    var geometry = group.geometry;
    var height = titleHeight(activeWindow, config);
    var width = Math.max(160, Math.round(geometry.width - config.rightInset));
    return Util.rect(Math.round(geometry.x), Math.round(geometry.y), width, Math.round(height));
}

// Height of the band at the top of a window that the strip covers: the title bar,
// or the configured height for a window that draws its own (client side) title bar.
export function titleHeight(window, config) {
    var height = window ? Util.titlebarHeight(window) : 0;
    return height > 8 ? height : config.barHeight;
}

// The strip belongs to a group that is on screen: a collapsed group has every tab
// minimized, so there is nothing to switch between.
export function barVisible(group) {
    return !!group && group.members.length > 1 && !group.collapsed;
}
