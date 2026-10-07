// scripts/verify-shadow.mjs: the one-line verdict, the streak rules, and finding the first differing field.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, verdictLine, firstDifference, describeDifference, publicFilter, runVerify, detailTable } from "../scripts/verify-shadow.mjs";

const H = 3600 * 1000;
const T0 = Date.parse("2026-10-08T03:00:00Z");
const at = (n) => new Date(T0 + n * 3 * H).toISOString();           // cycle n starts n*3 h after T0
const id = (n) => at(n).replace(/[-:]/g, "").replace(".000", "");   // 20261008T030000Z
let runNo = 1000;
const run = (n, extra = {}) => ({ id: 1000 + n, status: "completed", conclusion: "success", created_at: at(n), run_started_at: at(n), ...extra });
const HASH = "a".repeat(64); // the script hash the fake shadow Worker was deployed with; a recording made with it counts
const cycle = (n, extra = {}) => ({ id: id(n), runStart: at(n), processedAt: at(n), clean: true, reasons: [], workflowRunId: String(1000 + n), scriptHash: HASH, deployedScriptHash: HASH, ...extra });
const NOW = T0 + 40 * H;

test("a run of clean cycles is ON TRACK, and says when the last one was", () => {
  const cycles = [0, 1, 2, 3, 4].map((n) => cycle(n));
  const cls = classify({ cycles, runs: cycles.map((c, n) => run(n)), now: NOW });
  const v = verdictLine(cls, { needed: 24, now: NOW });
  assert.equal(v.code, 0);
  assert.match(v.line, /^ON TRACK: 5 of 24 consecutive clean cycles, last clean at 2026-10-08 15:00 UTC/);
});

test("24 clean cycles is PASSED", () => {
  const cycles = Array.from({ length: 24 }, (_, n) => cycle(n));
  const cls = classify({ cycles, runs: cycles.map((c, n) => run(n)), now: T0 + 100 * H });
  assert.match(verdictLine(cls, { needed: 24 }).line, /^PASSED: 24 of 24 consecutive clean cycles/);
});

test("an unclean cycle resets the streak and the line names the cycle, the reason and the first failing file", () => {
  const cycles = [cycle(0), cycle(1), cycle(2, { clean: false, reasons: ["output differs from Actions at conditions.json"], firstDiff: { file: "conditions.json" } }), cycle(3), cycle(4, { clean: false, reasons: ["output differs from Actions at graph/abc.json"], firstDiff: { file: "graph/abc.json" } })];
  const cls = classify({ cycles, runs: cycles.map((c, n) => run(n)), now: NOW });
  const v = verdictLine(cls, { needed: 24 });
  assert.equal(v.code, 1);
  assert.match(v.line, /^UNCLEAN: cycle 20261008T150000Z .*output differs from Actions at graph\/abc\.json; streak reset to 0/);
  assert.equal(cls.streak, 0);
});

test("the streak after an unclean cycle counts from the next clean one", () => {
  const cycles = [cycle(0), cycle(1, { clean: false, reasons: ["x"] }), cycle(2), cycle(3)];
  const cls = classify({ cycles, runs: cycles.map((c, n) => run(n)), now: NOW });
  assert.equal(cls.streak, 2);
  assert.match(verdictLine(cls, {}).line, /^ON TRACK: 2 of 24 consecutive/);
});

test("an Actions run that failed or was cancelled neither counts nor resets, and the line says why", () => {
  const cycles = [cycle(0), cycle(1), cycle(3), cycle(4)];
  const runs = [run(0), run(1), run(2, { conclusion: "failure" }), run(3), run(4)];
  const cls = classify({ cycles, runs, now: NOW });
  assert.equal(cls.streak, 4);
  const v = verdictLine(cls, {});
  assert.equal(v.code, 0);
  assert.match(v.line, /1 not counted \(10-08 09:00: actions run failure\)/);
});

test("a successful Actions run that was never replayed is an unverified gap (reported; STALLED if it is the newest)", () => {
  const cycles = [cycle(0), cycle(1), cycle(3)];
  const runs = [run(0), run(1), run(2), run(3)];
  const gap = verdictLine(classify({ cycles, runs, now: NOW }), {});
  assert.equal(gap.code, 0);
  assert.match(gap.line, /1 cycle\(s\) unverified \(10-08 09:00: Actions succeeded but nothing was replayed\)/);
  const stalled = verdictLine(classify({ cycles: [cycle(0), cycle(1)], runs: [run(0), run(1), run(2), run(3)], now: NOW }), {});
  assert.equal(stalled.code, 1);
  assert.match(stalled.line, /^STALLED: 2 Actions run\(s\) since the last verified cycle/);
});

