// loadSiteData (js/backend.js): the site reads the published bucket only when asked (USE_PUBLISHED_DATA / ?data=bucket),
// falls back to the committed git copy on any bucket problem, and refuses pointer paths that leave the host.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../js/backend.js", import.meta.url), "utf8");
const a = src.indexOf("// --- Published data");
const b = src.indexOf("// --- Sign-in that survives");
assert.ok(a > 0 && b > a, "published-data block found");
const block = src.slice(a, b);

function world({ search = "", routes = {}, flag } = {}) {
  const calls = [];
  const fetchFn = async (url) => {
    const u = String(url).replace(/\?_=\d+$/, "");
    calls.push(u);
    const hit = routes[u];
    if (hit === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (hit instanceof Error) throw hit;
    return { ok: true, status: 200, json: async () => hit };
  };
  const body = { children: [], insertBefore(el) { this.children.push(el); }, firstChild: null };
  const doc = { body, createElement: () => ({ style: {}, setAttribute() {} }), getElementById: () => null };
  const ctx = { fetch: fetchFn, window: { location: { search } }, document: doc, URLSearchParams, Date, console: { error() {} }, Number, Math };
  const code = (flag === undefined ? block : block.replace("USE_PUBLISHED_DATA = false", `USE_PUBLISHED_DATA = ${flag}`)) +
    "\n({ loadSiteData, dataAgeHours, showStaleDataBanner, publishedDataWanted });";
  return { api: vm.runInNewContext(code, ctx), calls, body };
}

const H = "https://data.fish2catch.app";
const ptr = { runId: "r1", generatedAt: "2026-10-15T00:00:00Z", conditions: "runs/r1/conditions.json", locations: "runs/r1/locations.json" };

test("default is the git copy; the bucket is never contacted", async () => {
  const w = world({ routes: { "data/conditions.json": { generatedAt: "G", rows: [] } } });
  const r = await w.api.loadSiteData("conditions", "data/conditions.json");
  assert.equal(r.source, "git");
  assert.equal(r.generatedAt, "G");
  assert.deepEqual(w.calls, ["data/conditions.json"]);
});

test("?data=bucket reads latest.json then the immutable run file", async () => {
  const w = world({ search: "?data=bucket", routes: { [`${H}/latest.json`]: ptr, [`${H}/runs/r1/conditions.json`]: { rows: [1] } } });
  const r = await w.api.loadSiteData("conditions", "data/conditions.json");
  assert.equal(r.source, "bucket");
  assert.deepEqual(r.json, { rows: [1] });
  assert.equal(r.generatedAt, ptr.generatedAt);
});

test("the flag turns it on, and ?data=git turns it back off", async () => {
  assert.equal(world({ flag: true }).api.publishedDataWanted(), true);
  assert.equal(world({ flag: true, search: "?data=git" }).api.publishedDataWanted(), false);
});

test("an empty or failing bucket falls back to git", async () => {
  for (const routes of [{}, { [`${H}/latest.json`]: new Error("offline") }, { [`${H}/latest.json`]: ptr }]) {
    const w = world({ search: "?data=bucket", routes: { ...routes, "config/locations.json": [{ name: "A" }] } });
    const r = await w.api.loadSiteData("locations", "config/locations.json");
    assert.equal(r.source, "git");
    assert.deepEqual(r.json, [{ name: "A" }]);
  }
});

test("a pointer path that leaves the host is ignored", async () => {
  for (const bad of ["/etc/x", "../x", "runs/../../x"]) {
    const w = world({ search: "?data=bucket", routes: { [`${H}/latest.json`]: { ...ptr, conditions: bad }, "data/conditions.json": { rows: [] } } });
    assert.equal((await w.api.loadSiteData("conditions", "data/conditions.json")).source, "git", bad);
  }
});

test("age and the stale banner", () => {
  const w = world();
  const now = Date.parse("2026-10-15T12:00:00Z");
  assert.equal(w.api.dataAgeHours("2026-10-15T09:00:00Z", now), 3);
  assert.equal(w.api.dataAgeHours(null, now), null);
  w.api.showStaleDataBanner("2020-01-01T00:00:00Z");
  assert.equal(w.body.children.length, 1);
  const fresh = world();
  fresh.api.showStaleDataBanner(new Date().toISOString());
  assert.equal(fresh.body.children.length, 0);
});

test("sw.js caches the data host on its plain path", () => {
  const sw = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  assert.match(sw, /DATA_HOSTS = \["data\.fish2catch\.app"\]/);
  assert.match(sw, /sameOrigin \|\| isData \? url\.origin \+ url\.pathname/);
});
