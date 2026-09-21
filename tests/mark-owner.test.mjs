// Who owns a mark: Catches and Sessions belong to the signed-in person's own account, Mark/POI to the shared
// "public" account (Admin only). The Worker decides from the mark's type; reads for Admin combine both.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = path.join(os.tmpdir(), `ub-owner-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const worker = (await import(pathToFileURL(tmp).href)).default;

const SITE = "https://site.example";
const ME = "admin-id";

// A tiny in-memory marks table behind the D1 interface the Worker uses.
function makeEnv(role, marks) {
  const log = { selects: [], inserts: [], updates: [], deletes: [] };
  const inList = (sql, args) => {
    const n = (sql.match(/user_id IN \(([^)]*)\)/)?.[1].match(/\?/g) || []).length;
    return args.slice(-n - (/LIMIT/.test(sql) ? 2 : 0), args.length - (/LIMIT/.test(sql) ? 2 : 0));
  };
  return {
    log,
    ALLOWED_ORIGIN: SITE,
    DB: {
      prepare(sql) {
        let args = [];
        return {
          bind(...a) { args = a; return this; },
          async first() {
            if (/FROM sessions/.test(sql)) return { id: ME, role };
            if (/FROM marks WHERE id = \? AND user_id IN/.test(sql)) return marks.find((m) => m.id === args[0] && args.slice(1).includes(m.user_id)) || null;
            if (/FROM marks WHERE id = \?/.test(sql)) return marks.find((m) => m.id === args[0]) || null;
            return null;
          },
          async all() {
            log.selects.push(args);
            const owners = inList(sql, args);
            return { results: marks.filter((m) => owners.includes(m.user_id)) };
          },
          async run() {
            if (/^\s*INSERT INTO marks/.test(sql)) {
              log.inserts.push({ id: args[0], owner: args[1] });
              marks.push({ id: args[0], user_id: args[1], type: args[5], lat: args[2], lng: args[3], date_time: args[6] });
            } else if (/^\s*UPDATE marks/.test(sql)) {
              log.updates.push({ id: args[args.length - 2], owner: args[args.length - 3], from: args[args.length - 1] });
              const m = marks.find((x) => x.id === args[args.length - 2]);
              if (m) { m.user_id = args[args.length - 3]; m.type = args[3]; }
            } else if (/^\s*DELETE FROM marks/.test(sql)) {
              log.deletes.push({ id: args[0], owner: args[1] });
              const i = marks.findIndex((x) => x.id === args[0] && x.user_id === args[1]);
              if (i >= 0) marks.splice(i, 1);
            }
            return {};
          },
        };
      },
    },
  };
}
const headers = { Cookie: "session=s", Origin: SITE, "Content-Type": "application/json" };
const call = (env, method, p, body) =>
  worker.fetch(new Request("https://worker.example" + p, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
const mark = (type, extra = {}) => ({ id: "n1", lat: -38, lng: 145, type, dateTime: "2026-01-01 10:00:00", ...extra });

test("Admin's Catches and Sessions are saved to their own account, Mark and POI to the shared one", async () => {
  for (const [type, owner] of [["Catch", ME], ["Session Start", ME], ["Session End", ME], ["Mark", "public"], ["POI", "public"]]) {
    const env = makeEnv("admin", []);
    const res = await call(env, "POST", "/api/marks?userId=public", mark(type)); // an old client still sends ?userId=public: ignored
    assert.equal(res.status, 201, type);
    assert.equal(env.log.inserts[0].owner, owner, type);
  }
});

test("a normal user's marks always go to their own account", async () => {
  for (const type of ["Catch", "Mark", "POI"]) {
    const env = makeEnv("basic", []);
    await call(env, "POST", "/api/marks", mark(type));
    assert.equal(env.log.inserts[0].owner, ME, type);
  }
});

test("everyone signed in sees their own and the shared marks, never another user's; each mark says which set it is in", async () => {
  const rows = () => [
    { id: "c1", user_id: ME, type: "Catch", date_time: "2026-01-02 00:00:00" },
    { id: "m1", user_id: "public", type: "Mark", date_time: "2026-01-01 00:00:00" },
    { id: "x1", user_id: "someone-else", type: "Catch", date_time: "2026-01-03 00:00:00" },
  ];
  for (const role of ["admin", "basic"]) {
    for (const p of ["/api/public/marks", "/api/marks"]) {
      const seen = await (await call(makeEnv(role, rows()), "GET", p)).json();
      assert.deepEqual(seen.map((m) => m.id).sort(), ["c1", "m1"], `${role} ${p}`);
      assert.deepEqual(Object.fromEntries(seen.map((m) => [m.id, m.owner])), { c1: "Mine", m1: "Public" }, `${role} ${p}`);
    }
  }
});

test("Admin can edit and delete a shared mark; ownership follows the type when it changes", async () => {
  const marks = [{ id: "m1", user_id: "public", type: "Mark", lat: 1, lng: 2, date_time: "2026-01-01 00:00:00" }];
  const env = makeEnv("admin", marks);
  const put = await call(env, "PUT", "/api/marks/m1", { type: "Catch" });
  assert.equal(put.status, 200);
  assert.deepEqual(env.log.updates[0], { id: "m1", owner: ME, from: "public" }); // a Mark edited into a Catch moves to their account
  const del = await call(env, "DELETE", "/api/marks/m1");
  assert.equal(del.status, 204);
  assert.deepEqual(env.log.deletes[0], { id: "m1", owner: ME });
});

test("a normal user cannot touch the shared marks", async () => {
  const marks = [{ id: "m1", user_id: "public", type: "Mark", lat: 1, lng: 2, date_time: "2026-01-01 00:00:00" }];
  const env = makeEnv("basic", marks);
  assert.equal((await call(env, "PUT", "/api/marks/m1", { name: "x" })).status, 404);
  assert.equal((await call(env, "DELETE", "/api/marks/m1")).status, 404);
  assert.equal(marks.length, 1);
});
