// verify-shadow: ONE command that says whether the shadow pipeline is on track.
//
//   npm run verify-shadow            (or: node scripts/verify-shadow.mjs)
//
// It prints a single verdict line, for example
//   ON TRACK: 7 of 24 consecutive clean cycles, last clean at 2026-10-08 15:40 UTC (Fri 02:40 local)
//   UNCLEAN:  cycle 20261008T150000Z: output differs from Actions at conditions.json; first failing field rows[1234]["Wind Forecast (km/h)"] ...
// and exits 0 (on track / passed), 1 (unclean, stalled or gap that matters), 2 (could not read the data) or 3 (NOT STARTED: nothing has
// been recorded/replayed yet, which is the normal state before the first Actions run after the recorder goes live: it is not a failure
// and never an "unclean cycle"). `--detail` adds a table.
//
// Where it looks:
//   * shadow/index.json in the PRIVATE shadow bucket, via your own `wrangler` login (one small object), written by the shadow Worker
//     (pipeline/src/shadow.py) after each replayed Actions run;
//   * GitHub's public Actions API for the update.yml runs, to tell "the shadow found a problem" apart from "Actions itself skipped or
//     failed this cycle" (those cycles neither count nor reset the streak) and from "Actions succeeded but nothing was verified";
//   * your local git clone (origin/main) for the files Actions committed, only to locate the FIRST DIFFERING FIELD of an unclean cycle and to
//     check the newest cycle's PUBLIC objects against an independent filter of the live data.
//
// A clean cycle = the recording was replayed; the Worker's full output is byte-identical to Actions' (conditions, locations export, every
// graph file) and it would have sent the same writes and made the same calls; the publish gate would have passed; the lock worked; Python
// heap under 90 MB; no private location name or owner id in any public object. 24 consecutive are needed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULTS = {
  bucket: "fishingconditions-shadow-private",
  repo: "olivermestdagh-sys/fishingconditions",
  workflow: "update.yml",
  needed: 24,
  pendingMinutes: 90, // a successful Actions run younger than this may simply not have been replayed yet
};

const fmtUtc = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "?");
const fmtLocal = (iso) => {
  try {
    return new Intl.DateTimeFormat("en-AU", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  } catch {
    return "";
  }
};
export const when = (iso) => `${fmtUtc(iso)} (${fmtLocal(iso)} local)`;

// ---------------------------------------------------------------- the first differing field

const MAX_PATH = 200;
const show = (v) => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v));
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Deep compare; returns null when equal, else {path, a, b} for the FIRST difference (keys in a's order, then b-only keys). Numbers
 *  compare exactly: parity means identical, not close. */
export function firstDifference(a, b, p = "") {
  if (a === b) return null;
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = firstDifference(a[i], b[i], `${p}[${i}]`);
      if (d) return d;
    }
    if (a.length !== b.length) return { path: `${p}.length`, a: a.length, b: b.length };
    return null;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) {
      if (!(k in b)) return { path: `${p}[${JSON.stringify(k)}]`, a: show(a[k]).slice(0, 60), b: "(missing)" };
      const d = firstDifference(a[k], b[k], `${p}[${JSON.stringify(k)}]`);
      if (d) return d;
    }
    for (const k of Object.keys(b)) if (!(k in a)) return { path: `${p}[${JSON.stringify(k)}]`, a: "(missing)", b: show(b[k]).slice(0, 60) };
    return null;
  }
  return { path: p || "(root)", a, b };
}

export function describeDifference(d, context) {
  if (!d) return "no field-level difference found (the files parse to the same data: a formatting-only difference)";
  const ctx = context ? ` [${context}]` : "";
  return `${String(d.path).slice(0, MAX_PATH)}: shadow ${typeof d.a === "string" ? d.a : show(d.a)} vs Actions ${typeof d.b === "string" ? d.b : show(d.b)}${ctx}`;
}

/** The public-only view of a full conditions.json, written WITHOUT sharing code with the Worker (an independent check). Pairs whose name
 *  is shared with a non-public location are withheld, exactly as the Worker documents. */
