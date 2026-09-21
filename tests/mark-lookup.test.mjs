// Filling a new mark's blank conditions when it is saved: archive first, Open-Meteo for the rest,
// the billed WillyWeather call only when the archive has no tide events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSharedScripts } from "./helpers.mjs";

const src = readSharedScripts();
const grab = (re) => {
  const m = src.match(re);
  if (!m) throw new Error("could not find in js/*.js: " + re);
  return m[0];
};
const fn = (name) => grab(new RegExp(`function ${name}\\b[\\s\\S]*?\\r?\\n}\\r?\\n`));
const afn = (name) => grab(new RegExp(`async function ${name}\\b[\\s\\S]*?\\r?\\n}\\r?\\n`));

const code = [
  "const { fetch, findNearestTrackedLocation, fetchStoredObservations, fetchStoredTideExtrema, fetchOpenMeteoHistoricalHourly, fetchOpenMeteoHistoricalMarineHourly } = stubs;",
  'const WILLYWEATHER_SEARCH_WORKER_URL = "https://worker.test";',
  grab(/const COMPASS_DEGREES = \{[\s\S]*?\};\r?\n/),
  grab(/const SHORE_OPTIONS[^\n]*\r?\n/),
  grab(/const TIDE_SLACK_WINDOW_MS[^\n]*\r?\n/),
  grab(/const TIDE_RUN_TRANSITION_ZONE_MS[^\n]*\r?\n/),
  grab(/const MARK_TYPE_FIELD_KEYS = \{[\s\S]*?\n\};\r?\n/),
  grab(/MARK_TYPE_FIELD_KEYS\.Fish = [^\n]*\r?\n/),
  grab(/const SESSION_FIELD_KEYS = [^\n]*\r?\n/),
  grab(/MARK_TYPE_FIELD_KEYS\["Session Start"\] = [^\n]*\r?\n/),
  grab(/MARK_TYPE_FIELD_KEYS\["Session End"\] = [^\n]*\r?\n/),
  fn("fieldKeysForMarkType"),
  fn("parseNaive"),
  fn("naiveDateOnlyStr"),
  fn("rankExtremum"),
  fn("classifyTideFromExtrema"),
  fn("previewDegreesToCompass"),
  fn("openMeteoHourlyLookup"),
  fn("weatherCodeToCondition"),
  grab(/const MARK_LOOKUP_KEYS[^\n]*\r?\n/),
  fn("markConditionsFromObservationRow"),
  "const _storedObservationDayCache = new Map();",
  afn("storedObservationRowFor"),
  fn("blankConditionKeys"),
  afn("lookupTideConditionAt"),
  afn("lookupHistoricalMarkConditions"),
  afn("fillBlankMarkConditions"),
  "return { markConditionsFromObservationRow, blankConditionKeys, fillBlankMarkConditions };",
].join("\n");
const build = (stubs) => new Function("stubs", code)(stubs);

const H = 3600000;
const T = (s) => Date.parse(s + "Z"); // naive wall-clock ms, like parseNaive
// events around 2026-09-20T07:30: low 02:00 (LLW), high 08:00, low 13:30, high 19:30
const events = [
  { t: T("2026-09-20T02:00:00"), type: "low", height: 0.2 },
  { t: T("2026-09-20T08:00:00"), type: "high", height: 1.0 },
  { t: T("2026-09-20T13:30:00"), type: "low", height: 0.6 },
  { t: T("2026-09-20T19:30:00"), type: "high", height: 1.4 },
];
const obsRow = { hour: "2026-09-20 07:00", tempC: 16.26, windKmh: 10.4, windDir: "S", pressureHpa: 1012.04, waterTempC: 14.04 };

/** Stubs that count every call, with the archive holding an observation row and tide events by default. */
function makeStubs(over = {}) {
  const calls = { observations: 0, tideEvents: 0, openMeteo: 0, marine: 0, billed: 0 };
  const stubs = {
    calls,
    findNearestTrackedLocation: async () => ({ name: "Spot", willyweatherId: 1, tideOffset: 0 }),
    fetchStoredObservations: async () => {
      calls.observations++;
      return [obsRow];
    },
    fetchStoredTideExtrema: async () => {
      calls.tideEvents++;
      return events;
    },
    fetchOpenMeteoHistoricalHourly: async () => {
      calls.openMeteo++;
      return { time: ["2026-09-20T07:00"], windspeed_10m: [30], winddirection_10m: [0], pressure_msl: [999], weathercode: [0], temperature_2m: [10] };
    },
    fetchOpenMeteoHistoricalMarineHourly: async () => {
      calls.marine++;
      return { time: ["2026-09-20T07:00"], sea_surface_temperature: [12] };
    },
    fetch: async () => {
      calls.billed++;
      return {
        ok: true,
        json: async () => ({
          forecasts: {
            tides: {
              days: [{ entries: events.map((e) => ({ dateTime: new Date(e.t).toISOString().slice(0, 19), height: e.height, type: e.type })) }],
            },
          },
        }),
      };
    },
    ...over,
  };
  return stubs;
}

