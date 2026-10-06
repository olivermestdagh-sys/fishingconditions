// Trip Logs tab: trips (headers) at the top, the selected trip's log lines underneath, each line with its rod setups as sub-rows in
// separate columns, and every line can be edited, added or deleted by hand. Reads / writes the trip log the Worker keeps in D1
// (user-backend.js "Trip log": GET /api/triplog?list=1 for the headers, ?runId= / ?markId= for a trip's lines, PATCH / DELETE
// /api/triplog/<id>, POST /api/triplog/lines). Pure helpers: js/trip-log-view.js. Deep links: #run=<runId> and #mark=<markId>.

let tlRuns = []; // every header the filters let through, newest first
let tlSelectedRunId = null;
let tlLoadToken = 0; // a slow answer for a trip that is no longer selected is dropped
let tlEntries = []; // the selected trip's lines
let tlRenaming = null; // runId whose Trip name is open for editing in the headers
let tlEditing = null; // {id (null = a new line), form} while a line is open in the editor
let tlLists = null; // pick-lists for the editor, loaded on first edit

const TL_COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

async function tlGet(query) {
  const res = await fetch(`${USER_BACKEND_URL}/api/triplog?${query}`, { cache: "no-store", credentials: "include" });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

/** A write to the trip log; throws the Worker's own message when it refuses. */
async function tlSend(method, path, body) {
  const res = await fetch(`${USER_BACKEND_URL}${path}`, {
    method, credentials: "include", headers: body !== undefined ? { "Content-Type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `status ${res.status}`);
  return data;
}

const tlEsc = (v) => escapeHtml(v == null ? "" : String(v));
const tlClock = (dateTime) => String(dateTime || "").slice(11, 16);

// --- Headers (top) ---------------------------------------------------------------------------------------------------

function tlFilters() {
  return { trip: document.getElementById("tlTripFilter").value, from: document.getElementById("tlFrom").value, to: document.getElementById("tlTo").value };
}

async function tlLoadRuns() {
  const f = tlFilters();
  const q = ["list=1", f.from ? `from=${f.from}` : "", f.to ? `to=${f.to}` : ""].filter(Boolean).join("&");
  const status = document.getElementById("tlSummary");
  try {
    tlRuns = await tlGet(q);
  } catch (err) {
    console.error("Could not load trip logs:", err);
    tlRuns = [];
    status.textContent = "Couldn't load your trip logs — try reloading the page.";
    document.getElementById("tlRuns").innerHTML = "";
    return;
  }
  tlFillTripFilter();
  tlRenderRuns();
}

/** The Trip pick-list holds the names that appear in the (date-filtered) list, keeping the chosen one if it is still there. */
function tlFillTripFilter() {
  const select = document.getElementById("tlTripFilter");
  const chosen = select.value;
  const names = [...new Set(tlRuns.map((r) => r.tripName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = `<option value="">All trips</option>` + names.map((n) => `<option value="${tlEsc(n)}">${tlEsc(n)}</option>`).join("");
  select.value = names.includes(chosen) ? chosen : "";
}

function tlVisibleRuns() {
  const trip = tlFilters().trip;
  return trip ? tlRuns.filter((r) => r.tripName === trip) : tlRuns;
}

function tlRenderRuns() {
  const runs = tlVisibleRuns();
  const totals = tripLogTotals(runs);
  document.getElementById("tlSummary").textContent = runs.length
    ? `${totals.trips} trip${totals.trips === 1 ? "" : "s"} · ${tripLogFormatDuration(totals.fishedMs) || "0 min"} fished · ${totals.catches} catch${totals.catches === 1 ? "" : "es"}`
    : "";
  const wrap = document.getElementById("tlRuns");
  if (!runs.length) {
    wrap.innerHTML = `<div class="tl-empty">No trip logs yet — they are written as you run trips on the Map's Live mode or the Fishing Controller.</div>`;
    document.getElementById("tlDetailCard").style.display = "none";
    return;
  }
  wrap.innerHTML = `<table class="tl-table tl-runs">
    <thead><tr><th>Date</th><th>Trip</th><th>Start – end</th><th class="num">Duration</th><th class="num">Fished</th><th class="num">Actions</th><th class="num">Catches</th><th></th><th></th></tr></thead>
    <tbody>${runs
      .map((r) => {
        const flags = tripLogFlags(r).map((f) => `<span class="tl-flag">${tlEsc(f)}</span>`).join("");
        return `<tr tabindex="0" data-run="${tlEsc(r.runId)}" class="${r.runId === tlSelectedRunId ? "selected" : ""}" aria-selected="${r.runId === tlSelectedRunId}">
          <td>${tlEsc(tripLogDateLabel(r.startDateTime))}</td><td>${tlRenaming === r.runId ? `<input type="text" class="tl-rename-input" list="tlTripNames" maxlength="80" value="${tlEsc(r.tripName || "")}" placeholder="Trip name" aria-label="Trip name">` : tlEsc(r.tripName || "—")}</td>
          <td>${tlEsc(tlClock(r.startDateTime))} – ${r.hasTripEnd || r.endTs > r.startTs ? tlEsc(tlClock(r.endDateTime)) : "…"}</td>
          <td class="num">${tlEsc(tripLogFormatDuration(r.endTs - r.startTs))}</td><td class="num">${tlEsc(tripLogFormatDuration(r.fishedMs))}</td>
          <td class="num">${r.actions}</td><td class="num">${r.catches}</td><td>${flags}</td>
          <td class="act">${tlRenaming === r.runId ? `<button type="button" class="btn-primary tl-btn" data-rename-save>Save</button> <button type="button" class="btn-secondary tl-btn" data-rename-cancel>Cancel</button>` : `<button type="button" class="btn-secondary tl-btn" data-rename="${tlEsc(r.runId)}">${r.tripName ? "Rename" : "Name"}</button> <button type="button" class="btn-secondary tl-btn tl-danger-btn" data-delete-run="${tlEsc(r.runId)}">Delete</button>`}</td></tr>`;
      })
      .join("")}</tbody></table><datalist id="tlTripNames">${[...new Set(tlRuns.map((r) => r.tripName).filter(Boolean))].sort((a, b) => a.localeCompare(b)).map((n) => `<option value="${tlEsc(n)}">`).join("")}</datalist>`;
  wrap.querySelectorAll("button[data-rename]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      tlRenaming = b.dataset.rename;
      tlRenderRuns();
      const input = wrap.querySelector(".tl-rename-input");
      if (input) {
        input.focus();
        input.select();
      }
    })
  );
  wrap.querySelectorAll("button[data-delete-run]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const run = tlRuns.find((r) => r.runId === b.dataset.deleteRun);
      if (!run) return;
      const what = `${run.tripName || "this trip"} (${tripLogDateLabel(run.startDateTime)}, ${run.entries} line${run.entries === 1 ? "" : "s"})`;
      if (!confirm(`Delete ${what} from the trip log?

Its catches stay on the map as marks. It is removed for good after 30 days.`)) return;
      b.disabled = true;
      try {
        await tlSend("DELETE", `/api/triplog/run?runId=${encodeURIComponent(run.runId)}`);
        if (tlSelectedRunId === run.runId) {
          tlSelectedRunId = null;
          tlEntries = [];
          tlEditing = null;
          document.getElementById("tlDetailCard").style.display = "none";
          try {
            history.replaceState(null, "", location.pathname);
          } catch {
            // an address bar that can't change is fine
          }
        }
        await tlLoadRuns();
      } catch (err) {
        console.error("Could not delete the trip:", err);
        alert("Couldn't delete the trip: " + err.message);
        b.disabled = false;
      }
    })
  );
  const renameRow = tlRenaming ? wrap.querySelector(`tr[data-run="${CSS.escape(tlRenaming)}"]`) : null;
  if (renameRow) {
    const input = renameRow.querySelector(".tl-rename-input");
    const cancel = () => {
      tlRenaming = null;
      tlRenderRuns();
    };
    const save = async () => {
      const runId = tlRenaming;
      renameRow.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        await tlSend("PATCH", "/api/triplog/run", { runId, tripName: input.value });
        tlRenaming = null;
        await tlLoadRuns();
        if (runId === tlSelectedRunId) tlRenderDetail();
      } catch (err) {
        console.error("Could not rename the trip:", err);
        alert("Couldn't save the trip name: " + err.message);
        renameRow.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    };
    renameRow.querySelector("[data-rename-save]").addEventListener("click", (e) => {
      e.stopPropagation();
      save();
    });
    renameRow.querySelector("[data-rename-cancel]").addEventListener("click", (e) => {
      e.stopPropagation();
      cancel();
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") save();
      else if (e.key === "Escape") cancel();
    });
  }
  wrap.querySelectorAll("tr[data-run]").forEach((tr) => {
    const open = () => tlSelectRun(tr.dataset.run);
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  });
}

// --- Lines (underneath) ----------------------------------------------------------------------------------------------

async function tlSelectRun(runId, preloaded) {
  if (tlEditing && runId !== tlSelectedRunId && !confirm("Discard the line you are editing?")) return;
  tlEditing = null;
  tlSelectedRunId = runId;
  const token = ++tlLoadToken;
  try {
    history.replaceState(null, "", `#run=${encodeURIComponent(runId)}`);
  } catch {
    // an address bar that can't change is fine
  }
  tlRenderRuns(); // moves the highlight now; the lines follow
  const card = document.getElementById("tlDetailCard");
  const detail = document.getElementById("tlDetail");
  card.style.display = "";
  let data = preloaded || null;
  if (!data) {
    detail.innerHTML = `<div class="tl-empty">Loading…</div>`;
    try {
      data = await tlGet(`runId=${encodeURIComponent(runId)}`);
    } catch (err) {
      console.error("Could not load the trip's lines:", err);
      if (token === tlLoadToken) detail.innerHTML = `<div class="tl-empty">Couldn't load this trip's log.</div>`;
      return;
    }
  }
  if (token !== tlLoadToken) return;
  tlEntries = data.entries || [];
  tlRenderDetail();
}

/** Reloads the selected trip and the headers after a change (the line may have moved in time; the totals changed). */
async function tlReloadAfterChange() {
  tlEditing = null;
  const runId = tlSelectedRunId;
  await tlLoadRuns();
  try {
    tlEntries = (await tlGet(`runId=${encodeURIComponent(runId)}`)).entries || [];
  } catch {
    tlEntries = [];
  }
  tlRenderDetail();
}

/** The separate gear columns for one line's rod rows. */
function tlGearTable(rods) {
  if (!rods || !rods.length) return "";
  const list = (v) => tlEsc((v || []).join(", "));
  return `<table class="tl-gear-table"><colgroup><col style="width:20%"><col style="width:13%"><col style="width:13%"><col style="width:18%"><col style="width:18%"><col style="width:18%"></colgroup><thead><tr><th>Rod setup</th><th>Rod</th><th>Rig</th><th>Rig options</th><th>Bait</th><th>Bait options</th></tr></thead><tbody>${rods
    .map((r) => `<tr><td>${tlEsc(r.name)}</td><td>${tlEsc(r.rod)}</td><td>${tlEsc(r.rig)}</td><td>${list(r.rigOptions)}</td><td>${list(r.bait)}</td><td>${list(r.baitOptions)}</td></tr>`)
    .join("")}</tbody></table>`;
}

function tlRenderDetail() {
  const detail = document.getElementById("tlDetail");
  const run = tlRuns.find((r) => r.runId === tlSelectedRunId) || {};
  const entries = tlEntries;
  if (!entries.length && !tlEditing) {
    detail.innerHTML = `<div class="tl-empty">This trip has no log lines.</div>`;
    return;
  }
  const startTs = entries.length ? entries[0].ts : 0;
  const durations = tripLogDurations(entries);
  const fished = [...durations.values()].reduce((a, b) => a + b, 0);
  const catches = entries.filter((e) => e.type === "catch").length;
  const actions = entries.filter((e) => e.type === "action_start").length;
  const last = entries[entries.length - 1];
  const COLS = 8;
  const lines = entries
    .map((e, i) => {
      if (tlEditing && tlEditing.id === e.id) return `<tr class="editing"><td colspan="${COLS}">${tlEditorHtml()}</td></tr>`;
      const catchText = tripLogCatchText(e);
      const approx = tripLogIsApprox(e);
      const pos = e.lat != null && e.lng != null ? `${e.lat.toFixed(4)}, ${e.lng.toFixed(4)}` : "—";
      const cond = tripLogConditionsText(e) || (e.conditionsAt ? "—" : "pending");
      const fishedHere = durations.has(i) ? tripLogFormatDuration(durations.get(i)) : "";
      const cls = e.type === "catch" ? "catch" : e.type === "action_end" || e.type === "trip_end" ? "ends" : "";
      const byHand = e.editedAt || e.source === "Manual" ? `<span class="tl-flag">edited</span>` : "";
      return `<tr class="${cls} line">
        <td class="time">${approx ? "~" : ""}${tlEsc(tlClock(e.dateTime))}<small>${tlEsc(tripLogElapsed(startTs, e.ts))}</small></td>
        <td class="ev">${tlEsc(tripLogEventLabel(e))}${catchText ? `<div><strong>${tlEsc(catchText)}</strong></div>` : ""}${byHand}</td>
        <td>${tlEsc(e.actionName || "")}</td>
        <td>${tlEsc(tripLogWaterText(e))}</td>
        <td class="cond">${tlEsc(cond)}</td>
        <td class="num">${tlEsc(fishedHere)}</td>
        <td class="pos">${tlEsc(pos)}</td>
        <td class="act"><button type="button" class="btn-secondary tl-btn" data-edit="${tlEsc(e.id)}" aria-label="Edit this line" title="Edit this line">Edit</button></td></tr>
        ${e.rods && e.rods.length ? `<tr class="gear ${cls}"><td></td><td colspan="${COLS - 1}">${tlGearTable(e.rods)}</td></tr>` : ""}`;
    })
    .join("");
  const adding = tlEditing && tlEditing.id === null ? `<tr class="editing"><td colspan="${COLS}">${tlEditorHtml()}</td></tr>` : "";
  detail.innerHTML = `
    <div class="tl-head">
      <h3>${tlEsc(run.tripName || (entries[0] && entries[0].tripName) || "Trip")}</h3>
      ${entries.length ? `<span>${tlEsc(tripLogDateLabel(entries[0].dateTime))}, ${tlEsc(tlClock(entries[0].dateTime))} – ${tlEsc(tlClock(last.dateTime))}</span>` : ""}
      <span>${tlEsc(tripLogFormatDuration(fished) || "0 min")} fished</span>
      <span>${actions} action${actions === 1 ? "" : "s"}</span>
      <span>${catches} catch${catches === 1 ? "" : "es"}</span>
      ${tripLogFlags(run).map((f) => `<span class="tl-flag">${tlEsc(f)}</span>`).join("")}
      <button type="button" class="btn-secondary tl-btn" data-add-line style="margin-left:auto;">+ Add line</button>
    </div>
    <div class="tl-scroll"><table class="tl-table tl-lines">
      <thead><tr><th>Time</th><th>Event</th><th>Action</th><th>Water</th><th>Tide · weather</th><th class="num">Fished</th><th>Position</th><th></th></tr></thead>
      <tbody>${lines}${adding}</tbody></table></div>`;
}

// --- The line editor ---------------------------------------------------------------------------------------------------

async function tlEnsureLists() {
  if (tlLists) return tlLists;
  const get = async (path) => {
    try {
      const res = await fetch(`${USER_BACKEND_URL}${path}`, { cache: "no-store", credentials: "include" });
      return res.ok ? await res.json() : [];
    } catch {
      return [];
    }
  };
  const [pub, own, rodSetups, overrides] = await Promise.all([get("/api/marklists?userId=public"), get("/api/marklists"), get("/api/rodsetups"), get("/api/rig-sublist-overrides")]);
  const merged = new Map();
  for (const row of pub) merged.set(`${row.field}|${row.value}`, row);
  for (const row of own) merged.set(`${row.field}|${row.value}`, row); // your own wins on a clash
  const rows = [...merged.values()];
  const byField = (field) => rows.filter((r) => r.field === field);
  tlLists = {
    rows, rodSetups,
    values: (field) => byField(field).map((r) => r.value).sort((a, b) => a.localeCompare(b)),
    rowFor: (field, value) => byField(field).find((r) => r.value === value) || null,
    overrides: new Map((overrides || []).map((r) => [r.rigId, r.subList])),
  };
  return tlLists;
}

/** The editor's starting values for a line (or a new one, after the last line). */
function tlFormFromEntry(e) {
  const dt = String(e.dateTime || "");
  const s = (v) => (v == null ? "" : String(v));
  return {
    date: dt.slice(0, 10), time: dt.slice(11, 19), type: e.type || "change", changeField: s(e.changeField), actionName: s(e.actionName),
    waterCondition: s(e.waterCondition), waterDepth: s(e.waterDepth), tideCondition: s(e.tideCondition), tideExtreme: s(e.tideExtreme), weatherCondition: s(e.weatherCondition),
    windSpeed: s(e.windSpeed), windDirection: s(e.windDirection), temperature: s(e.temperature), barometer: s(e.barometer), waterTemperature: s(e.waterTemperature),
    berley: s(e.berley), fishingMethod: [...(e.fishingMethod || [])], targets: [...(e.targets || [])], species: s(e.species), size: s(e.size), released: !!e.released,
    lat: s(e.lat), lng: s(e.lng),
    rods: (e.rods || []).map((r) => ({ rodSetupId: s(r.rodSetupId), name: s(r.name), rod: s(r.rod), rig: s(r.rig), rigOptions: [...(r.rigOptions || [])], bait: [...(r.bait || [])], baitOptions: [...(r.baitOptions || [])] })),
  };
}

const tlSelect = (attrs, options, value, blank = true) =>
  `<select ${attrs}>${blank ? `<option value=""></option>` : ""}${tripLogChoices(options, value).map((o) => `<option value="${tlEsc(o)}"${o === value ? " selected" : ""}>${tlEsc(o)}</option>`).join("")}</select>`;

/** The Rod Setup pick: your setups by name (value = id); a setup that has since been deleted still shows under its logged name. */
function tlSetupSelect(row) {
  const setups = tlLists ? tlLists.rodSetups : [];
  const known = setups.some((s) => s.id === row.rodSetupId);
  const options = setups.map((s) => `<option value="${tlEsc(s.id)}"${s.id === row.rodSetupId ? " selected" : ""}>${tlEsc(s.name)}</option>`);
  if (row.rodSetupId && !known) options.push(`<option value="${tlEsc(row.rodSetupId)}" selected>${tlEsc(row.name || row.rodSetupId)}</option>`);
  return `<select data-r="rodSetupId"><option value="">(none)</option>${options.join("")}</select>`;
}

const tlChips = (attrs, options, selected) =>
  `<div class="tl-chips" ${attrs}>${tripLogChoices(options, selected).map((o) => `<button type="button" class="tl-chip" data-v="${tlEsc(o)}" aria-pressed="${selected.includes(o)}">${tlEsc(o)}</button>`).join("") || `<span class="tl-none">none to choose</span>`}</div>`;

const tlField = (label, html) => `<label class="tl-field"><span>${tlEsc(label)}</span>${html}</label>`;
const tlInput = (name, value, type = "text", extra = "") => `<input type="${type}" data-f="${name}" value="${tlEsc(value)}" ${extra}>`;

function tlEditorHtml() {
  const f = tlEditing.form;
  const L = tlLists;
  const vals = (field) => (L ? L.values(field) : []);
  const typeOptions = TRIP_LOG_EVENT_TYPES.map((t) => `<option value="${t}"${t === f.type ? " selected" : ""}>${tlEsc(tripLogEventLabel({ type: t }))}</option>`).join("");
  const rods = f.rods
    .map((r, i) => {
      const rigRow = L ? L.rowFor("Rig", r.rig) : null;
      const baitOptions = L ? [...new Set(r.bait.flatMap((b) => tripLogSublist(L.rowFor("Bait", b), L.overrides)))] : [];
      return `<tr data-rod="${i}">
        <td>${tlSetupSelect(r)}</td>
        <td>${tlSelect('data-r="rod"', vals("Rod"), r.rod)}</td>
        <td>${tlSelect('data-r="rig"', vals("Rig"), r.rig)}</td>
        <td>${tlChips('data-rc="rigOptions"', tripLogSublist(rigRow, L && L.overrides), r.rigOptions)}</td>
        <td>${tlChips('data-rc="bait"', vals("Bait"), r.bait)}</td>
        <td>${tlChips('data-rc="baitOptions"', baitOptions, r.baitOptions)}</td>
        <td><button type="button" class="btn-secondary tl-btn" data-rod-remove="${i}" aria-label="Remove this rod">×</button></td></tr>`;
    })
    .join("");
  return `<div class="tl-editor" data-editor>
    <div class="tl-grid">
      ${tlField("Date", tlInput("date", f.date, "date"))}
      ${tlField("Time", tlInput("time", f.time, "time", 'step="1"'))}
      ${tlField("Event", `<select data-f="type">${typeOptions}</select>`)}
      ${f.type === "change" ? tlField("What changed", tlSelect('data-f="changeField"', TRIP_LOG_CHANGE_FIELDS, f.changeField)) : ""}
      ${tlField("Action", tlInput("actionName", f.actionName))}
      ${tlField("Water", tlSelect('data-f="waterCondition"', vals("Water Condition"), f.waterCondition))}
      ${tlField("Depth (m)", tlInput("waterDepth", f.waterDepth, "number", 'step="0.1" min="0"'))}
      ${tlField("Tide", tlSelect('data-f="tideCondition"', vals("Tide Condition"), f.tideCondition))}
      ${tlField("Tide extreme", tlSelect('data-f="tideExtreme"', TRIP_LOG_TIDE_EXTREMES, f.tideExtreme))}
      ${tlField("Weather", tlSelect('data-f="weatherCondition"', vals("Weather Condition"), f.weatherCondition))}
      ${tlField("Wind (km/h)", tlInput("windSpeed", f.windSpeed, "number", 'step="1" min="0"'))}
      ${tlField("Wind direction", tlSelect('data-f="windDirection"', TL_COMPASS, f.windDirection))}
      ${tlField("Air temp (°C)", tlInput("temperature", f.temperature, "number", 'step="0.1"'))}
      ${tlField("Pressure (hPa)", tlInput("barometer", f.barometer, "number", 'step="0.1"'))}
      ${tlField("Water temp (°C)", tlInput("waterTemperature", f.waterTemperature, "number", 'step="0.1"'))}
      ${tlField("Berley", tlSelect('data-f="berley"', vals("Berley"), f.berley))}
      ${tlField("Latitude", tlInput("lat", f.lat, "number", 'step="0.00001"'))}
      ${tlField("Longitude", tlInput("lng", f.lng, "number", 'step="0.00001"'))}
      ${f.type === "catch" ? tlField("Species", tlSelect('data-f="species"', vals("Species"), f.species)) : ""}
      ${f.type === "catch" ? tlField("Size (cm)", tlInput("size", f.size, "number", 'step="1" min="0"')) : ""}
      ${f.type === "catch" ? tlField("Released", `<input type="checkbox" data-f="released"${f.released ? " checked" : ""}>`) : ""}
    </div>
    <div class="tl-field-wide"><span>Fishing method</span>${tlChips('data-fc="fishingMethod"', vals("Fishing Method"), f.fishingMethod)}</div>
    <div class="tl-field-wide"><span>Targets</span>${tlChips('data-fc="targets"', vals("Species"), f.targets)}</div>
    <div class="tl-field-wide"><span>Rod setups in force</span>
      <div class="tl-scroll"><table class="tl-table tl-rods-edit"><thead><tr><th>Rod setup</th><th>Rod</th><th>Rig</th><th>Rig options</th><th>Bait</th><th>Bait options</th><th></th></tr></thead><tbody>${rods}</tbody></table></div>
      <button type="button" class="btn-secondary tl-btn" data-rod-add>+ Add rod</button>
    </div>
    <div class="tl-editor-actions">
      <button type="button" class="btn-primary tl-btn" data-save>Save</button>
      <button type="button" class="btn-secondary tl-btn" data-cancel>Cancel</button>
      ${tlEditing.id ? `<button type="button" class="btn-secondary tl-btn tl-danger" data-delete>Delete line</button>` : ""}
      <span class="tl-error" data-error role="alert"></span>
    </div>
  </div>`;
}

/** Copies what is typed / chosen in the open editor into tlEditing.form (before any re-draw or save). */
function tlReadEditor() {
  const box = document.querySelector("[data-editor]");
  if (!box || !tlEditing) return;
  const f = tlEditing.form;
  box.querySelectorAll("[data-f]").forEach((el) => {
    f[el.dataset.f] = el.type === "checkbox" ? el.checked : el.value;
  });
  box.querySelectorAll("[data-fc]").forEach((g) => {
    f[g.dataset.fc] = [...g.querySelectorAll('.tl-chip[aria-pressed="true"]')].map((c) => c.dataset.v);
  });
  f.rods = [...box.querySelectorAll("tr[data-rod]")].map((tr, i) => {
    const r = { ...(f.rods[i] || {}) };
    tr.querySelectorAll("[data-r]").forEach((el) => (r[el.dataset.r] = el.value));
    tr.querySelectorAll("[data-rc]").forEach((g) => (r[g.dataset.rc] = [...g.querySelectorAll('.tl-chip[aria-pressed="true"]')].map((c) => c.dataset.v)));
    return r;
  });
}

async function tlOpenEditor(id) {
  if (tlEditing && !confirm("Discard the line you are editing?")) return;
  await tlEnsureLists();
  if (id) {
    const entry = tlEntries.find((e) => e.id === id);
    if (!entry) return;
    tlEditing = { id, form: tlFormFromEntry(entry) };
  } else {
    // a new line starts at the last line's time, as a change (the most common thing to add)
    const last = tlEntries[tlEntries.length - 1] || {};
    tlEditing = { id: null, form: tlFormFromEntry({ type: "change", dateTime: last.dateTime || "", waterCondition: last.waterCondition, waterDepth: last.waterDepth, actionName: last.actionName, rods: last.rods }) };
  }
  tlRenderDetail();
  const box = document.querySelector("[data-editor]");
  if (box) box.scrollIntoView({ block: "nearest" });
}

async function tlSave() {
  tlReadEditor();
  const errorEl = document.querySelector("[data-error]");
  const { body, error } = tripLogBuildPatch(tlEditing.form);
  if (error) {
    errorEl.textContent = error;
    return;
  }
  const buttons = document.querySelectorAll("[data-editor] button");
  buttons.forEach((b) => (b.disabled = true));
  try {
    if (tlEditing.id) await tlSend("PATCH", `/api/triplog/${encodeURIComponent(tlEditing.id)}`, body);
    else await tlSend("POST", "/api/triplog/lines", { ...body, runId: tlSelectedRunId });
    await tlReloadAfterChange();
  } catch (err) {
    errorEl.textContent = `Couldn't save: ${err.message}`;
    buttons.forEach((b) => (b.disabled = false));
  }
}

async function tlDelete() {
  if (!tlEditing || !tlEditing.id || !confirm("Delete this line from the trip log? It is removed for good after 30 days.")) return;
  try {
    await tlSend("DELETE", `/api/triplog/${encodeURIComponent(tlEditing.id)}`);
    await tlReloadAfterChange();
  } catch (err) {
    document.querySelector("[data-error]").textContent = `Couldn't delete: ${err.message}`;
  }
}

/** Drops chosen bait options that the chosen baits no longer offer. */
function tlPruneRodOptions() {
  if (!tlLists) return;
  for (const r of tlEditing.form.rods) {
    const valid = new Set(r.bait.flatMap((b) => tripLogSublist(tlLists.rowFor("Bait", b), tlLists.overrides)));
    r.baitOptions = r.baitOptions.filter((o) => valid.has(o));
  }
}

/** Clicks and changes inside the lines card: open / save / cancel / delete, chips, rod rows, and the pick-lists that depend on each other. */
function tlWireDetail() {
  const detail = document.getElementById("tlDetail");
  detail.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.edit) return void tlOpenEditor(t.dataset.edit);
    if (t.hasAttribute("data-add-line")) return void tlOpenEditor(null);
    if (!tlEditing) return;
    if (t.classList.contains("tl-chip")) {
      t.setAttribute("aria-pressed", String(t.getAttribute("aria-pressed") !== "true"));
      const group = t.closest("[data-rc]");
      if (group && group.dataset.rc === "bait") {
        tlReadEditor();
        tlPruneRodOptions();
        tlRenderDetail(); // the Bait options on offer follow the chosen baits
      }
      return;
    }
    if (t.hasAttribute("data-save")) return void tlSave();
    if (t.hasAttribute("data-cancel")) {
      tlEditing = null;
      return void tlRenderDetail();
    }
    if (t.hasAttribute("data-delete")) return void tlDelete();
    if (t.hasAttribute("data-rod-add")) {
      tlReadEditor();
      tlEditing.form.rods.push(tripLogRodFromSetup(null));
      return tlRenderDetail();
    }
    if (t.dataset.rodRemove !== undefined) {
      tlReadEditor();
      tlEditing.form.rods.splice(Number(t.dataset.rodRemove), 1);
      return tlRenderDetail();
    }
  });
  detail.addEventListener("change", (e) => {
    if (!tlEditing) return;
    const el = e.target;
    if (el.dataset.f === "type") {
      tlReadEditor();
      return tlRenderDetail(); // catch-only and change-only fields come and go
    }
    if (el.dataset.r) {
      const index = Number(el.closest("tr[data-rod]").dataset.rod);
      tlReadEditor();
      if (el.dataset.r === "rodSetupId") {
        const setup = tlLists.rodSetups.find((s) => s.id === el.value);
        if (setup) tlEditing.form.rods[index] = tripLogRodFromSetup(setup); // picking a Rod Setup fills the whole row
      } else if (el.dataset.r === "rig") {
        tlEditing.form.rods[index].rigOptions = []; // the options belong to the rig
      }
      tlPruneRodOptions();
      tlRenderDetail();
    }
  });
}

