// Drop target detection while a window is being moved with the mouse.
// Time is injected (`now`) so the arming rule can be tested without a compositor.
//
// A window is a drop target while the pointer is on its title bar (or on the tab
// strip that covers it), the same gesture as dropping onto a browser's tab strip.
// Merely moving a window across another one never arms it.

import * as Util from "./util.mjs";

export function makeState() {
    return {
        dragging: null,
        geometry: null,
        candidate: null,      // { window, geometry, titleHeight, stacking }
        candidateSince: 0,
        armed: false
    };
}

export function begin(state, window, geometry) {
    state.dragging = window;
    state.geometry = geometry;
    state.candidate = null;
    state.candidateSince = 0;
    state.armed = false;
}

export function reset(state) {
    state.dragging = null;
    state.geometry = null;
    state.candidate = null;
    state.candidateSince = 0;
    state.armed = false;
}

// The candidate whose title bar is under `point`, or null. Only the topmost
// window under the pointer counts: a title bar hidden behind another window is
// not something the user can see, let alone aim at.
export function targetAt(point, candidates) {
    var top = null;
    for (var i = 0; i < candidates.length; ++i) {
        var candidate = candidates[i];
        if (Util.containsPoint(candidate.geometry, point) && (!top || candidate.stacking > top.stacking)) {
            top = candidate;
        }
    }
    if (!top || point.y >= top.geometry.y + top.titleHeight) {
        return null;
    }
    return top;
}

// Feeds a new pointer position. Returns the armed target, or null while the
// window is still being moved around.
export function update(state, point, now, candidates, config) {
    var target = targetAt(point, candidates);
    if (!target) {
        state.candidate = null;
        state.candidateSince = 0;
        state.armed = false;
        return null;
    }
    if (!state.candidate || state.candidate.window !== target.window) {
        state.candidate = target;
        state.candidateSince = now;
        state.armed = false;
        return null;
    }
    if (!state.armed && (now - state.candidateSince) >= config.dwell) {
        state.armed = true;
    }
    return state.armed ? state.candidate : null;
}