export function publicFilter(cond) {
  const owner = (l) => (typeof l.ownerId === "string" && l.ownerId ? l.ownerId : "unknown");
  const nonPublicNames = new Set(cond.locations.filter((l) => owner(l) !== "public").map((l) => l.name));
  const keep = cond.locations.filter((l) => owner(l) === "public" && !nonPublicNames.has(l.name));
  const pairs = new Set(keep.map((l) => `${l.name}\u0000${l.type}`));
  const names = new Set(keep.map((l) => l.name));
  return {
    ...cond,
    locations: keep,
    rows: cond.rows.filter((r) => pairs.has(`${r["Location Name"]}\u0000${r.Type}`)),
    sunTimes: Object.fromEntries(Object.entries(cond.sunTimes || {}).filter(([k]) => names.has(k))),
  };
}

// ---------------------------------------------------------------- classifying cycles and counting the streak

/**
 * @param cycles  shadow/index.json "cycles": [{id, runStart, processedAt, clean, reasons, firstDiff, workflowRunId}]
 * @param runs    GitHub Actions runs of update.yml (or null if unavailable): [{id, status, conclusion, created_at, run_started_at}]
 * @returns {{items, streak, lastClean, unverified, notCounted, state}}
 *   items: chronological [{kind, id, at, note}] with kind in clean | unclean | missing | actions-failed | pending
 */
export function classify({ cycles, runs, now, pendingMinutes = DEFAULTS.pendingMinutes }) {
  // Nothing replayed yet: there is no "since when" to judge Actions' runs against (they predate the recorder), so there is nothing to classify.
  if (!cycles.length) return { items: [], streak: 0, lastClean: null, newestVerdict: undefined, unverified: [], notCounted: [] };
  const byRun = new Map(cycles.filter((c) => c.workflowRunId).map((c) => [String(c.workflowRunId), c]));
  const start = cycles.length ? new Date(cycles[0].runStart || cycles[0].processedAt).getTime() - 30 * 60000 : null;
  const items = [];
  const used = new Set();
  for (const r of runs || []) {
    const t = new Date(r.run_started_at || r.created_at).getTime();
    if (start !== null && t < start) continue; // before the recorder existed
    const c = byRun.get(String(r.id));
    if (c) {
      used.add(c.id);
      items.push(c.clean ? { kind: "clean", id: c.id, at: c.runStart, note: "" } : { kind: "unclean", id: c.id, at: c.runStart, note: (c.reasons || []).join("; "), cycle: c });
    } else if (r.status !== "completed") {
      items.push({ kind: "pending", id: `run ${r.id}`, at: new Date(t).toISOString(), note: "Actions run still in progress" });
    } else if (r.conclusion !== "success") {
      items.push({ kind: "actions-failed", id: `run ${r.id}`, at: new Date(t).toISOString(), note: `Actions run ${r.conclusion || "did not succeed"}: no data run, so nothing to verify` });
    } else if (now - t < pendingMinutes * 60000) {
      items.push({ kind: "pending", id: `run ${r.id}`, at: new Date(t).toISOString(), note: "Actions run finished; its recording has not been replayed yet" });
    } else {
      items.push({ kind: "missing", id: `run ${r.id}`, at: new Date(t).toISOString(), note: "Actions succeeded but no recording was replayed (upload failed, secrets missing, or the shadow Worker did not run)" });
    }
  }
  // cycles the runs list did not account for (older than its window, or recorded without a run id)
  for (const c of cycles) {
    if (used.has(c.id)) continue;
    if ((runs || []).some((r) => String(r.id) === String(c.workflowRunId))) continue;
    items.push(c.clean ? { kind: "clean", id: c.id, at: c.runStart, note: "" } : { kind: "unclean", id: c.id, at: c.runStart, note: (c.reasons || []).join("; "), cycle: c });
  }
  items.sort((a, b) => new Date(a.at) - new Date(b.at));
  // streak: newest first; clean counts, "not a verdict" items are skipped, unclean ends it
  let streak = 0;
  let lastClean = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "clean") {
      streak++;
      if (!lastClean) lastClean = it;
    } else if (it.kind === "unclean") break;
  }
  const newestVerdict = [...items].reverse().find((i) => i.kind === "clean" || i.kind === "unclean");
  return {
    items, streak, lastClean, newestVerdict,
    unverified: items.filter((i) => i.kind === "missing"),
    notCounted: items.filter((i) => i.kind === "actions-failed" || i.kind === "pending"),
  };
}