// --- Page ------------------------------------------------------------------------------------------------------------

/** #run=<id> or #mark=<id> from the address: the run to open (a mark is resolved to its run by the Worker, which also sends the lines). */
async function tlOpenFromHash() {
  const m = /^#(run|mark)=(.+)$/.exec(location.hash || "");
  if (!m) return false;
  const value = decodeURIComponent(m[2]);
  if (m[1] === "run") {
    if (!tlRuns.some((r) => r.runId === value)) return false;
    await tlSelectRun(value);
    return true;
  }
  try {
    const data = await tlGet(`markId=${encodeURIComponent(value)}`);
    if (!data.runId) return false;
    if (!tlRuns.some((r) => r.runId === data.runId)) {
      // the filters hide it: show everything
      document.getElementById("tlTripFilter").value = "";
      document.getElementById("tlFrom").value = "";
      document.getElementById("tlTo").value = "";
      await tlLoadRuns();
    }
    await tlSelectRun(data.runId, data);
    document.getElementById("tlDetailCard").scrollIntoView({ block: "start" });
    return true;
  } catch {
    return false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const gate = document.getElementById("tlNotConnected");
  const main = document.getElementById("tlMain");
  await refreshAdminStatus();
  if (!cachedIsSignedIn) {
    gate.style.display = "block";
    main.style.display = "none";
    return;
  }
  gate.style.display = "none";
  main.style.display = "block";
  tlWireDetail();

  await tlLoadRuns();
  if (!(await tlOpenFromHash()) && tlVisibleRuns().length) await tlSelectRun(tlVisibleRuns()[0].runId);

  const refilter = async () => {
    await tlLoadRuns();
    const visible = tlVisibleRuns();
    if (visible.length && !visible.some((r) => r.runId === tlSelectedRunId)) await tlSelectRun(visible[0].runId);
  };
  document.getElementById("tlFrom").addEventListener("change", refilter);
  document.getElementById("tlTo").addEventListener("change", refilter);
  document.getElementById("tlTripFilter").addEventListener("change", async () => {
    tlRenderRuns();
    const visible = tlVisibleRuns();
    if (visible.length && !visible.some((r) => r.runId === tlSelectedRunId)) await tlSelectRun(visible[0].runId);
  });
  document.getElementById("tlClear").addEventListener("click", async () => {
    document.getElementById("tlTripFilter").value = "";
    document.getElementById("tlFrom").value = "";
    document.getElementById("tlTo").value = "";
    await refilter();
  });
  window.addEventListener("hashchange", tlOpenFromHash);
});