test("a very recent successful run is just pending, not a gap", () => {
  const cycles = [cycle(0), cycle(1)];
  const runs = [run(0), run(1), run(2)];
  const now = T0 + 2 * 3 * H + 30 * 60000; // 30 minutes after run 2 started
  const v = verdictLine(classify({ cycles, runs, now }), {});
  assert.equal(v.code, 0);
  assert.match(v.line, /1 pending/);
});

test("runs from before the recorder existed are ignored", () => {
  const cycles = [cycle(5), cycle(6)];
  const runs = [run(0), run(1), run(5), run(6)];
  const cls = classify({ cycles, runs, now: NOW });
  assert.equal(cls.items.length, 2);
  assert.equal(cls.streak, 2);
});

test("with nothing processed it says NOT STARTED (its own exit code, not a failure), with a hint", () => {
  const v = verdictLine(classify({ cycles: [], runs: [], now: NOW }), {});
  assert.equal(v.code, 3);
  assert.match(v.line, /^NOT STARTED: no Actions recording has been replayed yet/);
});

test("an unavailable Actions run list is said so, and cycles still count", () => {
  const cycles = [cycle(0), cycle(1)];
  const v = verdictLine(classify({ cycles, runs: null, now: NOW }), { runsUnavailable: true });
  assert.equal(v.code, 0);
  assert.match(v.line, /could not read the Actions run list/);
});