/** The one-line verdict + exit code from a classification (and optional extra problems found by the deep check). */
export function verdictLine(cls, { needed = DEFAULTS.needed, now, extra = null, runsUnavailable = false } = {}) {
  if (!cls.items.length) return { code: 3, line: "NOT STARTED: no Actions recording has been replayed yet (expected until the first Actions run after the recorder is live and its upload secret is set, and the shadow Worker's cron has registered and fired)" };
  const tail = [];
  if (cls.unverified.length) tail.push(`${cls.unverified.length} cycle(s) unverified (${cls.unverified.map((i) => fmtUtc(i.at).slice(5, 16)).join(", ")}: Actions succeeded but nothing was replayed)`);
  const skipped = cls.notCounted.filter((i) => i.kind === "actions-failed");
  if (skipped.length) tail.push(`${skipped.length} not counted (${skipped.map((i) => `${fmtUtc(i.at).slice(5, 16)}: ${i.note.split(":")[0].toLowerCase()}`).join("; ")})`);
  const pending = cls.notCounted.filter((i) => i.kind === "pending");
  if (pending.length) tail.push(`${pending.length} pending`);
  if (runsUnavailable) tail.push("could not read the Actions run list, so skipped/failed runs are not distinguished");
  const suffix = tail.length ? `; ${tail.join("; ")}` : "";

  if (extra) return { code: 1, line: `UNCLEAN: ${extra}${suffix}` };
  const nv = cls.newestVerdict;
  if (nv && nv.kind === "unclean") {
    return { code: 1, line: `UNCLEAN: cycle ${nv.id} (${fmtUtc(nv.at)}): ${nv.note || "unclean"}; streak reset to 0${suffix}` };
  }
  if (cls.unverified.length && nv && cls.unverified.some((u) => new Date(u.at) > new Date(nv.at))) {
    return { code: 1, line: `STALLED: ${cls.unverified.length} Actions run(s) since the last verified cycle (${nv ? fmtUtc(nv.at) : "none"}) were never replayed${suffix}` };
  }
  if (!cls.lastClean) return { code: 1, line: `NOT STARTED: no clean cycle yet${suffix}` };
  const head = cls.streak >= needed ? `PASSED: ${cls.streak} of ${needed} consecutive clean cycles` : `ON TRACK: ${cls.streak} of ${needed} consecutive clean cycles`;
  return { code: 0, line: `${head}, last clean at ${when(cls.lastClean.at)}${suffix}` };
}

// ---------------------------------------------------------------- IO (replaceable in tests)

const git = (args, opts = {}) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });

export function realIO(opts) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return {
    async readObject(key) {
      if (opts.localDir) {
        const p = path.join(opts.localDir, key);
        return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
      }
      try {
        return execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", "r2", "object", "get", `${opts.bucket}/${key}`, "--remote", "--pipe"], {
          encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], cwd: root, shell: process.platform === "win32",
        });
      } catch (e) {
        if (/does not exist|not found|NoSuchKey|10007/i.test(String(e.stderr || e.message))) return null;
        throw new Error(`could not read ${key} from the shadow bucket with wrangler (are you logged in? ${String(e.stderr || e.message).split("\n")[0]})`);
      }
    },
    async listRuns() {
      const url = `https://api.github.com/repos/${opts.repo}/actions/workflows/${opts.workflow}/runs?per_page=100`;
      const res = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "verify-shadow" } });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      return (await res.json()).workflow_runs;
    },
    fetchGit() {
      try {
        git(["fetch", "-q", "origin", "main"], { cwd: root });
      } catch {
        /* offline: use what is already there */
      }
    },
    /** The committed Actions file whose generatedAt equals the cycle's pinned run start. */
    findActionsCommit(generatedAt) {
      const log = git(["log", "origin/main", "-n", "60", "--format=%H", "--", "data/conditions.json"], { cwd: root }).split("\n").filter(Boolean);
      for (const sha of log) {
        const head = git(["show", `${sha}:data/conditions.json`], { cwd: root }).slice(0, 200);
        if (head.includes(JSON.stringify(generatedAt))) return sha;
      }
      return null;
    },
    gitShow(sha, file) {
      return git(["show", `${sha}:${file}`], { cwd: root });
    },
  };
}

// ---------------------------------------------------------------- the field-level reason for an unclean cycle, and the deep check

