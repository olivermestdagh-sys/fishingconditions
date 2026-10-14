// compare-parallel: is the production pipeline Worker's newest published run the same DATA as what GitHub Actions committed around the
// same time? (Phase C of the "remove GitHub" plan: a short parallel run instead of 24 shadow cycles.)
//
//   node scripts/compare-parallel.mjs [--host https://data.fish2catch.app] [--repo-path .]
//
// Byte equality is impossible here (the two jobs run minutes apart, so forecasts and realtime readings move), so it checks what must
// hold: the same public locations/types, only Public's data, similar row counts, tide rows that agree (tide predictions don't drift),
// forecast values within a tolerance on the rows both have, the same sun/moon entries and the same graph files. Exit 0 = MATCH,
// 1 = DIFFERS, 2 = could not read something.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const LIMITS = {
  rowsRatio: 0.9, // worker rows per pair must be within 10% of git's, either way
  tideHeightM: 0.06, // tide height of the same hour
  windKmh: 8, // forecast wind of the same hour
  tempC: 3,
  conditionAgree: 0.9, // share of overlapping rows with the same Fishing Condition
};

const key = (o) => `${o.name || o["Location Name"]}|${o.type || o.Type}`;

export function compareRuns(worker, git, graph = null, limits = LIMITS) {
  const problems = [];
  const stats = {};
  const wl = new Map((worker.locations || []).map((l) => [key(l), l]));
  const gl = new Map((git.locations || []).filter((l) => l.ownerId === "public").map((l) => [key(l), l]));
  const strangers = (worker.locations || []).filter((l) => l.ownerId !== "public").length;
  if (strangers) problems.push(`${strangers} non-public location(s) in the worker output`);
  const onlyW = [...wl.keys()].filter((k) => !gl.has(k)).length;
  const onlyG = [...gl.keys()].filter((k) => !wl.has(k)).length;
  stats.locations = { worker: wl.size, git: gl.size };
  if (onlyW || onlyG) problems.push(`location/type pairs differ: ${onlyW} only in worker, ${onlyG} only in git`);

  const group = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const k = `${r["Location Name"]}|${r.Type}`;
      if (!m.has(k)) m.set(k, new Map());
      m.get(k).set(r.dateTime, r);
    }
    return m;
  };
  const wr = group(worker.rows || []);
  const gr = group(git.rows || []);
  let overlap = 0, tideBad = 0, windBad = 0, tempBad = 0, condSame = 0, condN = 0, rowBad = 0;
  for (const [k, gm] of gr) {
    const wm = wr.get(k);
    if (!wm) continue;
    const ratio = Math.min(wm.size, gm.size) / Math.max(wm.size, gm.size);
    if (ratio < limits.rowsRatio) rowBad++;
    for (const [t, g] of gm) {
      const w = wm.get(t);
      if (!w) continue;
      overlap++;
      const dh = Math.abs(Number(w["Tide Height (m)"]) - Number(g["Tide Height (m)"]));
      if (Number.isFinite(dh) && dh > limits.tideHeightM) tideBad++;
      const dw = Math.abs(Number(w["Wind Forecast (km/h)"]) - Number(g["Wind Forecast (km/h)"]));
      if (Number.isFinite(dw) && dw > limits.windKmh) windBad++;
      const dt = Math.abs(Number(w["Temp Realtime (C)"]) - Number(g["Temp Realtime (C)"]));
      if (Number.isFinite(dt) && dt > limits.tempC) tempBad++;
      if (g["Fishing Condition"] !== undefined) {
        condN++;
        if (w["Fishing Condition"] === g["Fishing Condition"]) condSame++;
      }
    }
  }
  stats.rows = { worker: (worker.rows || []).length, git: (git.rows || []).length, overlapping: overlap };
  if (rowBad) problems.push(`${rowBad} pair(s) with row counts more than ${Math.round((1 - limits.rowsRatio) * 100)}% apart`);
  if (!overlap) problems.push("no overlapping hours to compare");
  // A few rows differing is normal (forecast moved); a systematic difference is not: allow 1% of the overlap.
  const allow = Math.ceil(overlap * 0.01);
  if (tideBad > allow) problems.push(`tide height differs by over ${limits.tideHeightM} m on ${tideBad} of ${overlap} overlapping rows`);
  if (windBad > allow * 5) problems.push(`forecast wind differs by over ${limits.windKmh} km/h on ${windBad} rows`);
  if (tempBad > allow * 5) problems.push(`temperature differs by over ${limits.tempC} C on ${tempBad} rows`);
  if (condN && condSame / condN < limits.conditionAgree) problems.push(`Fishing Condition agrees on only ${Math.round((100 * condSame) / condN)}% of overlapping rows`);
  stats.conditionAgree = condN ? Math.round((1000 * condSame) / condN) / 10 : null;
  const sw = Object.keys(worker.sunTimes || {}).sort().join();
  const sg = Object.keys(git.sunTimes || {}).sort().join();
  if (sw !== sg) problems.push("sunTimes locations differ");
  if (graph) {
    const a = (graph.worker || []).map((f) => f.file).sort().join();
    const b = (graph.git || []).map((f) => f.file).sort().join();
    stats.graphFiles = { worker: (graph.worker || []).length, git: (graph.git || []).length };
    if (a !== b) problems.push("graph file lists differ");
  }
  return { ok: problems.length === 0, problems, stats };
}

const gitCmd = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 29 });

async function main() {
  const arg = (n, d) => {
    const i = process.argv.indexOf(n);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const host = arg("--host", "https://data.fish2catch.app");
  const cwd = arg("--repo-path", ".");
  const get = async (p) => {
    const r = await fetch(`${host}/${p}?_=${Date.now()}`);
    if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
    return r.json();
  };
  let latest, worker, wIndex;
  try {
    latest = await get("latest.json");
    worker = await get(latest.conditions);
    wIndex = await get(latest.graphIndex);
  } catch (e) {
    console.log(`COULD NOT READ the worker's published run: ${e.message}`);
    process.exit(2);
  }
  gitCmd(["fetch", "-q", "origin"], cwd);
  const commits = gitCmd(["log", "origin/main", "--format=%H", "-n", "40", "--", "data/conditions.json"], cwd).trim().split("\n");
  let best = null;
  for (const sha of commits) {
    const g = JSON.parse(gitCmd(["show", `${sha}:data/conditions.json`], cwd));
    const d = Math.abs(Date.parse(g.generatedAt) - Date.parse(latest.generatedAt));
    if (!best || d < best.d) best = { d, sha, g };
    if (Date.parse(g.generatedAt) < Date.parse(latest.generatedAt) - 6 * 3600e3) break;
  }
  const gIndex = JSON.parse(gitCmd(["show", `${best.sha}:data/graph/index.json`], cwd));
  const pub = (list) => list.filter((l) => l.ownerId === "public");
  const res = compareRuns(worker, best.g, { worker: pub(wIndex.locations), git: pub(gIndex.locations) });
  const gap = Math.round(best.d / 60000);
  console.log(`${res.ok ? "MATCH" : "DIFFERS"}: worker run ${latest.runId} vs Actions commit ${best.sha.slice(0, 8)} (${best.g.generatedAt}, ${gap} min apart) ${JSON.stringify(res.stats)}`);
  for (const p of res.problems) console.log("  - " + p);
  process.exit(res.ok ? 0 : 1);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
