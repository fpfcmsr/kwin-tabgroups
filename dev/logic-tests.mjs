// Logic checks for the group model, the presentation policy and the drop detection.
// These modules avoid KWin calls on purpose, so they can be exercised outside a
// session:  node dev/logic-tests.mjs   (or: bun dev/logic-tests.mjs)

// `Qt` is a QML global in the real runtime; only Qt.rect() is used.
globalThis.Qt = { rect: (x, y, width, height) => ({ x, y, width, height }) };

const base = new URL("../contents/code/", import.meta.url);
const Util = await import(new URL("util.mjs", base));
const Model = await import(new URL("model.mjs", base));
const Policy = await import(new URL("policy.mjs", base));
const Drag = await import(new URL("drag.mjs", base));
const Controller = await import(new URL("controller.mjs", base));
const State = await import(new URL("state.mjs", base));

const results = [];
const check = (name, actual, expected) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    results.push({ ok: a === e, line: `${a === e ? "ok  " : "FAIL"} ${name}${a === e ? "" : ` got ${a} want ${e}`}` });
};
const rect = (x, y, width, height) => ({ x, y, width, height });
const windowLike = (fx, fy, fw, fh, cx, cy, cw, ch) => ({
    frameGeometry: rect(fx, fy, fw, fh),
    clientGeometry: rect(cx, cy, cw, ch)
});

// --- the interface the QML entry point relies on
const missing = ["init", "shutdown", "reloadConfig", "groupActiveWithNext", "ungroupActive", "nextTab",
                 "switchTo", "detachTab", "reorderTab", "moveGroupBy", "acceptPrompt", "cancelPrompt",
                 "overlayShown", "tick", "setView"].filter((name) => typeof Controller[name] !== "function");
check("controller exposes the QML interface", missing, []);

// --- geometry helpers
check("overlap of identical rects", Util.overlapRatio(rect(0, 0, 100, 100), rect(0, 0, 100, 100)), 1);
check("overlap of half covered rect", Util.overlapRatio(rect(0, 0, 100, 100), rect(50, 0, 100, 100)), 0.5);
check("overlap of disjoint rects", Util.overlapRatio(rect(0, 0, 100, 100), rect(200, 0, 100, 100)), 0);
check("overlap is relative to the dragged window",
    Util.overlapRatio(rect(0, 0, 100, 100), rect(-50, -50, 400, 400)), 1);
check("title bar height", Util.titlebarHeight(windowLike(100, 100, 800, 600, 100, 132, 800, 568)), 32);
check("no title bar for client side decorations",
    Util.titlebarHeight(windowLike(100, 100, 800, 600, 100, 100, 800, 600)), 0);
check("geometry comparison tolerance", Util.same(rect(0, 0, 100, 100), rect(1, 1, 101, 99)), true);
check("geometry comparison detects real differences", Util.same(rect(0, 0, 100, 100), rect(4, 0, 100, 100)), false);

// --- group bookkeeping
const store = Model.createStore();
const a = { name: "a", internalId: "id-a" };
const b = { name: "b", internalId: "id-b" };
const c = { name: "c", internalId: "id-c" };
const member = (window) => ({ window, restore: rect(0, 0, 10, 10), flags: { skipTaskbar: false, skipSwitcher: false } });
const group = Model.createGroup(store, member(a), rect(0, 0, 800, 600));
Model.addMember(group, member(b), rect(0, 0, 800, 600));
Model.addMember(group, member(c), rect(0, 0, 800, 600));
check("members are tracked", group.members.length, 3);
check("a window finds its group", Model.groupForWindow(store, b) === group, true);

Model.setActive(group, b);
check("the active tab follows setActive", Model.activeMember(group).window, b);
check("removing a member returns it", Model.removeMember(group, a).window, a);
check("the active tab survives a removal before it", Model.activeMember(group).window, b);
Model.setActive(group, c);
Model.reorder(group, 1, 0);
check("reordering keeps the active tab", Model.activeMember(group).window, c);
check("reordering changes the order", group.members.map((m) => m.window.name), ["c", "b"]);
Model.removeMember(group, b);
check("a group with one window keeps its last member", group.members.map((m) => m.window.name), ["c"]);
check("the group stays in the store for the caller", store.groups.length, 1);
Model.dissolve(store, group);
check("dissolving drops the group", store.groups.length, 0);
check("dissolved group has no members", group.members.length, 0);

// --- presentation policy
const plain = { window: {}, restore: null, flags: { skipTaskbar: false, skipSwitcher: false } };
const alreadyHidden = { window: {}, restore: null, flags: { skipTaskbar: true, skipSwitcher: false } };
check("the visible tab keeps its own task bar state",
    Policy.desiredState(alreadyHidden, true, Policy.HIDE_MINIMIZE),
    { minimized: false, skipTaskbar: true, skipSwitcher: false });
check("hidden tabs are minimized and unlisted",
    Policy.desiredState(plain, false, Policy.HIDE_MINIMIZE),
    { minimized: true, skipTaskbar: true, skipSwitcher: true });
