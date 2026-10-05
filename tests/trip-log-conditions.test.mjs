// The Worker's hourly weather / tide backfill for trip-log rows (user-backend.js, "Trip log: weather / tide backfill"): its pure helpers
// must give what the browser's lookup gives (js/mark-lookup.js, js/marks-core.js, js/chart-base.js, js/weather-preview.js), and the job
// itself is run against a real SQLite engine with the archive tables and a stubbed Open-Meteo.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const workerSrc = read("../user-backend.js");
const marksCore = read("../js/marks-core.js");
const chartBase = read("../js/chart-base.js");
const markLookup = read("../js/mark-lookup.js");
const weatherPreview = read("../js/weather-preview.js");

const grab = (src, re) => {
  const m = re.exec(src);
  assert.ok(m, `not found: ${re}`);
  return m[0];
};

// --- the twins against the browser's own source ----------------------------------------------------------------------------
const browser = new Function(
  [
    grab(chartBase, /const COMPASS_DEGREES = \{[\s\S]*?\n\};\n/),
    grab(chartBase, /const SHORE_OPTIONS = [^\n]*\n/),
    grab(chartBase, /function naiveDateOnlyStr[\s\S]*?\n}\n/),
    grab(chartBase, /function rankExtremum[\s\S]*?\n}\n/),
    grab(marksCore, /const TIDE_SLACK_WINDOW_MS[^\n]*\n/),
    grab(marksCore, /const TIDE_RUN_TRANSITION_ZONE_MS[^\n]*\n/),
    grab(marksCore, /function classifyTideFromExtrema[\s\S]*?\n}\n/),
    grab(markLookup, /function weatherCodeToCondition[\s\S]*?\n}\n/),
    grab(weatherPreview, /function previewDegreesToCompass[\s\S]*?\n}\n/),
    grab(markLookup, /function markConditionsFromObservationRow[\s\S]*?\n}\n/),
    "return { classifyTideFromExtrema, weatherCodeToCondition, previewDegreesToCompass, markConditionsFromObservationRow };",
  ].join("\n")
)();
const worker = new Function(
  [
    grab(workerSrc, /const CTL_WIND_DIRECTIONS = [^\n]*\n/),
    grab(workerSrc, /const TLOG_TIDE_SLACK_MS[^\n]*\n/),
    grab(workerSrc, /const TLOG_TIDE_RUN_ZONE_MS[^\n]*\n/),
    grab(workerSrc, /function tlogDateOnly[\s\S]*?\n}\n/),
    grab(workerSrc, /function tlogWeatherCondition[\s\S]*?\n}\n/),
    grab(workerSrc, /function tlogCompass[\s\S]*?\n}\n/),
    grab(workerSrc, /function tlogRankExtremum[\s\S]*?\n}\n/),
    grab(workerSrc, /function tlogClassifyTide[\s\S]*?\n}\n/),
    grab(workerSrc, /function tlogFieldsFromObservation[\s\S]*?\n}\n/),
    "return { tlogClassifyTide, tlogWeatherCondition, tlogCompass, tlogFieldsFromObservation };",
  ].join("\n")
)();

test("tide classification: the Worker's twin agrees with the browser at every minute across several tide cycles", () => {
  // two unequal highs and lows a day, like the real tides (mixed semidiurnal), over three days
  const H = 3600000;
  const day0 = Date.UTC(2026, 9, 3);
  const extrema = [];
  const pattern = [[2.5, "low", 0.4], [8.4, "high", 1.5], [14.6, "low", 0.1], [20.9, "high", 1.1]];
  for (let d = 0; d < 4; d++) for (const [h, type, height] of pattern) extrema.push({ t: day0 + d * 24 * H + h * H, type, height: height + d * 0.05 });
  let compared = 0;
  for (let t = extrema[0].t; t < extrema[extrema.length - 1].t; t += 5 * 60000) {
    const a = browser.classifyTideFromExtrema(extrema, t);
    const b = worker.tlogClassifyTide(extrema, t);
    assert.deepEqual(b, a, `at ${new Date(t).toISOString()}`);
    compared++;
  }
  assert.ok(compared > 800);
  assert.equal(worker.tlogClassifyTide(extrema, extrema[0].t - 1), null, "needs an extremum either side");
  assert.deepEqual(worker.tlogClassifyTide(extrema, extrema[1].t + 5 * 60000), { condition: "Slack High", extreme: browser.classifyTideFromExtrema(extrema, extrema[1].t + 5 * 60000).extreme });
});

