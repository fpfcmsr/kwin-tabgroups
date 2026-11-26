// Drop target detection while a window is being moved with the mouse.
// Time is injected (`now`) so the arming rule can be tested without a compositor.

import * as Util from "./util.mjs";

export function makeState() {
    return {
        dragging: null,
        geometry: null,
        candidate: null,      // { window, geometry }
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

// Returns the best overlapping candidate, or null.
export function bestCandidate(geometry, candidates) {
    var best = null;
    var bestRatio = 0;
    for (var i = 0; i < candidates.length; ++i) {
        var ratio = Util.overlapRatio(geometry, candidates[i].geometry);
        if (ratio > bestRatio) {
            bestRatio = ratio;
            best = candidates[i];
        }
    }
    return { candidate: best, ratio: bestRatio };
}

// Feeds a new geometry for the dragged window. Returns the armed target, or null
// while the window is still being moved around.
export function update(state, geometry, now, candidates, config) {
    state.geometry = geometry;

    var best = bestCandidate(geometry, candidates);
    if (!best.candidate || best.ratio < config.overlap) {
        state.candidate = null;
        state.candidateSince = 0;
        state.armed = false;
        return null;
    }
    if (!state.candidate || state.candidate.window !== best.candidate.window) {
        state.candidate = best.candidate;
        state.candidateSince = now;
        state.armed = false;
        return null;
    }
    if (!state.armed && (now - state.candidateSince) >= config.dwell) {
        state.armed = true;
    }
    return state.armed ? state.candidate : null;
}