check("cover mode leaves the window mapped but unlisted",
    Policy.desiredState(plain, false, Policy.HIDE_COVER),
    { minimized: false, skipTaskbar: true, skipSwitcher: true });

const config = { barHeight: 30, rightInset: 150 };
const barGroup = { geometry: rect(200, 300, 1000, 700), members: [plain], activeIndex: 0 };
check("the strip sits on the title bar",
    Policy.barRect(barGroup, windowLike(200, 300, 1000, 700, 200, 332, 1000, 668), config),
    { x: 200, y: 300, width: 850, height: 32 });
check("the strip falls back to the configured height",
    Policy.barRect(barGroup, windowLike(200, 300, 1000, 700, 200, 300, 1000, 700), config),
    { x: 200, y: 300, width: 850, height: 30 });
check("no strip for a single window", Policy.barVisible({ members: [plain] }), false);

// --- drop detection
const dragConfig = { overlap: 0.6, dwell: 250 };
const state = Drag.makeState();
const candidates = [{ window: a, geometry: rect(10, 10, 100, 100) }];
Drag.begin(state, c, rect(0, 0, 100, 100));
check("no target while the windows barely overlap",
    Drag.update(state, rect(0, 0, 100, 100), 1000, [{ window: b, geometry: rect(400, 400, 50, 50) }], dragConfig),
    null);
check("the target is tracked before it is armed",
    [Drag.update(state, rect(0, 0, 100, 100), 1100, candidates, dragConfig), state.candidate.window === a],
    [null, true]);
check("the target arms after the hold time",
    Drag.update(state, rect(0, 0, 100, 100), 1400, candidates, dragConfig).window, a);
check("leaving the target disarms it",
    Drag.update(state, rect(2000, 2000, 100, 100), 1500, candidates, dragConfig), null);
check("state after leaving", [state.armed, state.candidate], [false, null]);
Drag.begin(state, c, rect(0, 0, 100, 100));
Drag.update(state, rect(0, 0, 100, 100), 2000, candidates, dragConfig);
check("the hold time restarts for a new target",
    Drag.update(state, rect(0, 0, 100, 100), 2100, candidates, dragConfig), null);
check("and arms once the hold time passed",
    Drag.update(state, rect(0, 0, 100, 100), 2300, candidates, dragConfig).window, a);


// --- stored state: reload in the same session (matched by window identity)
const idWindow = (id) => ({ internalId: id, caption: "shell", resourceClass: "org.kde.konsole",
                            frameGeometry: rect(100, 100, 900, 700) });
const one = idWindow("id-1");
const two = idWindow("id-2");
const three = idWindow("id-3");
const storedStore = Model.createStore();
const storedGroup = Model.createGroup(storedStore,
    { window: one, restore: rect(10, 10, 500, 400), flags: { skipTaskbar: false, skipSwitcher: true } },
    rect(100, 100, 900, 700));
Model.addMember(storedGroup,
    { window: two, restore: rect(20, 20, 500, 400), flags: { skipTaskbar: true, skipSwitcher: false } },
    rect(100, 100, 900, 700));
Model.addMember(storedGroup,
    { window: three, restore: rect(30, 30, 500, 400), flags: { skipTaskbar: false, skipSwitcher: false } },
    rect(100, 100, 900, 700));
storedGroup.activeIndex = 2;

const session = State.sessionSnapshot(storedStore);
const lookup = (map) => (id) => map[id] || null;
const full = State.sessionPlan(session, lookup({ "id-1": one, "id-2": two, "id-3": three }));
check("reload plan keeps the group", full.length, 1);
check("reload plan keeps every member", full[0].members.length, 3);
check("reload plan keeps the active tab", full[0].activeIndex, 2);
check("reload plan keeps geometry", full[0].geometry, rect(100, 100, 900, 700));
check("reload plan keeps the saved flags", full[0].members[1].flags, { skipTaskbar: true, skipSwitcher: false });
check("reload plan keeps the geometry to return to", full[0].members[0].restore, rect(10, 10, 500, 400));
check("a member that is gone is dropped",
    State.sessionPlan(session, lookup({ "id-1": one, "id-3": three }))[0].members.length, 2);
check("a group that lost all but one member is not rebuilt",
    State.sessionPlan(session, lookup({ "id-1": one })).length, 0);
check("garbage state is ignored", State.sessionPlan({ version: 99, groups: [{}] }, lookup({})).length, 0);

// --- stored state: restart (matched by application, title and position)
const saved = State.restoreSnapshot(storedStore, 1000000);
check("restore record records the application", saved.groups[0].members[0].appId, "org.kde.konsole");
check("restore record records the title", saved.groups[0].members[0].caption, "shell");

const restoredWindow = (appId, caption, geometry) => ({
    internalId: appId + caption, caption, resourceClass: appId, frameGeometry: geometry
});
const coldConfig = { restoreWindowMinutes: 1440, matchTolerancePx: 40 };
const slotAt = (x, y, caption) => ({ appId: "org.kde.konsole", caption, geometry: rect(x, y, 900, 700) });