test("weather code, compass point and archive row: the Worker's twins agree with the browser's", () => {
  for (const code of [null, undefined, 0, 1, 2, 3, 45, 48, 51, 61, 80, 95]) assert.equal(worker.tlogWeatherCondition(code), browser.weatherCodeToCondition(code), `code ${code}`);
  for (let deg = 0; deg <= 360; deg += 3.7) assert.equal(worker.tlogCompass(deg), browser.previewDegreesToCompass(deg), `${deg} degrees`);
  const row = { wind_kmh: 12.4, wind_dir: "SSW", pressure_hpa: 1022.94, temp_c: 13.46, water_temp_c: 14.52 };
  const asApi = { windKmh: row.wind_kmh, windDir: row.wind_dir, pressureHpa: row.pressure_hpa, tempC: row.temp_c, waterTempC: row.water_temp_c };
  assert.deepEqual(worker.tlogFieldsFromObservation(row), browser.markConditionsFromObservationRow(asApi));
  assert.deepEqual(worker.tlogFieldsFromObservation(null), {});
  assert.deepEqual(worker.tlogFieldsFromObservation({ wind_kmh: null, wind_dir: "XYZ" }), {}, "unknown compass text and missing numbers are left out");
});

// --- the job itself -------------------------------------------------------------------------------------------------------
const tmp = path.join(os.tmpdir(), `ub-conditions-test-${process.pid}.mjs`);
fs.copyFileSync(new URL("../user-backend.js", import.meta.url), tmp);
const app = (await import(pathToFileURL(tmp).href)).default;
const schema = read("../schema-v2.sql");
const table = (name) => grab(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\)[^;]*;`));

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const H = 3600000;

function seeded() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, email TEXT, name TEXT);");
  for (const t of ["locations", "observations", "tide_events", "trip_log"]) sqlite.exec(table(t));
  sqlite.prepare("INSERT INTO users VALUES ('u1', 'basic', 'a@x', 'A'), ('u2', 'basic', 'b@x', 'B'), ('public', 'public', 'p@x', 'P')").run();
  const loc = (id, owner, name, lat, lng, offset) =>
    sqlite.prepare("INSERT INTO locations (id, created_by_user_id, name, lat, lng, willyweather_id, tide_offset, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, 1)").run(id, owner, name, lat, lng, offset);
  loc("l1", "public", "Lang Lang", -38.37, 145.55, 0);
  loc("l2", "public", "Far Away", -35.0, 140.0, 0);
  loc("l3", "u2", "Someone's Spot", -38.3701, 145.5501, 0); // nearer, but u2's own: not visible to u1
  sqlite.prepare("INSERT INTO observations (location_name, hour, temp_c, wind_kmh, wind_dir, pressure_hpa, water_temp_c) VALUES ('Lang Lang', '2026-10-05 07:00', 13.46, 12.4, 'SSW', 1022.94, 14.52)").run();
  const tide = (time, type, h) => sqlite.prepare("INSERT INTO tide_events (location_name, event_time, type, height_m) VALUES ('Lang Lang', ?, ?, ?)").run(time, type, h);
  tide("2026-10-05 02:30:00", "low", 0.4);
  tide("2026-10-05 08:20:00", "high", 1.5);
  tide("2026-10-05 14:40:00", "low", 0.1);
  tide("2026-10-05 20:50:00", "high", 1.1);
  tide("2026-10-04 20:40:00", "high", 1.3);
  tide("2026-10-04 14:10:00", "low", 0.2);
  tide("2026-10-06 03:10:00", "low", 0.3);
  const row = (id, ts, dateTime, lat, lng, run = "run1") =>
    sqlite.prepare("INSERT INTO trip_log (id, user_id, run_id, event_type, ts, date_time, lat, lng, source, source_uuid, created_at) VALUES (?, 'u1', ?, 'action_start', ?, ?, ?, ?, 'Controller', ?, 1)").run(id, run, ts, dateTime, lat, lng, `uuid-${id}`);
  row("good", NOW - 4 * H, "2026-10-05 07:30:00", -38.37, 145.56);
  row("young", NOW - 1 * H, "2026-10-05 10:30:00", -38.37, 145.56);
  row("old", NOW - 4 * 86400000, "2026-10-01 07:30:00", -38.37, 145.56);
  row("nopos", NOW - 5 * H, "2026-10-05 06:30:00", null, null, "run2");
  row("neighbour", NOW - 6 * H, "2026-10-05 05:30:00", -38.37, 145.56, "run2");
  const d1 = {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        _run: () => sqlite.prepare(sql).run(...args),
      };
      return stmt;
    },
    async batch(stmts) { sqlite.exec("BEGIN"); try { const out = stmts.map((s) => ({ meta: { changes: Number(s._run().changes) } })); sqlite.exec("COMMIT"); return out; } catch (e) { sqlite.exec("ROLLBACK"); throw e; } },
  };
  return { sqlite, env: { DB: d1 } };
}

async function runCron(env, fetchStub) {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  globalThis.fetch = fetchStub;
  Date.now = () => NOW;
  const pending = [];
  try {
    await app.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
}
const meteo = (calls) => async (url) => {
  calls.push(String(url));
  const time = Array.from({ length: 24 }, (_, h) => `2026-10-05T${String(h).padStart(2, "0")}:00`);
  const fill = (v) => time.map(() => v);
  return { ok: true, json: async () => ({ hourly: { time, windspeed_10m: fill(18.2), winddirection_10m: fill(190), pressure_msl: fill(1019.97), weathercode: fill(2), temperature_2m: fill(11.04) } }) };
};
const rowOf = (sqlite, id) => sqlite.prepare("SELECT * FROM trip_log WHERE id = ?").get(id);

test("the hourly job fills tide and weather from the archive and Open-Meteo, only for rows old enough, and marks them done", async () => {
  const { sqlite, env } = seeded();
  const calls = [];
  await runCron(env, meteo(calls));

  const good = rowOf(sqlite, "good");
  assert.deepEqual([good.tide_condition, good.tide_extreme], ["Last Run In", "HHW"], "07:30 is 50 minutes before the 08:20 high, inside its last two hours");
  assert.equal(good.weather_condition, "Cloudy", "from Open-Meteo's weather code 2 (the archive has no weather condition)");
  assert.deepEqual([good.wind_speed, good.wind_direction, good.barometer, good.temperature, good.water_temperature], [12, "SSW", 1022.9, 13.5, 14.5], "the archive's reading wins over Open-Meteo's");
  assert.ok(good.conditions_at, "complete: not picked up again");

  assert.equal(rowOf(sqlite, "young").conditions_at, null, "its hour isn't archived yet");
  assert.equal(rowOf(sqlite, "young").tide_condition, null);
  assert.equal(rowOf(sqlite, "old").conditions_at, null, "older than 3 days: left for the browser's WillyWeather fallback");
  assert.equal(rowOf(sqlite, "old").tide_condition, null);

  // a row with no position borrows the nearest row of the same run; another user's location is never used
  const nopos = rowOf(sqlite, "nopos");
  assert.ok(nopos.tide_condition && nopos.weather_condition && nopos.conditions_at);
  assert.equal(nopos.lat, null, "the borrowed position is only used for the lookup");
  assert.ok(rowOf(sqlite, "neighbour").conditions_at);

  // one Open-Meteo call per place and day, shared by every row there
  assert.equal(calls.length, 1);
  assert.match(calls[0], /start_date=2026-10-05/);
});

test("a row whose tide can't be worked out keeps what it got and is retried; a failed Open-Meteo call isn't fatal", async () => {
  const { sqlite, env } = seeded();
  sqlite.prepare("DELETE FROM tide_events").run();
  await runCron(env, async () => ({ ok: false, json: async () => ({}) }));
  const good = rowOf(sqlite, "good");
  assert.equal(good.tide_condition, null);
  assert.equal(good.weather_condition, null);
  assert.equal(good.wind_speed, 12, "the archive's part was still saved");
  assert.equal(good.conditions_at, null, "not complete: it will be tried again");

  // next hour the data is there: it completes without overwriting what was saved
  sqlite.prepare("INSERT INTO tide_events (location_name, event_time, type, height_m) VALUES ('Lang Lang', '2026-10-05 02:30:00', 'low', 0.4), ('Lang Lang', '2026-10-05 08:20:00', 'high', 1.5)").run();
  await runCron(env, meteo([]));
  const again = rowOf(sqlite, "good");
  assert.equal(again.tide_condition, "Last Run In");
  assert.equal(again.weather_condition, "Cloudy");
  assert.ok(again.conditions_at);
});

test("nothing waiting means no work; a throwing fetch can't break the cron", async () => {
  const { sqlite, env } = seeded();
  sqlite.prepare("UPDATE trip_log SET conditions_at = 1").run();
  const calls = [];
  await runCron(env, meteo(calls));
  assert.equal(calls.length, 0);

  const second = seeded();
  await runCron(second.env, async () => {
    throw new Error("offline");
  });
  assert.ok(rowOf(second.sqlite, "good").tide_condition, "the tide doesn't need the network");
});
