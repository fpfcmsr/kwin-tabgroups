// Geometry and text helpers shared by the model, the policy and the controller.
// Rects are plain objects { x, y, width, height } in logical coordinates.

var EPSILON = 2;

export function rect(x, y, width, height) {
    return { x: x, y: y, width: width, height: height };
}

export function copy(r) {
    return rect(r.x, r.y, r.width, r.height);
}

export function geometryOf(window) {
    var g = window.frameGeometry;
    return rect(Math.round(g.x), Math.round(g.y), Math.round(g.width), Math.round(g.height));
}

// Height of the server side title bar, i.e. the area above the client area.
export function titlebarHeight(window) {
    var frame = window.frameGeometry;
    var client = window.clientGeometry;
    return Math.max(0, Math.round(client.y - frame.y));
}

export function area(r) {
    return Math.max(0, r.width) * Math.max(0, r.height);
}

export function intersectionArea(a, b) {
    var x1 = Math.max(a.x, b.x);
    var y1 = Math.max(a.y, b.y);
    var x2 = Math.min(a.x + a.width, b.x + b.width);
    var y2 = Math.min(a.y + a.height, b.y + b.height);
    if (x2 <= x1 || y2 <= y1) {
        return 0;
    }
    return (x2 - x1) * (y2 - y1);
}

// How much of `r` is covered by `other`, in the range 0..1.
export function overlapRatio(r, other) {
    var own = area(r);
    return own === 0 ? 0 : intersectionArea(r, other) / own;
}

export function same(a, b) {
    return !!a && !!b
        && Math.abs(a.x - b.x) <= EPSILON
        && Math.abs(a.y - b.y) <= EPSILON
        && Math.abs(a.width - b.width) <= EPSILON
        && Math.abs(a.height - b.height) <= EPSILON;
}

// Same geometry, allowing a larger tolerance on every edge.
export function withinTolerance(a, b, tolerance) {
    return !!a && !!b
        && Math.abs(a.x - b.x) <= tolerance
        && Math.abs(a.y - b.y) <= tolerance
        && Math.abs(a.width - b.width) <= tolerance
        && Math.abs(a.height - b.height) <= tolerance;
}

export function translated(r, dx, dy) {
    return rect(r.x + dx, r.y + dy, r.width, r.height);
}

export function toQtRect(r) {
    return Qt.rect(Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height));
}

export function elide(text, max) {
    if (!text) {
        return "";
    }
    return text.length <= max ? text : text.slice(0, max - 1) + "…";
}