check("same application and title matches",
    State.matchMember(slotAt(0, 0, "shell"), [restoredWindow("org.kde.konsole", "shell", rect(900, 900, 100, 100))], [], 40) !== null, true);
check("same application and position matches",
    State.matchMember(slotAt(0, 0, "other title"), [restoredWindow("org.kde.konsole", "renamed", rect(5, 5, 900, 700))], [], 40) !== null, true);
check("moved window with a different title does not match",
    State.matchMember(slotAt(0, 0, "shell"), [restoredWindow("org.kde.konsole", "renamed", rect(900, 900, 900, 700))], [], 40), null);
check("another application does not match",
    State.matchMember(slotAt(0, 0, "shell"), [restoredWindow("org.kde.dolphin", "shell", rect(0, 0, 900, 700))], [], 40), null);
check("a member without an application is never matched",
    State.matchMember({ appId: "", caption: "shell", geometry: rect(0, 0, 900, 700) },
        [restoredWindow("org.kde.konsole", "shell", rect(0, 0, 900, 700))], [], 40), null);
const claimedWindow = restoredWindow("org.kde.konsole", "shell", rect(0, 0, 900, 700));
check("an already claimed window is not used twice",
    State.matchMember(slotAt(0, 0, "shell"), [claimedWindow], [claimedWindow], 40), null);

const coldWindows = [
    restoredWindow("org.kde.konsole", "shell", rect(100, 100, 900, 700)),
    restoredWindow("org.kde.dolphin", "files", rect(200, 200, 600, 500)),
    restoredWindow("org.kde.kate", "notes", rect(300, 300, 700, 600))
];
const partial = State.coldMatches(saved.groups, [restoredWindow("org.kde.konsole", "shell", rect(100, 100, 900, 700))],
    coldConfig, 1000001, []);
check("a partially restored entry is reported as incomplete",
    [partial.length, partial[0].members.length, partial[0].complete], [1, 1, false]);
check("an expired entry is not matched",
    State.coldMatches(saved.groups, coldWindows, coldConfig, 1000000 + 1441 * 60000, []).length, 0);

const fullEntry = {
    savedAt: 1000000, geometry: rect(100, 100, 900, 700), activeIndex: 1,
    members: [slotAt(100, 100, "shell"),
              { appId: "org.kde.dolphin", caption: "files", geometry: rect(200, 200, 600, 500) }]
};
const cold = State.coldMatches([fullEntry], coldWindows, coldConfig, 1000001, []);
check("a complete entry matches every window", [cold.length, cold[0].members.length, cold[0].complete], [1, 2, true]);
check("the rebuilt group keeps its members in order",
    cold[0].members.map((member) => member.window.caption), ["shell", "files"]);
check("the rebuilt group keeps the active tab", cold[0].entry.activeIndex, 1);

const competing = {
    version: State.VERSION,
    groups: [
        { savedAt: 1000000, geometry: rect(0, 0, 10, 10), activeIndex: 0,
          members: [slotAt(100, 100, "shell"), slotAt(100, 100, "shell")] },
        { savedAt: 1000000, geometry: rect(0, 0, 10, 10), activeIndex: 0,
          members: [slotAt(100, 100, "shell"),
                    { appId: "org.kde.dolphin", caption: "files", geometry: rect(200, 200, 600, 500) }] }
    ]
};
const competingResults = State.coldMatches(competing.groups, coldWindows, coldConfig, 1000001, []);
check("entries are matched in order and a window is claimed only once",
    competingResults.map((result) => result.members.map((member) => member.window.caption)), [["shell"], ["files"]]);

// --- entries the user dissolved by hand must not come back
const forgetStore = Model.createStore();
const forgetGroup = Model.createGroup(forgetStore,
    { window: restoredWindow("org.kde.konsole", "shell", rect(0, 0, 10, 10)), restore: null,
      flags: { skipTaskbar: false, skipSwitcher: false } },
    rect(0, 0, 900, 700));
Model.addMember(forgetGroup,
    { window: restoredWindow("org.kde.dolphin", "files", rect(0, 0, 10, 10)), restore: null,
      flags: { skipTaskbar: false, skipSwitcher: false } },
    rect(0, 0, 900, 700));
const record = State.restoreSnapshot(forgetStore, 1000000);
check("the record describes the group", record.groups.length, 1);
check("ungrouping forgets the group", State.forgetGroup(record, forgetGroup).groups.length, 0);

const pruned = State.pruneExpired({ version: State.VERSION, groups: [
    { savedAt: 1000000, members: [] }, { savedAt: 87400000, members: [] }] }, coldConfig, 87460000);
check("expired entries are pruned", pruned.groups.length, 1);
check("the surviving entry is the recent one", pruned.groups[0].savedAt, 87400000);

const failures = results.filter((result) => !result.ok);
for (const result of results) {
    console.log(result.line);
}
console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
process.exit(failures.length === 0 ? 0 : 1);