test("firstDifference finds the first differing field, with a readable path", () => {
  const a = { generatedAt: "t", rows: [{ n: "x", v: 1 }, { n: "y", v: 12.5, w: 3 }] };
  const b = { generatedAt: "t", rows: [{ n: "x", v: 1 }, { n: "y", v: 12, w: 3 }] };
  assert.deepEqual(firstDifference(a, b), { path: '["rows"][1]["v"]', a: 12.5, b: 12 });
  assert.equal(firstDifference(a, structuredClone(a)), null);
  assert.deepEqual(firstDifference({ a: 1 }, { a: 1, b: 2 }), { path: '["b"]', a: "(missing)", b: "2" });
  assert.deepEqual(firstDifference([1, 2, 3], [1, 2]), { path: ".length", a: 3, b: 2 });
  assert.match(describeDifference(firstDifference(a, b), "Alpha / Kayak / 2026-10-07T06:00:00"), /rows"\]\[1\]\["v"\]: shadow 12\.5 vs Actions 12 \[Alpha \/ Kayak/);
  assert.equal(firstDifference({ x: 1 }, { x: 1 }), null);
});

test("publicFilter keeps only Public, withholds names shared with a non-public location, and fails closed on a missing owner", () => {
  const cond = {
    generatedAt: "t",
    locations: [{ name: "Pub", type: "Kayak", ownerId: "public" }, { name: "Clash", type: "Kayak", ownerId: "public" }, { name: "Clash", type: "Kayak", ownerId: "u1" }, { name: "Ghost", type: "Kayak" }],
    rows: [{ "Location Name": "Pub", Type: "Kayak" }, { "Location Name": "Clash", Type: "Kayak" }, { "Location Name": "Ghost", Type: "Kayak" }],
    sunTimes: { Pub: [1], Clash: [2], Ghost: [3] },
  };
  const f = publicFilter(cond);
  assert.deepEqual(f.locations.map((l) => l.name), ["Pub"]);
  assert.deepEqual(f.rows.map((r) => r["Location Name"]), ["Pub"]);
  assert.deepEqual(Object.keys(f.sunTimes), ["Pub"]);
});

// --- end to end through runVerify with fake IO

function fakeIO({ cycles, runs, objects = {}, commit = "abc", files = {} }) {
  return {
    async readObject(key) {
      if (key === "shadow/index.json") return JSON.stringify({ cycles });
      return objects[key] ?? null;
    },
    async listRuns() { if (runs === "down") throw new Error("offline"); return runs; },
    findActionsCommit() { return commit; },
    gitShow(sha, file) { return files[file]; },
  };
}

test("runVerify locates the first failing field of an unclean cycle from the kept full output and the committed file", async () => {
  const bad = cycle(1, { clean: false, reasons: ["output differs from Actions at conditions.json"], firstDiff: { file: "conditions.json" } });
  const shadowCond = { rows: [{ "Location Name": "A", Type: "Kayak", dateTime: "2026-10-08T06:00:00", w: 12.5 }] };
  const liveCond = { rows: [{ "Location Name": "A", Type: "Kayak", dateTime: "2026-10-08T06:00:00", w: 12 }] };
  const io = fakeIO({ cycles: [cycle(0), bad], runs: [run(0), run(1)], objects: { [`shadow/diffs/${bad.id}/conditions.json`]: JSON.stringify(shadowCond) }, files: { "data/conditions.json": JSON.stringify(liveCond) } });
  const res = await runVerify(io, { now: NOW });
  assert.equal(res.code, 1);
  assert.match(res.line, /output differs from Actions at conditions\.json; first failing field \["rows"\]\[0\]\["w"\]: shadow 12\.5 vs Actions 12 \[A \/ Kayak \/ 2026-10-08T06:00:00\]/);
});

test("runVerify deep-checks the newest clean cycle's PUBLIC output against an independent filter of the live data", async () => {
  const live = { generatedAt: "g", locations: [{ name: "Pub", type: "Kayak", ownerId: "public" }, { name: "Priv", type: "Kayak", ownerId: "u1" }], rows: [{ "Location Name": "Pub", Type: "Kayak" }, { "Location Name": "Priv", Type: "Kayak" }], sunTimes: { Pub: [1], Priv: [2] } };
  const good = publicFilter(live);
  const cycles = [cycle(0)];
  const ok = await runVerify(fakeIO({ cycles, runs: [run(0)], objects: { [`shadow/runs/${cycles[0].id}/conditions.json`]: JSON.stringify(good) }, files: { "data/conditions.json": JSON.stringify(live) } }), { now: NOW });
  assert.equal(ok.code, 0);
  const leaked = { ...good, rows: [...good.rows, { "Location Name": "Priv", Type: "Kayak" }] };
  const bad = await runVerify(fakeIO({ cycles, runs: [run(0)], objects: { [`shadow/runs/${cycles[0].id}/conditions.json`]: JSON.stringify(leaked) }, files: { "data/conditions.json": JSON.stringify(live) } }), { now: NOW });
  assert.equal(bad.code, 1);
  assert.match(bad.line, /^UNCLEAN: cycle .*PUBLIC conditions\.json differs from an independent filter of the live data/);
});

test("runVerify with no index yet is NOT STARTED, never UNCLEAN; with GitHub down it still gives a verdict", async () => {
  const none = await runVerify({ readObject: async () => null, listRuns: async () => [] }, { now: NOW });
  assert.equal(none.code, 3);
  assert.match(none.line, /^NOT STARTED: shadow\/index\.json does not exist yet/);
  assert.doesNotMatch(none.line, /UNCLEAN|CANNOT/);
  const emptyIndex = await runVerify({ readObject: async () => JSON.stringify({ cycles: [] }), listRuns: async () => [run(0)] }, { now: NOW });
  assert.equal(emptyIndex.code, 3);
  assert.match(emptyIndex.line, /^NOT STARTED/);
  const down = await runVerify(fakeIO({ cycles: [cycle(0)], runs: "down" }), { now: NOW, noDeep: true });
  assert.equal(down.code, 0);
  assert.match(down.line, /could not read the Actions run list/);
});

test("--detail table lists every cycle with its kind and reason", async () => {
  const cycles = [cycle(0), cycle(1, { clean: false, reasons: ["heap too high"] })];
  const res = await runVerify(fakeIO({ cycles, runs: [run(0), run(1), run(2, { conclusion: "cancelled" })] }), { now: NOW, noDeep: true });
  const table = detailTable(res.cls);
  assert.match(table, /clean/);
  assert.match(table, /unclean .* heap too high/);
  assert.match(table, /actions-failed .* cancelled/);
});

test("only an unclean (replayed and wrong) cycle resets the streak: skipped, cancelled, failed, timed-out or absent Actions runs do not", () => {
  for (const conclusion of ["skipped", "cancelled", "failure", "timed_out", "neutral"]) {
    const cycles = [cycle(0), cycle(1), cycle(3), cycle(4)];
    const runs = [run(0), run(1), run(2, { conclusion }), run(3), run(4)];
    const cls = classify({ cycles, runs, now: NOW });
    assert.equal(cls.streak, 4, `a ${conclusion} Actions run must not reset the streak`);
    assert.match(verdictLine(cls, {}).line, /^ON TRACK: 4 of 24 consecutive clean cycles/, conclusion);
  }
  // Actions simply did not run for a long stretch (the common GitHub behaviour): no item at all, so nothing to reset or count
  const gap = [cycle(0), cycle(1), cycle(6), cycle(7)];
  assert.equal(classify({ cycles: gap, runs: gap.map((c, n) => run([0, 1, 6, 7][n])), now: NOW }).streak, 4);
  // a mismatch between the shadow and Actions is what resets it
  const cycles = [cycle(0), cycle(1), cycle(2, { clean: false, reasons: ["output differs from Actions at conditions.json"], firstDiff: { file: "conditions.json" } }), cycle(3)];
  const cls = classify({ cycles, runs: cycles.map((c, n) => run(n)), now: NOW });
  assert.equal(cls.streak, 1);
});

// ---------------------------------------------------------------- script hash: only recordings made with the deployed script count

test("a recording with no script hash, or another one, is SUPERSEDED: listed, never unclean, and it neither counts nor resets the streak", () => {
  const cycles = [
    cycle(0), cycle(1),
    cycle(2, { scriptHash: undefined, clean: false, reasons: ["output differs from Actions at conditions.json"] }),   // a hash-less recording that differs
    cycle(3, { scriptHash: "b".repeat(64), clean: false, reasons: ["output differs from Actions at conditions.json"] }), // made with another script
    cycle(4),
  ];
  const cls = classify({ cycles, runs: cycles.map((c, n) => run(n)), now: NOW, deployedScriptHash: HASH });
  assert.equal(cls.streak, 3, "the two superseded cycles are skipped, not counted and not a reset");
  assert.deepEqual(cls.superseded.map((i) => i.id), [id(2), id(3)]);
  assert.ok(!cls.items.some((i) => i.kind === "unclean"));
  const v = verdictLine(cls, {});
  assert.equal(v.code, 0);
  assert.match(v.line, /^ON TRACK: 3 of 24 consecutive clean cycles/);
  assert.match(v.line, /2 recording\(s\) superseded/);
});

test("with only superseded recordings the verdict is NOT STARTED (exit 3), not a failure", () => {
  const cycles = [cycle(0, { scriptHash: undefined, clean: false, reasons: ["x"] }), cycle(1, { scriptHash: undefined })];
  const cls = classify({ cycles, runs: cycles.map((c, n) => run(n)), now: NOW, deployedScriptHash: HASH });
  const v = verdictLine(cls, {});
  assert.equal(v.code, 3);
  assert.match(v.line, /^NOT STARTED: no recording made with the deployed script has been replayed yet; 2 recording\(s\) superseded/);
});

test("the first matching recording after superseded ones starts the streak at 1", () => {
  const cycles = [cycle(0, { scriptHash: undefined, clean: false, reasons: ["x"] }), cycle(1, { scriptHash: undefined }), cycle(2)];
  const cls = classify({ cycles, runs: cycles.map((c, n) => run(n)), now: NOW, deployedScriptHash: HASH });
  assert.equal(cls.streak, 1);
  assert.match(verdictLine(cls, {}).line, /^ON TRACK: 1 of 24 consecutive clean cycles/);
});

test("a cycle replayed under an older deployment than the heartbeat's current script is superseded too", () => {
  const cycles = [cycle(0, { scriptHash: "c".repeat(64), deployedScriptHash: "c".repeat(64) }), cycle(1)];
  const cls = classify({ cycles, runs: cycles.map((c, n) => run(n)), now: NOW, deployedScriptHash: HASH });
  assert.equal(cls.streak, 1);
  assert.deepEqual(cls.superseded.map((i) => i.id), [id(0)]);
});

test("a superseded cycle still accounts for its Actions run (it is not reported as a missing replay)", () => {
  const cycles = [cycle(0, { scriptHash: undefined }), cycle(1)];
  const cls = classify({ cycles, runs: cycles.map((c, n) => run(n)), now: NOW, deployedScriptHash: HASH });
  assert.equal(cls.unverified.length, 0);
});

test("runVerify reads the Worker's current script hash from the heartbeat", async () => {
  const cycles = [cycle(0, { scriptHash: undefined, clean: false, reasons: ["x"] }), cycle(1), cycle(2)];
  const objects = { "shadow/index.json": JSON.stringify({ cycles }), "shadow/heartbeat.json": JSON.stringify({ scriptHash: HASH }) };
  const io = { readObject: async (k) => objects[k] ?? null, listRuns: async () => cycles.map((c, n) => run(n)) };
  const res = await runVerify(io, { now: NOW, noDeep: true });
  assert.equal(res.code, 0);
  assert.match(res.line, /^ON TRACK: 2 of 24/);
  assert.match(res.line, /1 recording\(s\) superseded/);
  objects["shadow/heartbeat.json"] = JSON.stringify({ scriptHash: "d".repeat(64) });   // the Worker has since been redeployed with another script
  const res2 = await runVerify(io, { now: NOW, noDeep: true });
  assert.equal(res2.code, 3);
});
