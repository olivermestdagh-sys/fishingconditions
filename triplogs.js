// Trip Logs tab: trips (headers) at the top, the selected trip's log lines underneath. Reads the trip log the Worker keeps in D1
// (user-backend.js "Trip log": GET /api/triplog?list=1 for the headers, ?runId= / ?markId= for a trip's lines). Pure formatting
// helpers are in js/trip-log-view.js. Deep links: triplogs.html#run=<runId> and #mark=<markId> (a trip mark's "Trip log" button).

let tlRuns = []; // every header the filters let through, newest first
let tlSelectedRunId = null;
let tlLoadToken = 0; // a slow answer for a trip that is no longer selected is dropped

async function tlGet(query) {
  const res = await fetch(`${USER_BACKEND_URL}/api/triplog?${query}`, { cache: "no-store", credentials: "include" });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
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
    <thead><tr><th>Date</th><th>Trip</th><th>Start – end</th><th class="num">Duration</th><th class="num">Fished</th><th class="num">Actions</th><th class="num">Catches</th><th></th></tr></thead>
    <tbody>${runs
      .map((r) => {
        const flags = tripLogFlags(r).map((f) => `<span class="tl-flag">${tlEsc(f)}</span>`).join("");
        return `<tr tabindex="0" data-run="${tlEsc(r.runId)}" class="${r.runId === tlSelectedRunId ? "selected" : ""}" aria-selected="${r.runId === tlSelectedRunId}">
          <td>${tlEsc(tripLogDateLabel(r.startDateTime))}</td><td>${tlEsc(r.tripName || "—")}</td>
          <td>${tlEsc(tlClock(r.startDateTime))} – ${r.hasTripEnd || r.endTs > r.startTs ? tlEsc(tlClock(r.endDateTime)) : "…"}</td>
          <td class="num">${tlEsc(tripLogFormatDuration(r.endTs - r.startTs))}</td><td class="num">${tlEsc(tripLogFormatDuration(r.fishedMs))}</td>
          <td class="num">${r.actions}</td><td class="num">${r.catches}</td><td>${flags}</td></tr>`;
      })
      .join("")}</tbody></table>`;
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
  tlRenderDetail(runId, data.entries || []);
}

function tlRenderDetail(runId, entries) {
  const detail = document.getElementById("tlDetail");
  const run = tlRuns.find((r) => r.runId === runId) || {};
  if (!entries.length) {
    detail.innerHTML = `<div class="tl-empty">This trip has no log lines.</div>`;
    return;
  }
  const startTs = entries[0].ts;
  const durations = tripLogDurations(entries);
  const fished = [...durations.values()].reduce((a, b) => a + b, 0);
  const catches = entries.filter((e) => e.type === "catch").length;
  const last = entries[entries.length - 1];
  const rows = entries
    .map((e, i) => {
      const gear = (e.rods || []).map((r) => `<div title="${tlEsc(tripLogGearTitle(r))}">${tlEsc(tripLogGearLine(r))}</div>`).join("");
      const catchText = tripLogCatchText(e);
      const approx = tripLogIsApprox(e);
      const pos = e.lat != null && e.lng != null ? `${e.lat.toFixed(4)}, ${e.lng.toFixed(4)}` : "—";
      const cond = tripLogConditionsText(e) || (e.conditionsAt ? "—" : "pending");
      const fishedHere = durations.has(i) ? tripLogFormatDuration(durations.get(i)) : "";
      const cls = e.type === "catch" ? "catch" : e.type === "action_end" || e.type === "trip_end" ? "ends" : "";
      return `<tr class="${cls}">
        <td class="time">${approx ? "~" : ""}${tlEsc(tlClock(e.dateTime))}<small>${tlEsc(tripLogElapsed(startTs, e.ts))}</small></td>
        <td class="ev">${tlEsc(tripLogEventLabel(e))}${catchText ? `<div><strong>${tlEsc(catchText)}</strong></div>` : ""}</td>
        <td>${tlEsc(e.actionName || "")}</td>
        <td class="tl-gear">${gear}</td>
        <td>${tlEsc(tripLogWaterText(e))}</td>
        <td class="cond">${tlEsc(cond)}</td>
        <td class="num">${tlEsc(fishedHere)}</td>
        <td class="pos">${tlEsc(pos)}</td></tr>`;
    })
    .join("");
  detail.innerHTML = `
    <div class="tl-head">
      <h3>${tlEsc(run.tripName || entries[0].tripName || "Trip")}</h3>
      <span>${tlEsc(tripLogDateLabel(entries[0].dateTime))}, ${tlEsc(tlClock(entries[0].dateTime))} – ${tlEsc(tlClock(last.dateTime))}</span>
      <span>${tlEsc(tripLogFormatDuration(fished) || "0 min")} fished</span>
      <span>${entries.filter((e) => e.type === "action_start").length} action${entries.filter((e) => e.type === "action_start").length === 1 ? "" : "s"}</span>
      <span>${catches} catch${catches === 1 ? "" : "es"}</span>
      ${tripLogFlags(run).map((f) => `<span class="tl-flag">${tlEsc(f)}</span>`).join("")}
    </div>
    <div class="tl-scroll"><table class="tl-table tl-lines">
      <thead><tr><th>Time</th><th>Event</th><th>Action</th><th>Gear</th><th>Water</th><th>Tide · weather</th><th class="num">Fished</th><th>Position</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
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