async function explainUnclean(io, cycle) {
  const sha = io.findActionsCommit ? io.findActionsCommit(cycle.runStart) : null; // the pinned run start IS the committed generatedAt, verbatim
  const file = cycle.firstDiff && cycle.firstDiff.file;
  if (!file || !sha) return file ? `(Actions' committed copy of ${file} not found locally: run 'git fetch origin main' and retry to see the field)` : null;
  const map = file === "conditions.json" ? ["conditions.json", "data/conditions.json"] : file === "locations export" ? ["export.json", "config/locations.json"] : file.startsWith("graph/") ? [file, `data/${file}`] : null;
  if (!map) return null;
  const shadowText = await io.readObject(`shadow/diffs/${cycle.id}/${map[0]}`);
  if (!shadowText) return `(the shadow's full output of ${file} was not kept)`;
  const d = firstDifference(JSON.parse(shadowText), JSON.parse(io.gitShow(sha, map[1])));
  let context = null;
  const m = /^\["rows"\]\[(\d+)\]/.exec(d ? d.path : "");
  if (m) {
    const row = JSON.parse(shadowText).rows[Number(m[1])];
    context = row ? `${row["Location Name"]} / ${row.Type} / ${row.dateTime}` : null;
  }
  return `first failing field ${describeDifference(d, context)}`;
}

async function deepCheck(io, cycle) {
  const pub = await io.readObject(`shadow/runs/${cycle.id}/conditions.json`);
  if (!pub) return `cycle ${cycle.id}: its public conditions.json is missing from the shadow bucket`;
  const sha = io.findActionsCommit(cycle.runStart);
  if (!sha) return null; // cannot locate Actions' committed copy: skip rather than fail
  const live = JSON.parse(io.gitShow(sha, "data/conditions.json"));
  const d = firstDifference(JSON.parse(pub), publicFilter(live));
  return d ? `cycle ${cycle.id}: the shadow's PUBLIC conditions.json differs from an independent filter of the live data at ${describeDifference(d)}` : null;
}

export async function runVerify(io, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = o.now ?? Date.now();
  const indexText = await io.readObject("shadow/index.json");
  // No index object = the shadow Worker has not replayed anything yet. That is "not started", never an unclean cycle.
  if (!indexText) return { code: 3, line: "NOT STARTED: shadow/index.json does not exist yet, so no recording has been replayed (expected until the first Actions run after the recorder is live, its upload secret is set, and the shadow Worker's cron has fired)", cls: null };
  const cycles = JSON.parse(indexText).cycles || [];
  let runs = null;
  let runsUnavailable = false;
  if (!o.noGithub) {
    try {
      runs = (await io.listRuns()).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    } catch {
      runsUnavailable = true;
    }
  }
  const cls = classify({ cycles, runs, now, pendingMinutes: o.pendingMinutes });
  let extra = null;
  const nv = cls.newestVerdict;
  if (nv && nv.kind === "unclean") {
    try {
      const why = await explainUnclean(io, nv.cycle);
      if (why) nv.note = `${nv.note}; ${why}`;
    } catch (e) {
      nv.note = `${nv.note}; (could not locate the field: ${e.message})`;
    }
  } else if (cls.lastClean && !o.noDeep) {
    try {
      const c = cycles.find((x) => x.id === cls.lastClean.id);
      extra = c ? await deepCheck(io, c) : null;
    } catch (e) {
      extra = null; // the deep check is an extra; a git/IO hiccup must not fake an unclean verdict
    }
  }
  const v = verdictLine(cls, { needed: o.needed, now, extra, runsUnavailable });
  return { ...v, cls };
}

export function detailTable(cls) {
  return cls.items
    .map((i) => `${fmtUtc(i.at).padEnd(18)} ${i.kind.padEnd(14)} ${String(i.id).padEnd(20)} ${i.note || ""}`)
    .join("\n");
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--detail") o.detail = true;
    else if (a === "--no-deep") o.noDeep = true;
    else if (a === "--no-github") o.noGithub = true;
    else if (a === "--no-fetch") o.noFetch = true;
    else if (a === "--needed") o.needed = Number(argv[++i]);
    else if (a === "--bucket") o.bucket = argv[++i];
    else if (a === "--local-dir") o.localDir = argv[++i];
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log("usage: npm run verify-shadow [-- --detail] [--needed 24] [--no-deep] [--no-github] [--no-fetch] [--bucket NAME] [--local-dir DIR]");
    process.exit(0);
  }
  try {
    const io = realIO({ ...DEFAULTS, ...o });
    if (!o.noFetch && !o.localDir) io.fetchGit();
    const res = await runVerify(io, o);
    console.log(res.line);
    if (o.detail && res.cls) console.log("\n" + detailTable(res.cls));
    process.exit(res.code);
  } catch (e) {
    console.log(`CANNOT VERIFY: ${e.message}`);
    process.exit(2);
  }
}