test("an archive observation row becomes mark fields, rounded like the live lookup", () => {
  const { markConditionsFromObservationRow } = build(makeStubs());
  assert.deepEqual(markConditionsFromObservationRow(obsRow), {
    windSpeed: 10,
    windDirection: "S",
    barometer: 1012,
    temperature: 16.3,
    waterTemperature: 14,
  });
  assert.deepEqual(markConditionsFromObservationRow(null), {});
  assert.deepEqual(markConditionsFromObservationRow({ hour: "x", windKmh: null, windDir: null }), {});
});

test("the archive's compass names are used as they are, and an unknown one is ignored", () => {
  const { markConditionsFromObservationRow } = build(makeStubs());
  assert.equal(markConditionsFromObservationRow({ windDir: "WNW" }).windDirection, "WNW");
  assert.equal(markConditionsFromObservationRow({ windDir: "sideways" }).windDirection, undefined);
});

test("blank fields are found per mark type, and a value already there is not blank", () => {
  const { blankConditionKeys } = build(makeStubs());
  const blanks = blankConditionKeys({ type: "Catch", windSpeed: 12, tideCondition: "", barometer: null });
  assert.ok(!blanks.includes("windSpeed"));
  assert.ok(blanks.includes("tideCondition") && blanks.includes("barometer") && blanks.includes("weatherCondition"));
  assert.deepEqual(blankConditionKeys({ type: "POI" }), []);
  assert.deepEqual(blankConditionKeys({ type: "Mark" }), []);
});

test("saving fills only the blanks, from the archive first, without a billed call", async () => {
  const stubs = makeStubs();
  const { fillBlankMarkConditions } = build(stubs);
  const mark = { type: "Catch", lat: -38.1, lng: 145.1, dateTime: "2026-09-20 07:30:00", windSpeed: 99 };
  await fillBlankMarkConditions(mark);
  assert.equal(mark.windSpeed, 99); // already there: never overwritten
  assert.equal(mark.windDirection, "S"); // from the archive, not Open-Meteo's 0/N
  assert.equal(mark.barometer, 1012);
  assert.equal(mark.temperature, 16.3);
  assert.equal(mark.waterTemperature, 14);
  assert.equal(mark.tideCondition, "Last Run In"); // 07:30 is 30 min before the 08:00 high
  assert.equal(mark.tideExtreme, "LHW"); // that day's lower high
  assert.equal(mark.weatherCondition, "Clear"); // the archive has no weather code, so this one came from Open-Meteo
  assert.equal(stubs.calls.billed, 0);
  assert.equal(stubs.calls.marine, 0); // water temperature was already in the archive
});

test("only what is blank is looked up: nothing at all when nothing is blank", async () => {
  const stubs = makeStubs();
  const { fillBlankMarkConditions } = build(stubs);
  const full = { type: "Catch", lat: -38.1, lng: 145.1, dateTime: "2026-09-20 07:30:00", weatherCondition: "Rain", tideCondition: "Slack Low", tideExtreme: "LLW", barometer: 1000, temperature: 10, waterTemperature: 12, windDirection: "N", windSpeed: 5 };
  await fillBlankMarkConditions(full);
  assert.deepEqual(stubs.calls, { observations: 0, tideEvents: 0, openMeteo: 0, marine: 0, billed: 0 });
  assert.equal(full.weatherCondition, "Rain");
});

test("the billed tide call happens only when the archive has no tide events", async () => {
  const stubs = makeStubs({ fetchStoredTideExtrema: async () => null });
  const { fillBlankMarkConditions } = build(stubs);
  const mark = { type: "Catch", lat: -38.1, lng: 145.1, dateTime: "2026-09-20 07:30:00" };
  await fillBlankMarkConditions(mark);
  assert.equal(stubs.calls.billed, 1);
  assert.equal(mark.tideCondition, "Last Run In");
});

test("Open-Meteo fills what the archive lacks, and marine is only asked for when water temperature is missing", async () => {
  const stubs = makeStubs({ fetchStoredObservations: async () => [] });
  const { fillBlankMarkConditions } = build(stubs);
  const mark = { type: "Catch", lat: -38.1, lng: 145.1, dateTime: "2026-09-20 07:30:00" };
  await fillBlankMarkConditions(mark);
  assert.equal(mark.windSpeed, 30);
  assert.equal(mark.barometer, 999);
  assert.equal(mark.waterTemperature, 12);
  assert.equal(stubs.calls.marine, 1);
});

test("a lookup that fails leaves the fields blank and never throws", async () => {
  const stubs = makeStubs({
    fetchStoredObservations: async () => {
      throw new Error("archive down");
    },
  });
  const { fillBlankMarkConditions } = build(stubs);
  const mark = { type: "Catch", lat: -38.1, lng: 145.1, dateTime: "2026-09-20 07:30:00" };
  const out = await fillBlankMarkConditions(mark);
  assert.equal(out, mark);
  assert.equal(mark.windSpeed, undefined);
});

test("a mark with no position or time is left alone", async () => {
  const stubs = makeStubs();
  const { fillBlankMarkConditions } = build(stubs);
  const mark = { type: "Catch" };
  await fillBlankMarkConditions(mark);
  assert.deepEqual(stubs.calls, { observations: 0, tideEvents: 0, openMeteo: 0, marine: 0, billed: 0 });
});

