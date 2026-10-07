// "Refresh data now" (Settings, admin only): runs the scheduled pipeline Worker over a service binding when one is bound, and keeps
// dispatching the GitHub workflow otherwise (so nothing changes until the cutover binds PIPELINE).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = path.join(os.tmpdir(), `ub-refresh-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const SITE = "https://site.example";
function makeEnv(role, extra = {}) {
  return {
    ALLOWED_ORIGIN: SITE,
    PIPELINE_API_TOKEN: "secret",
    DB: {
      prepare() {
        return {
          bind() { return this; },
          async first() { return role ? { id: "u1", role } : null; },
        };
      },
    },
    ...extra,
  };
}
const refresh = (env) => worker.fetch(new Request("https://worker.example/api/admin/refresh-data-now", { method: "POST", headers: { Origin: SITE, Cookie: "session=abc" } }), env);
const pipelineBinding = (status, body) => {
  const calls = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, method: init.method, token: init.headers["X-Pipeline-Token"] }); return new Response(JSON.stringify(body), { status }); } };
};

test("only an admin can refresh", async () => {
  assert.equal((await refresh(makeEnv("basic", { PIPELINE: pipelineBinding(200, {}) }))).status, 403);
  assert.equal((await refresh(makeEnv(null))).status, 401);
});

test("with the pipeline bound, it runs the pipeline over the binding with the shared token and reports the run", async () => {
  const PIPELINE = pipelineBinding(200, { ok: true, published: true, runId: "20261007T053000Z" });
  const res = await refresh(makeEnv("admin", { PIPELINE }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { triggered: true, via: "pipeline", runId: "20261007T053000Z", published: true });
  assert.equal(PIPELINE.calls.length, 1);
  assert.equal(PIPELINE.calls[0].method, "POST");
  assert.match(PIPELINE.calls[0].url, /\/run$/);
  assert.equal(PIPELINE.calls[0].token, "secret");
});

test("a run that is refused by the publish gate or blocked by the lock is reported plainly, not as a success", async () => {
  const gate = await refresh(makeEnv("admin", { PIPELINE: pipelineBinding(409, { ok: false, gate: { reasons: ["only 3 of 26 locations returned weather data"] } }) }));
  assert.equal(gate.status, 409);
  assert.match((await gate.json()).error, /not published: only 3 of 26/);
  const locked = await refresh(makeEnv("admin", { PIPELINE: pipelineBinding(409, { ok: false, skipped: "locked" }) }));
  assert.match((await locked.json()).error, /already running/);
});

test("a pipeline Worker failure is a 502, and an unreachable one too", async () => {
  assert.equal((await refresh(makeEnv("admin", { PIPELINE: pipelineBinding(500, {}) }))).status, 502);
  const down = { fetch: async () => { throw new Error("no route"); } };
  assert.equal((await refresh(makeEnv("admin", { PIPELINE: down }))).status, 502);
});

test("without the binding it still dispatches the GitHub workflow, exactly as before", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), method: init.method, auth: init.headers.Authorization }); return new Response(null, { status: 204 }); };
  try {
    const res = await refresh(makeEnv("admin", { GH_ACTIONS_TOKEN: "ghp", GH_REPO_OWNER: "o", GH_REPO_NAME: "r", GH_WORKFLOW_FILE: "update.yml" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { triggered: true });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://api.github.com/repos/o/r/actions/workflows/update.yml/dispatches");
    assert.equal(seen[0].auth, "Bearer ghp");
  } finally {
    globalThis.fetch = realFetch;
  }
});
