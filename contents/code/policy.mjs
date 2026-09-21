// Presentation rules: what a grouped window should look like.
// Pure decisions only, the controller applies them to real windows.

import * as Util from "./util.mjs";

export var HIDE_COVER = 0;
export var HIDE_MINIMIZE = 1;

// Only the active tab is a regular window: the others are hidden from the task bar
// and the window switcher so that a group behaves like a single window.
export function desiredState(member, isActive, hideMode) {
    if (isActive) {
        return {
            minimized: false,
            skipTaskbar: member.flags.skipTaskbar,
            skipSwitcher: member.flags.skipSwitcher
        };
    }
    return {
        minimized: hideMode === HIDE_MINIMIZE,
        skipTaskbar: true,
        skipSwitcher: true
    };
}

// The tab strip sits on the title bar of the group, leaving room on the right for
// the window buttons of the active tab.
export function barRect(group, activeWindow, config) {
    var geometry = group.geometry;
    var titleHeight = activeWindow ? Util.titlebarHeight(activeWindow) : 0;
    var height = titleHeight > 8 ? titleHeight : config.barHeight;
    var width = Math.max(160, Math.round(geometry.width - config.rightInset));
    return Util.rect(Math.round(geometry.x), Math.round(geometry.y), width, Math.round(height));
}

export function barVisible(group) {
    return !!group && group.members.length > 1;
}
