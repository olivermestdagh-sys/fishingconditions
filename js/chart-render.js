// chart-render.js
// Drawing the conditions graph: tide offsets and live location config (mergeLiveLocationConfig), the stale-data stamp, and the Chart.js plugins and renderConditionsChart used by Location, Live and Week Ahead.
// One of the shared scripts split out of the old charts.js. All of them share one global scope; each page loads
// only the ones it needs, in this order (checked by scripts/check-page-scripts.mjs).

/**
 * Fetches config/locations.json (the fast, directly-editable admin-side
 * file — NOT the slow WillyWeather-derived conditions.json every page
 * already loads) purely to pick up each location's tideOffset, and
 * merges it onto the matching entries in allLocations by name. This is
 * what makes a changed tide offset take effect on the next page load
 * instead of needing "Save & refresh data now" (which re-fetches from
 * WillyWeather and can take several minutes) — every OTHER per-location
 * setting still needs that full refresh, but the tide offset specifically
 * doesn't depend on anything WillyWeather-fetched changing, only on
 * which point of the already-fetched curve gets sampled at render time.
 * Fails silently (locations simply keep whatever tideOffset they already
 * had, i.e. none) if the fetch fails for any reason — best-effort, not
 * something that should block the page from rendering at all.
 */
async function loadTideOffsets(allLocations) {
  // UPDATE: now overlays ALL location config (display name, groups, timings,
  // tide offset, ...) live from D1 via /api/public/locations, not just
  // tideOffset from the static file — so a Settings edit shows on the next
  // page load without the WillyWeather job. Falls back to the file-based
  // behaviour below if the endpoint is unreachable.
  if (await mergeLiveLocationConfig(allLocations)) return;
  try {
    // A cache-busting query parameter, not just {cache:"no-store"} — that
    // option only tells THIS BROWSER not to use its own local cache; it
    // does nothing about GitHub Pages' own CDN, which can keep serving an
    // already-cached copy of this file for a while after it changes
    // regardless of what the request asks for (confirmed directly on this
    // site before: config/locations.json's neighbor charts.js was served
    // with Cache-Control: max-age=600 — a full 10-minute window). Appending
    // a query string makes every request a genuinely distinct URL as far
    // as the CDN's cache is concerned, so it always has to fetch fresh
    // from origin — the same fix already used elsewhere on this site for
    // this exact class of problem (see the Tide Offset per-row field's
    // own frontend-interpolation notes).
    const res = await fetch(`config/locations.json?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const configLocations = await res.json();
    const offsetByName = new Map(configLocations.map((l) => [l.name, l.tideOffset]));
    for (const loc of allLocations) {
      if (offsetByName.has(loc.name)) loc.tideOffset = offsetByName.get(loc.name);
    }
  } catch (err) {
    console.error("Could not load tide offsets from config/locations.json:", err);
  }
}

/**
 * Sets the header's "Updated ..." stamp from the data file's generatedAt.
 * If the data is more than STALE_DATA_HOURS old (the update job runs every
 * 3 hours, so this means it has been failing or paused) the stamp turns
 * amber and says how old it is, instead of quietly showing an old date.
 */
const STALE_DATA_HOURS = 12;
function setUpdatedStamp(el, dt) {
  if (!el) return;
  const when = dt.toLocaleString([], { dateStyle: "medium", timeStyle: "short", hour12: false });
  const ageHours = (Date.now() - dt.getTime()) / 3600000;
  if (ageHours > STALE_DATA_HOURS) {
    const age = ageHours >= 48 ? `${Math.floor(ageHours / 24)} days` : `${Math.floor(ageHours)} h`;
    el.textContent = `⚠ Data is ${age} old · ${when}`;
    el.classList.add("stale");
    el.title = `The data hasn't refreshed for over ${STALE_DATA_HOURS} hours — the update job may be failing.`;
  } else {
    el.textContent = `Updated ${when}`;
    el.classList.remove("stale");
    el.removeAttribute("title");
  }
}

/**
 * Merges location config from D1 (GET /api/public/locations) onto the
 * locations loaded from data/conditions.json: shared fields by name, and
 * per-type timing fields by name + type. Only overwrites fields the
 * endpoint actually returned, and never touches WillyWeather-derived
 * rows. Returns true on success, false if the caller should fall back.
 */
/**
 * Overlays the signed-in person's own timings onto locations they don't own: anyone can keep their own Set up / Pack
 * up / Time to Spot / Time From Spot / minimum tide height for a location they can see (the Map's location editor,
 * "My times" — js/location-editor.js), stored as their own entry for it. Their own locations already carry their
 * own values. Matched by the location's search name and type name. Best-effort: signed out or offline, the owner's
 * values stay.
 */
async function applyMyLocationTimings(allLocations) {
  if (typeof cachedIsSignedIn === "undefined" || !cachedIsSignedIn) return;
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/tracked-locations`, { credentials: "include" });
    if (!res.ok) return;
    const mine = (await res.json()).filter((r) => r.location.createdByUserId !== cachedUserId);
    const PER_TYPE = ["setUp", "packUp", "timeToSpot", "timeFromSpot", "minTideHeight"];
    for (const row of mine) {
      for (const loc of allLocations) {
        if (loc.name !== row.location.name || loc.type !== row.type.name) continue;
        for (const f of PER_TYPE) loc[f] = row[f];
        loc.myTimings = true;
      }
    }
  } catch (err) {
    console.error("Could not load your own location timings:", err);
  }
}

async function mergeLiveLocationConfig(allLocations) {
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/public/locations?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return false;
    const live = await res.json();
    if (!Array.isArray(live)) return false;
    const byName = new Map(live.map((l) => [l.name, l]));
    const SHARED = ["ownerId", "displayName", "shore", "tidal", "locationGroup", "locationGroups", "tideOffset", "tideMaxObserved", "lat", "lng"];
    const PER_TYPE = ["driveTo", "driveBack", "setUp", "packUp", "timeToSpot", "timeFromSpot", "minTideHeight"];
    for (const loc of allLocations) {
      const src = byName.get(loc.name);
      if (!src) continue;
      for (const f of SHARED) if (src[f] !== undefined && src[f] !== null) loc[f] = src[f];
      loc.tideOffset = src.tideOffset; // null is meaningful here (offset cleared)
      const t = (src.types || []).find((x) => x.type === loc.type);
      if (t) for (const f of PER_TYPE) if (t[f] !== undefined) loc[f] = t[f];
    }
    return true;
  } catch (err) {
    console.error("Could not load live location config:", err);
    return false;
  }
}

function interpolatedTideHeightAt(sortedTideRows, targetMs) {
  if (sortedTideRows.length === 0) return null;
  const first = sortedTideRows[0];
  if (targetMs <= first._t) return first["Tide Height (m)"];
  const last = sortedTideRows[sortedTideRows.length - 1];
  if (targetMs >= last._t) return last["Tide Height (m)"];
  for (let i = 0; i < sortedTideRows.length - 1; i++) {
    const a = sortedTideRows[i];
    const b = sortedTideRows[i + 1];
    if (a._t <= targetMs && targetMs <= b._t) {
      const frac = (targetMs - a._t) / (b._t - a._t);
      const eased = (1 - Math.cos(frac * Math.PI)) / 2;
      const av = a["Tide Height (m)"];
      const bv = b["Tide Height (m)"];
      return av + (bv - av) * eased;
    }
  }
  return null;
}

/**
 * Applies a location's tide offset dynamically, at render time — no data
 * refresh needed, unlike every other per-location setting on this site.
 * Returns a new rows array (the original is never mutated) with
 * "Tide Height (m)" on every row replaced by its value from
 * offsetMinutes earlier/later in that SAME location's own original curve
 * — e.g. offsetMinutes=15 means "this location's tide runs 15 minutes
 * later than the matched station's", so what's shown for it at real time
 * T is actually the station's own reading from T-15min. Only touches
 * "Tide Height (m)" — everything downstream that reads it (the drawn
 * curve, findTideExtrema's high/low labels, findTideThresholdCrossings'
 * ramp-access times) picks up the shift automatically as a result, since
 * they all read this same field from whatever rows they're given, with
 * no separate code path of their own to update. "Tide Status" (the
 * Incoming/Outgoing/High/Low label) and the Location/Fishing Condition
 * SCORES are deliberately NOT touched here — those are computed
 * server-side from the tide timing at fetch time, so they only reflect a
 * changed offset after an actual data refresh; recomputing them
 * client-side would mean reimplementing real scoring logic in JS and
 * risking it drifting out of sync with the Python original.
 */
function applyTideOffsetToRows(rows, offsetMinutes) {
  if (!offsetMinutes) return rows;
  const tideRows = rows
    .filter((r) => r["Tide Height (m)"] != null)
    .slice()
    .sort((a, b) => a._t - b._t);
  if (tideRows.length === 0) return rows;
  const offsetMs = offsetMinutes * 60000;
  return rows.map((r) => {
    if (r["Tide Height (m)"] == null) return r;
    const shifted = interpolatedTideHeightAt(tideRows, r._t - offsetMs);
    return shifted == null ? r : { ...r, "Tide Height (m)": shifted };
  });
}

function findTideExtrema(rows) {
  const tideRows = rows
    .filter((r) => r["Tide Height (m)"] != null)
    .slice()
    .sort((a, b) => a._t - b._t);

  const extrema = [];
  for (let i = 1; i < tideRows.length - 1; i++) {
    const prev = tideRows[i - 1]["Tide Height (m)"];
    const curr = tideRows[i]["Tide Height (m)"];
    const next = tideRows[i + 1]["Tide Height (m)"];
    const isHigh = curr > prev && curr >= next;
    const isLow = curr < prev && curr <= next;
    if (!isHigh && !isLow) continue;

    const denom = prev - 2 * curr + next;
    let offsetFraction = 0;
    if (denom !== 0) {
      offsetFraction = (prev - next) / (2 * denom);
      // Clamped defensively — a smooth, well-behaved curve keeps the true
      // vertex within half a sample of the middle point by construction;
      // this just guards against a degenerate/noisy denom (near-zero)
      // producing something wild.
      offsetFraction = Math.max(-0.5, Math.min(0.5, offsetFraction));
    }
    const spacingMs = (tideRows[i + 1]._t - tideRows[i - 1]._t) / 2 || 3600000;
    const interpolatedT = tideRows[i]._t + offsetFraction * spacingMs;

    extrema.push({ t: interpolatedT, height: curr, type: isHigh ? "high" : "low" });
  }
  return extrema;
}

/**
 * Labels each high/low tide directly on the tide curve — a small dot at
 * the peak/trough plus its time, in the tide line's own color, so reading
 * "when's the next high tide" doesn't require hovering for a tooltip.
 * Applies universally, everywhere renderConditionsChart is used, same as
 * buildTooltipCrosshairPlugin below.
 */
function buildTideExtremaPlugin(rows) {
  const extrema = findTideExtrema(rows);
  return {
    id: "tideExtrema",
    afterDatasetsDraw(chart) {
      if (extrema.length === 0) return;
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x || !scales.yTide) return;
      const xScale = scales.x;
      const yScale = scales.yTide;
      const { left, right } = chartArea;
      ctx.save();
      ctx.font = "700 9px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#4f46e5";
      for (const ex of extrema) {
        const x = xScale.getPixelForValue(ex.t);
        if (x < left || x > right) continue; // outside this chart's own visible range
        const y = yScale.getPixelForValue(ex.height);
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.textBaseline = ex.type === "high" ? "bottom" : "top";
        ctx.fillText(fmtChartTick(ex.t), x, ex.type === "high" ? y - 5 : y + 5);
      }
      ctx.restore();
    },
  };
}

/**
 * One glyph per point that has a real Swell Period reading — added on
 * request, once Oliver enabled the Swell Height/Period forecast types on
 * the WillyWeather API key (build_readings, fetch_conditions.py). A
 * filled circle, positioned at a y matching that point's own Swell
 * Height (mirroring how buildTideExtremaPlugin, just above, positions
 * its own dots at a real tide height rather than a fixed row — the
 * y-position itself carries real information, not just a marker lane),
 * with the swell period drawn upright inside it.
 *
 * When a direction reading exists, a small triangular pointer sits on
 * the circle's own edge facing the swell's travel direction — the same
 * "from" + 180° convention dirToArrowRotation (above) already uses for
 * the wind arrows on this same chart, so both read the same way: which
 * way it's headed, not where it came from. Oliver's own fallback for no
 * direction: no pointer at all, just the plain circle with the period
 * number — WillyWeather returns swell with no direction sometimes (their
 * own docs: null for a location with no swell data at all, but a period
 * reading can still exist with no paired direction depending on the
 * model), so this distinction is a real, not hypothetical, case.
 *
 * The period number is always its own separate fillText call, drawn
 * AFTER the pointer and never itself rotated — ctx.rotate() would carry
 * the text around with the pointer and leave it sideways or upside-down
 * at most directions, defeating the point of a number that's meant to
 * be read at a glance.
 */
/** One shared line-formatter for a row's own Swell reading, used by both
 * tooltip implementations below (Chart.js's own native afterBody, and
 * buildTooltipCrosshairPlugin's manually-drawn mirror of it, for the same
 * disableBuiltinEvents callers Condition/Fishing Condition already need
 * duplicated across both) — kept as one function specifically so the two
 * tooltips can't quietly drift out of sync with each other on the exact
 * wording later. Null whenever there's no period reading for this row,
 * matching buildSwellMarkersPlugin's own "nothing drawn without a period"
 * rule — a tooltip line for a row with no swell marker drawn on it at all
 * would be confusing, not helpful. Height and direction are each allowed
 * to be individually absent without suppressing the rest of the line —
 * WillyWeather can return a period with no paired height or direction
 * depending on the model, matching the same real-not-hypothetical
 * reasoning build_readings (fetch_conditions.py) already documents for
 * direction specifically. */
function formatSwellTooltipLine(row) {
  const period = row["Swell Period (s)"];
  if (period == null) return null;
  const height = row["Swell Height (m)"];
  const dirText = row["Swell Dir Text"];
  let text = "Swell ";
  if (height != null) text += `${height.toFixed(1)}m @ `;
  text += `${period.toFixed(1)}s`;
  if (dirText) text += ` ${dirText}`;
  return text;
}

function buildSwellMarkersPlugin(rows) {
  return {
    id: "swellMarkers",
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x || !scales.ySwell) return;
      const xScale = scales.x;
      const yScale = scales.ySwell;
      const { left, right } = chartArea;
      const radius = 10;
      ctx.save();
      ctx.font = "700 10px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const row of rows) {
        const period = row["Swell Period (s)"];
        if (period == null) continue;
        const x = xScale.getPixelForValue(row._t);
        if (x < left || x > right) continue; // outside this chart's own visible range
        const height = row["Swell Height (m)"];
        const y = yScale.getPixelForValue(height != null ? height : 0);
        const dir = row["Swell Dir"];

        if (dir != null) {
          // Pointer on the circle's own edge, facing the travel direction.
          const travelDeg = (dir + 180) % 360;
          const rad = (travelDeg * Math.PI) / 180;
          const tipX = x + Math.sin(rad) * (radius + 6);
          const tipY = y - Math.cos(rad) * (radius + 6);
          const spread = 0.42; // radians either side of the tip direction
          const baseR = radius - 1;
          ctx.beginPath();
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(x + Math.sin(rad + spread) * baseR, y - Math.cos(rad + spread) * baseR);
          ctx.lineTo(x + Math.sin(rad - spread) * baseR, y - Math.cos(rad - spread) * baseR);
          ctx.closePath();
          ctx.fillStyle = "#0e7490";
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = "#0891b2";
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = "#ffffff";
        ctx.fillText(String(Math.round(period)), x, y + 0.5);
      }
      ctx.restore();
    },
  };
}

/**
 * Marks exactly which moment (and which line's value at that moment) the
 * tooltip is currently showing — a vertical crosshair across the full
 * plot height at the tooltip's x-position, plus an enlarged, white-ringed
 * dot on every visible dataset's own point at that same position. Without
 * this, a floating tooltip box only tells you the VALUES; on a chart with
 * several overlapping lines (and, in compact mode, no axes at all to
 * cross-reference against), it's easy to lose track of which vertical
 * slice of the chart — and which specific point on each line — those
 * values actually came from.
 *
 * Applies universally, everywhere renderConditionsChart is used, and
 * regardless of how the tooltip was triggered (Chart.js's own default
 * tap/hover, or a caller manually driving it via chart.tooltip.setActiveElements
 * — see wireHoldToShowTooltip) — chart.tooltip.getActiveElements() reflects
 * the current tooltip state either way, so this doesn't need to know which
 * one is in play.
 *
 * Skips the wind datasets' own highlight dot specifically — those already
 * render a large directional arrow at every valid point (see
 * makeArrowCanvas/pointStyle below), so an additional plain circle on top
 * would just clutter an already-distinct marker rather than clarify it.
 */
function buildTooltipCrosshairPlugin(rows) {
  return {
    id: "tooltipCrosshair",
    // afterDatasetsDraw, not afterDraw — drawn after the lines/points but
    // (for pages using Chart.js's own native tooltip) still before that
    // tooltip's own afterDraw-hooked rendering, so this never paints over
    // it. Callers that manually drive the tooltip (Live, Week Ahead —
    // see disableBuiltinEvents/wireHoldToShowTooltip) disable the native
    // tooltip entirely (plugins.tooltip.enabled:false below) and rely on
    // THIS plugin to draw the whole box itself — Chart.js's own tooltip
    // rendering turned out to be unreliable when driven by an externally
    // triggered setActiveElements() rather than a genuine hover event:
    // position/size don't always get computed (confirmed directly against
    // a live chart — x/y/width/height came back undefined despite
    // getActiveElements() and opacity both being correct), in a way that
    // varied unpredictably across environments and was never fully
    // pinned down. This plugin's own drawing — same
    // "getActiveElements() + draw directly" approach as the crosshair and
    // highlighted points below, already proven reliable in every tested
    // scenario — sidesteps that whole class of problem rather than
    // continuing to fight it.
    afterDatasetsDraw(chart) {
      const active = chart.tooltip && chart.tooltip.getActiveElements ? chart.tooltip.getActiveElements() : [];
      if (!active || active.length === 0) return;
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const { top, bottom, left, right } = chartArea;
      const { datasetIndex, index } = active[0];
      const meta = chart.getDatasetMeta(datasetIndex);
      const anchorPoint = meta && meta.data && meta.data[index];
      if (!anchorPoint) return;
      const x = anchorPoint.x;

      ctx.save();
      ctx.strokeStyle = "rgba(15, 23, 42, 0.55)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.restore();

      for (const el of active) {
        const ds = chart.data.datasets[el.datasetIndex];
        if (!ds || ds.yAxisID === "yWind") continue; // already has its own big arrow marker at this point
        const dMeta = chart.getDatasetMeta(el.datasetIndex);
        if (!dMeta || dMeta.hidden) continue;
        const point = dMeta.data && dMeta.data[el.index];
        const value = ds.data && ds.data[el.index] ? ds.data[el.index].y : null;
        if (!point || value == null) continue;
        ctx.save();
        ctx.beginPath();
        ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = ds.borderColor || "#000";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
        ctx.restore();
      }

      // The tooltip box itself — only drawn when the native Chart.js
      // tooltip is disabled (disableBuiltinEvents callers: Live, Week
      // (graphs)). Everywhere else, Chart.js's own tooltip is still
      // enabled and draws its own box via the normal hover/tap path — the
      // crosshair and highlighted points above still draw universally
      // (that's the whole point of this plugin for those callers), but
      // drawing a SECOND box here too would duplicate it.
      if (!chart.options.plugins.tooltip.enabled) {
        // Mirrors the callbacks configured on Chart.js's own native
        // tooltip (title: formatted time; one line per active dataset, in
        // that dataset's own label/color; afterBody: Location/Fishing
        // Condition, drawn as strips rather than real datasets so they're
        // pulled from the row directly) — kept in sync by hand since this
        // plugin doesn't go through those callbacks at all.
        const row = rows && rows[index];
        const lines = [];
        const t = row ? row._t : (chart.data.labels && chart.data.labels[index]);
        if (t != null) {
          lines.push({ text: new Intl.DateTimeFormat([], { timeZone: "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(t)), bold: true });
        }
        for (const el of active) {
          const ds = chart.data.datasets[el.datasetIndex];
          if (!ds) continue;
          const val = ds.data[el.index] ? ds.data[el.index].y : null;
          if (val == null) continue;
          const formatted = Number.isInteger(val) ? String(val) : val.toFixed(1);
          lines.push({ text: `${ds.label}: ${formatted}`, color: ds.borderColor || "#e5e7eb" });
        }
        if (row) {
          if (row["Condition"] != null) {
            lines.push({ text: `Location ${row["Condition"].toFixed(1)}/5 — ${row["Condition Reason"] || ""}` });
          }
          if (row["Fishing Condition"] != null) {
            lines.push({ text: `Fishing ${row["Fishing Condition"].toFixed(1)}/5 — ${row["Fishing Condition Reason"] || ""}` });
          }
          const swellLine = formatSwellTooltipLine(row);
          if (swellLine) lines.push({ text: swellLine });
        }
        drawTooltipBox(ctx, chartArea, x, lines);
      }
    },
  };
}

function drawTooltipBox(ctx, chartArea, x, lines) {
  if (lines.length === 0) return;
  const { top, bottom, left, right } = chartArea;

  ctx.save();
  const fontSize = 11;
  const lineHeight = fontSize + 5;
  const padding = 8;
  let maxWidth = 0;
  for (const line of lines) {
    ctx.font = `${line.bold ? "700 " : ""}${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    maxWidth = Math.max(maxWidth, ctx.measureText(line.text).width);
  }
  const boxWidth = maxWidth + padding * 2;
  const boxHeight = lines.length * lineHeight + padding * 2;

  let boxX = x + 12;
  if (boxX + boxWidth > right) boxX = x - 12 - boxWidth;
  boxX = Math.max(left, Math.min(boxX, right - boxWidth));
  let boxY = top + 8;
  boxY = Math.max(top, Math.min(boxY, bottom - boxHeight));

  ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 6);
    ctx.fill();
  } else {
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
  }

  lines.forEach((line, i) => {
    ctx.fillStyle = line.color || "#f1f5f9";
    ctx.font = `${line.bold ? "700 " : ""}${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(line.text, boxX + padding, boxY + padding + i * lineHeight);
  });
  ctx.restore();
}

function buildNowAndThresholdPlugin(rows, minTideHeight, stopFishingTime) {
  return {
    id: "nowAndThreshold",
    // afterDatasetsDraw, not afterDraw — same reasoning as
    // buildConditionStripsPlugin above: these lines/labels span the full
    // chart height, so drawn in afterDraw they could paint over a tooltip
    // hovering anywhere near one of them. afterDatasetsDraw guarantees
    // they're drawn before the tooltip regardless of plugin registration
    // order.
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const { top, bottom, left, right } = chartArea;

      // Dotted horizontal line at the 15 km/h kayak wind threshold
      if (scales.yWind) {
        const y = scales.yWind.getPixelForValue(KAYAK_WIND_THRESHOLD_KMH);
        if (y >= top - 0.5 && y <= bottom + 0.5) {
          ctx.save();
          ctx.strokeStyle = "#dc2626";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(left, y);
          ctx.lineTo(right, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = "700 9px -apple-system, BlinkMacSystemFont, sans-serif";
          ctx.fillStyle = "#dc2626";
          ctx.textAlign = "left";
          ctx.textBaseline = "bottom";
          ctx.fillText(`${KAYAK_WIND_THRESHOLD_KMH} km/h`, left + 4, y - 2);
          ctx.restore();
        }
      }

      // Dashed horizontal line at the minimum tide height needed for boat
      // ramp access, with a marker + time label at every point the real
      // tide curve actually crosses it.
      if (scales.yTide && minTideHeight != null) {
        const y = scales.yTide.getPixelForValue(minTideHeight);
        if (y >= top - 0.5 && y <= bottom + 0.5) {
          ctx.save();
          ctx.strokeStyle = "#0891b2";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(left, y);
          ctx.lineTo(right, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = "700 9px -apple-system, BlinkMacSystemFont, sans-serif";
          ctx.fillStyle = "#0891b2";
          ctx.textAlign = "left";
          ctx.textBaseline = "bottom";
          ctx.fillText(`${minTideHeight}m ramp access`, left + 4, y - 2);
          ctx.restore();

          if (scales.x) {
            const crossings = findTideThresholdCrossings(rows, minTideHeight);
            crossings.forEach((c, idx) => {
              if (c.t < scales.x.min || c.t > scales.x.max) return;
              const x = scales.x.getPixelForValue(c.t);
              ctx.save();
              ctx.beginPath();
              ctx.arc(x, y, 3, 0, Math.PI * 2);
              ctx.fillStyle = "#0891b2";
              ctx.fill();

              // Alternate labels above/below the line so consecutive
              // crossings (a full tide cycle can have several) don't
              // overlap each other.
              const labelBelow = idx % 2 === 1;
              ctx.font = "600 9px -apple-system, BlinkMacSystemFont, sans-serif";
              ctx.fillStyle = "#0891b2";
              ctx.textAlign = "center";
              ctx.textBaseline = labelBelow ? "top" : "bottom";
              ctx.fillText(fmtChartTick(c.t), x, labelBelow ? y + 5 : y - 5);
              ctx.restore();
            });
          }
        }
      }

      // Solid vertical line at the current moment, only drawn when "now"
      // actually falls within the chart's plotted time range.
      if (scales.x) {
        const nowMs = nowInNaiveEncoding();
        if (nowMs >= scales.x.min && nowMs <= scales.x.max) {
          const x = scales.x.getPixelForValue(nowMs);
          ctx.save();
          ctx.strokeStyle = "#0f172a";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, bottom);
          ctx.stroke();
          ctx.font = "700 9px -apple-system, BlinkMacSystemFont, sans-serif";
          ctx.fillStyle = "#0f172a";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText("Now", x, top + 2);
          ctx.restore();
        }

        // Dashed vertical line at the calculated "must stop fishing by"
        // time (Live page only — the time worked back from a Home By
        // target, minus drive time, pack-up time, and the trip back to the
        // car). Only drawn when actually set and within the plotted range.
        if (stopFishingTime != null && stopFishingTime >= scales.x.min && stopFishingTime <= scales.x.max) {
          const x = scales.x.getPixelForValue(stopFishingTime);
          ctx.save();
          ctx.strokeStyle = "#b91c1c";
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, bottom);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = "700 9px -apple-system, BlinkMacSystemFont, sans-serif";
          ctx.fillStyle = "#b91c1c";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          // Offset a little below the "Now" label (also anchored at the
          // top) so the two don't collide when the lines sit close
          // together horizontally.
          ctx.fillText("Stop fishing", x, top + 13);
          ctx.restore();
        }
      }
    },
  };
}

/**
 * Traces the boundary of a moon phase's illuminated region as a closed
 * polygon, for a given illumination fraction (0=new, 1=full) and whether
 * it's waxing (growing, lit on the right) or waning (shrinking, lit on the
 * left). Verified against the shoelace formula to match the target
 * illuminated area (k * circle area) to within ~0.04% across the full
 * range of phases — this isn't an approximation of "roughly crescent
 * shaped", it's the actual geometrically correct terminator curve.
 */
function moonPhasePoints(cx, cy, r, k, waxing, steps = 40) {
  const leftEdge = [];
  const rightEdge = [];
  for (let i = 0; i <= steps; i++) {
    const y = -r + (2 * r) * (i / steps);
    const w = Math.sqrt(Math.max(0, r * r - y * y));
    let xLeft, xRight;
    if (k <= 0.5) {
      const e = (1 - 2 * k) * w;
      xLeft = waxing ? e : -w;
      xRight = waxing ? w : -e;
    } else {
      const e = (2 * k - 1) * w;
      xLeft = waxing ? -e : -w;
      xRight = waxing ? w : e;
    }
    leftEdge.push([cx + xLeft, cy + y]);
    rightEdge.push([cx + xRight, cy + y]);
  }
  return leftEdge.concat(rightEdge.reverse());
}

function drawMoonIcon(ctx, cx, cy, r, illuminationPct, waxing) {
  const k = Math.max(0, Math.min(100, illuminationPct)) / 100;

  ctx.save();

  // Dark base (the unlit portion of the disk)
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#334155";
  ctx.fill();

  // Lit region — the actual verified geometry, not a fixed 8-way lookup
  if (k > 0.002) {
    const points = moonPhasePoints(cx, cy, r, k, waxing);
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.closePath();
    ctx.fillStyle = "#fef3c7";
    ctx.fill();
  }

  // Thin outline so it reads clearly against a light chart background
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "#94a3b8";
  ctx.lineWidth = 0.75;
  ctx.stroke();

  ctx.restore();
}

function buildDayBandPlugin(rows, sunTimes, locationName, moonPhases, showDayHeading = true, showSunTimes = true, overlayHeading = false) {
  // Group rows by calendar day, tracking each day's exact start/end timestamp — bands
  // are positioned by real elapsed time (via the linear x-axis), not by row index, so
  // they're pixel-accurate regardless of how densely each day happens to be sampled.
  const dayGroups = [];
  let currentKey = null;
  for (const r of rows) {
    const key = dayKeyOf(r.dateTime);
    const t = r._t;
    if (key !== currentKey) {
      currentKey = key;
      dayGroups.push({ key, minT: t, maxT: t });
    } else {
      const g = dayGroups[dayGroups.length - 1];
      if (t < g.minT) g.minT = t;
      if (t > g.maxT) g.maxT = t;
    }
  }
  const sunByDate = new Map((sunTimes || []).map((s) => [s.date, s]));

  return {
    id: "dayBands",
    beforeDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || dayGroups.length === 0) return;
      const xScale = scales.x;
      const { top, bottom, right, left } = chartArea;

      ctx.save();
      dayGroups.forEach((g, gi) => {
        // Each day spans its own local midnight to the next day's midnight, not just
        // the range of its actual data points.
        const [y, m, d] = g.key.split("-").map(Number);
        const dayStartT = Date.UTC(y, m - 1, d); // Date.UTC month is 0-indexed; g.key's is not
        const dayEndT = dayStartT + 24 * 3600 * 1000;

        const xStart = gi === 0 ? left : xScale.getPixelForValue(dayStartT);
        const xEnd = gi + 1 < dayGroups.length ? xScale.getPixelForValue(dayEndT) : right;

        ctx.fillStyle = DAY_BAND_COLORS[gi % 2];
        ctx.fillRect(xStart, top, xEnd - xStart, bottom - top);

        const sun = sunByDate.get(g.key);
        if (sun) {
          const xFirstLight = sun.firstLight != null ? xScale.getPixelForValue(parseNaive(sun.firstLight)) : null;
          const xSunrise = sun.sunrise != null ? xScale.getPixelForValue(parseNaive(sun.sunrise)) : null;
          const xSunset = sun.sunset != null ? xScale.getPixelForValue(parseNaive(sun.sunset)) : null;
          const xLastLight = sun.lastLight != null ? xScale.getPixelForValue(parseNaive(sun.lastLight)) : null;

          if (xFirstLight != null) {
            ctx.fillStyle = NIGHT_BAND_COLOR;
            ctx.fillRect(xStart, top, xFirstLight - xStart, bottom - top);
            if (xSunrise != null) {
              ctx.fillStyle = TWILIGHT_BAND_COLOR;
              ctx.fillRect(xFirstLight, top, xSunrise - xFirstLight, bottom - top);
            }
          } else if (xSunrise != null) {
            ctx.fillStyle = NIGHT_BAND_COLOR;
            ctx.fillRect(xStart, top, xSunrise - xStart, bottom - top);
          }

          if (xLastLight != null) {
            if (xSunset != null) {
              ctx.fillStyle = TWILIGHT_BAND_COLOR;
              ctx.fillRect(xSunset, top, xLastLight - xSunset, bottom - top);
            }
            ctx.fillStyle = NIGHT_BAND_COLOR;
            ctx.fillRect(xLastLight, top, xEnd - xLastLight, bottom - top);
          } else if (xSunset != null) {
            ctx.fillStyle = NIGHT_BAND_COLOR;
            ctx.fillRect(xSunset, top, xEnd - xSunset, bottom - top);
          }

          // Explicit time labels at the actual sunrise/sunset moment — the
          // shading already marks the transition visually, but not the
          // specific time. Placed a little below the "Now"/"Stop fishing"
          // labels (which sit right at the very top) and well above the
          // condition strips (anchored to the very bottom), since both of
          // those are already using their own ends of the chart.
          //
          // Skippable via showSunTimes=false — added for Week Ahead's
          // row-per-location graphs (week.js), where the shared
          // timeline header above every row already shows sunrise/sunset
          // times once; repeating them inside each row's own (now several-
          // days-wide) chart added visual noise without new information.
          // Every other caller doesn't pass this, so defaults to true and
          // renders exactly as before.
          if (showSunTimes) {
            ctx.font = "700 8px -apple-system, BlinkMacSystemFont, sans-serif";
            ctx.fillStyle = "#b45309";
            ctx.textAlign = "center";
            if (xSunrise != null && xSunrise >= left && xSunrise <= right) {
              ctx.strokeStyle = "#b45309";
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(xSunrise, top + 24);
              ctx.lineTo(xSunrise, top + 32);
              ctx.stroke();
              ctx.textBaseline = "top";
              ctx.fillText(fmtChartTick(parseNaive(sun.sunrise)), xSunrise, top + 33);
            }
            if (xSunset != null && xSunset >= left && xSunset <= right) {
              ctx.strokeStyle = "#b45309";
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(xSunset, top + 24);
              ctx.lineTo(xSunset, top + 32);
              ctx.stroke();
              ctx.textBaseline = "top";
              ctx.fillText(fmtChartTick(parseNaive(sun.sunset)), xSunset, top + 33);
            }
          }
        }

        // Skippable via showDayHeading=false — added for Week Ahead's
        // embedded per-tile graphs (week.js), where the date (and the
        // moon phase below) are already shown once in the shared timeline
        // header above every tile, and again in the tile's own small info
        // row — repeating both a third time, per day-band, inside a chart
        // that's often only a few hundred pixels wide, is pure clutter
        // there. Every other caller (the main Conditions page, Live, the
        // old Week Ahead modal/preview) doesn't pass this, so defaults to
        // true and renders exactly as before.
        if (showDayHeading) {
          ctx.fillStyle = "#1f4e78";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";

          // Location name only on the FIRST day this chart spans — repeating
          // it for every day looks redundant once a chart covers several
          // days (which happens often now that Week Ahead's graphs span
          // sunset-to-sunrise ranges, sometimes several days for a long
          // session) — the date alone is enough context for the later days.
          const headingText = locationName && gi === 0 ? `${locationName} — ${formatDayHeading(g.key)}` : formatDayHeading(g.key);

          // Shrink the font until the text actually fits this band's width, rather
          // than risk it overflowing onto a second line or running off the edge —
          // matters more now that a location name can make this considerably longer,
          // and needs to hold up on narrow phone screens too.
          const maxTextWidth = xEnd - xStart - 8;
          let fontSize = 11;
          ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
          while (ctx.measureText(headingText).width > maxTextWidth && fontSize > 7) {
            fontSize -= 0.5;
            ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
          }

          // Shrinking has a floor (7px) — for a long location name on a
          // narrow first/last day-band (routine now that Week Ahead's graphs
          // start at a sunset/sunrise boundary, often leaving only a few
          // hours of that first day on screen), the text can still be wider
          // than the band even at the smallest allowed size. Centering it on
          // the band's own midpoint in that case pushes it straight past the
          // chart's edge, where the canvas silently clips it — invisible
          // rather than just imperfectly placed. Clamping the draw position
          // to the chart's actual left/right bounds keeps it fully visible
          // (very rare cosmetic trade-off: it can nudge toward a neighbouring
          // label) rather than partially or entirely disappearing.
          let drawX = (xStart + xEnd) / 2;
          const halfTextWidth = ctx.measureText(headingText).width / 2;
          if (drawX - halfTextWidth < left) drawX = left + halfTextWidth;
          if (drawX + halfTextWidth > right) drawX = right - halfTextWidth;

          // overlayHeading draws INSIDE the plot area, right at its top
          // edge, instead of in the reserved padding strip above it (see
          // the smaller layout.padding.top used alongside this in
          // renderConditionsChart) — the Location tab's inline preview
          // graph is the only caller that passes this, specifically to
          // reclaim that reserved space rather than leave it blank. Text
          // now sits over whatever's plotted there, so a small translucent
          // backdrop behind it keeps it legible against a crossing line
          // rather than relying on line/text colours never colliding.
          if (overlayHeading) {
            const textHeight = fontSize + 2;
            ctx.save();
            ctx.fillStyle = "rgba(255,255,255,0.78)";
            ctx.fillRect(drawX - halfTextWidth - 3, top + 1, halfTextWidth * 2 + 6, textHeight);
            ctx.restore();
            ctx.fillStyle = "#1f4e78";
            ctx.fillText(headingText, drawX, top + 2);
          } else {
            ctx.fillText(headingText, drawX, top - 16);
          }
        }

        // Moon phase, one icon per day. Custom-drawn to the exact real
        // illumination percentage, not snapped to one of 8 fixed pictures.
        // Gated on moonPhases being passed at all (not on showDayHeading) —
        // callers that want the icon suppressed simply pass moonPhases: null,
        // same as they always could. Normally drawn ABOVE the day heading
        // (needs its own reserved space — see the increased
        // layout.padding.top where this chart gets built) — but alongside
        // overlayHeading, drawn just to the right of the date text instead,
        // both sharing the same reclaimed strip at the very top of the
        // plot area rather than each needing their own.
        const moonInfo = moonPhases && moonPhases[g.key];
        if (moonInfo && moonInfo.illumination != null) {
          const waxing = moonInfo.phase ? !moonInfo.phase.startsWith("Waning") : true;
          if (overlayHeading) {
            const moonX = Math.min((xStart + xEnd) / 2 + (showDayHeading ? 46 : 0), right - 10);
            drawMoonIcon(ctx, moonX, top + 9, 7, moonInfo.illumination, waxing);
          } else {
            drawMoonIcon(ctx, (xStart + xEnd) / 2, top - 28, 9, moonInfo.illumination, waxing);
          }
        }
      });
      ctx.restore();
    },
  };
}

/**
 * Renders (or re-renders) the combined temp/wind/rain/tide chart into a canvas.
 * @param {Object} opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {Array} opts.rows - rows for a single location, each with a numeric `_t` timestamp
 * @param {Array} opts.sunTimes - that location's sun times (from data.sunTimes[locationName])
 * @param {Chart|null} opts.existingChart - a previous Chart instance to destroy, if any
 * @param {string} [opts.locationName] - if provided, prefixed onto the day heading drawn on
 *   the chart itself (e.g. "Spot A — Tue, 11 Aug"). Intended for single-day views (the Good
 *   Conditions detail panel) where combining them avoids a separate heading above the chart;
 *   omit it for multi-day views (the main Conditions page) where the location's already shown
 *   elsewhere on the page and repeating it on every day's band would just be clutter.
 * @returns {Chart|null} the new Chart instance, or null if there were no rows
 */
const HOURLY_NUMERIC_FIELDS = [
  "Temp Forecast (C)", "Temp Realtime (C)", "Rainfall Probability (%)",
  "Wind Forecast (km/h)", "Wind Realtime (km/h)", "Tide Height (m)",
  "Water Temp (C)", "Pressure (hPa)", "Condition", "Fishing Condition",
];

/**
 * Collapses rows finer than an hour (e.g. today's 10-minute realtime
 * readings) into one row per hour, averaging numeric fields. Already-hourly
 * data (forecast-only future days) passes through unchanged — a hour with
 * only one row is a no-op, so this is safe to apply universally rather than
 * needing to special-case which rows are "dense".
 */
function bucketRowsHourly(rows) {
  if (!rows || rows.length <= 1) return rows;

  const buckets = new Map();
  for (const r of rows) {
    const hourKey = Math.floor(r._t / 3600000) * 3600000;
    if (!buckets.has(hourKey)) buckets.set(hourKey, []);
    buckets.get(hourKey).push(r);
  }

  const result = [];
  for (const [hourKey, group] of buckets) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    // Non-numeric fields (direction text, Tide Status, reason strings, etc.)
    // aren't meaningfully averageable — take them from the last reading in
    // the hour as the most "current" representative value.
    const merged = { ...group[group.length - 1] };
    merged._t = hourKey;
    merged.dateTime = new Date(hourKey).toISOString().slice(0, 19);
    for (const field of HOURLY_NUMERIC_FIELDS) {
      const vals = group.map((r) => r[field]).filter((v) => v != null);
      merged[field] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    result.push(merged);
  }

  return result.sort((a, b) => a._t - b._t);
}

// Session-span highlight — Week Ahead specific (sessionFrom/sessionTo are
// only ever passed there; every other caller leaves them undefined, in
// which case this draws nothing). The graph itself is deliberately wider
// than the qualifying session (extended through a full day/night period on
// each side for context), so this marks which part of that wider view is
// actually the session: a light tint plus bracketing lines at the exact
// start/end, both in the site's established "good condition" green so
// they read as "this is the highlighted part", not as another day/night
// band or a warning threshold like the other overlay lines on this chart.
const SESSION_SPAN_COLOR = "#16a34a";

/**
 * Which icon-draw function and short label go with each of the seven
 * schedule instants computeScheduleFromDragRangeMs can produce. Order
 * here is also draw/label order (chronological through a session).
 */
const SCHEDULE_INSTANT_DISPLAY = [
  { key: "leaveHomeMs", label: "Leave", icon: drawHomeIcon, color: "#0f766e" },
  { key: "arriveMs", label: "Arrive", icon: drawCarIcon, color: "#0f766e" },
  { key: "launchMs", label: "Launch", icon: drawBoatIcon, color: "#0f766e" },
  { key: "fishAtMs", label: "Fishing", icon: drawFishIcon, color: "#0f766e" },
  { key: "headBackMs", label: "Head back", icon: drawBoatIcon, color: "#0f766e" },
  { key: "driveHomeMs", label: "Driving", icon: drawCarIcon, color: "#0f766e" },
  { key: "homeByMs", label: "Home", icon: drawHomeIcon, color: "#0f766e" },
];

// A small fixed palette so several computed sessions on the same chart stay
// visually distinguishable from each other without needing the person to
// track which color means what — it's purely "these all belong together",
// not a legend that needs decoding.
const COMPUTED_SESSION_COLORS = ["#0f766e", "#7c3aed", "#b45309", "#be123c", "#0369a1"];

/**
 * Draws each computed (drag-derived) session's schedule instants as small
 * compact flags — a tick, a tiny icon, and a HH:MM label — rather than
 * full-height dashed lines with long text labels (buildSessionSpanPlugin
 * above). Kept deliberately lightweight since a single session already has
 * up to seven of these, and more than one computed session can be showing
 * on the same row at once (that's the whole point — comparing options).
 * A record with a field that's null (see computeScheduleFromDragRangeMs —
 * happens when live drive time genuinely couldn't be resolved) just skips
 * that one flag rather than showing a wrong or placeholder time.
 *
 * Labels are collision-avoided: gathered across EVERY record together
 * (not per-record in isolation — two different computed sessions with
 * markers close in time need to avoid each other just as much as two
 * instants within the same session do), sorted chronologically, then
 * swept left-to-right assigning each one the shallowest vertical "tier"
 * that doesn't collide with whatever's already been placed at that tier.
 * A tick mark's length grows to match wherever its own label actually
 * landed, so a pushed-down label still reads as connected to its instant
 * on the timeline rather than floating.
 */
function buildComputedSessionMarkersPlugin(records) {
  const validRecords = (records || []).filter((r) => r != null);
  return {
    id: "computedSessionMarkers",
    afterDatasetsDraw(chart) {
      if (!validRecords.length) return;
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x) return;
      const { top } = chartArea;
      const ICON_SIZE = 6;
      const TIER_HEIGHT = 20; // vertical space each collision-avoidance tier takes
      const LABEL_GAP_PX = 8; // minimum breathing room required between two labels' bounding boxes

      const markers = [];
      validRecords.forEach((record, recordIdx) => {
        const color = COMPUTED_SESSION_COLORS[recordIdx % COMPUTED_SESSION_COLORS.length];
        for (const { key, label, icon } of SCHEDULE_INSTANT_DISPLAY) {
          const t = record[key];
          if (t == null) continue;
          if (t < scales.x.min || t > scales.x.max) continue;
          const x = scales.x.getPixelForValue(t);
          const text = `${label} ${fmtNaive(t, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
          markers.push({ x, text, icon, color });
        }
      });
      if (!markers.length) return;
      markers.sort((a, b) => a.x - b.x);

      ctx.save();
      ctx.font = "700 8px -apple-system, BlinkMacSystemFont, sans-serif";
      // tierRightEdge[i] = the rightmost pixel already claimed at tier i by
      // whatever was placed there most recently (markers are processed in
      // x-order, so "most recently" is always the nearest one to the left).
      const tierRightEdge = [];
      for (const marker of markers) {
        const halfWidth = ctx.measureText(marker.text).width / 2;
        let tier = 0;
        while (tierRightEdge[tier] != null && marker.x - halfWidth < tierRightEdge[tier] + LABEL_GAP_PX) {
          tier++;
        }
        tierRightEdge[tier] = marker.x + halfWidth;
        marker.tier = tier;
      }

      for (const { x, text, icon, color, tier } of markers) {
        const iconCy = top + ICON_SIZE + 3 + tier * TIER_HEIGHT;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, iconCy - ICON_SIZE - 1);
        ctx.stroke();
        // Icon draw functions above are all black/white-fill by design
        // (matching drawFishIcon's existing convention) — tint via a
        // save/restore + globalCompositeOperation trick would be
        // overkill here, so instead each icon gets a small colored dot
        // behind it (cheap, reliable) rather than trying to recolor the
        // icon's own path fills per record.
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, iconCy, ICON_SIZE + 3, 0, Math.PI * 2);
        ctx.globalAlpha = 0.16;
        ctx.fill();
        ctx.globalAlpha = 1;
        icon(ctx, x, iconCy, ICON_SIZE);
        ctx.font = "700 8px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.fillStyle = color;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(text, x, iconCy + ICON_SIZE + 3);
      }
      ctx.restore();
    },
  };
}

/**
 * Live feedback for the click-drag-release gesture itself (wireSessionRangeSelect,
 * week.js) — a getPreviewState() closure rather than a plain value
 * because this plugin is built ONCE per row at chart-creation time, but
 * the drag state changes on every pointermove afterwards; reading it
 * fresh at each redraw (the caller calls chart.draw() on every
 * pointermove while armed) means one plugin instance can serve the whole
 * gesture rather than rebuilding the chart mid-drag.
 *
 * getPreviewState() returns null (or an object with hoverXVal null) when
 * this row isn't currently armed/being interacted with, in which case
 * this draws nothing at all — same shape either way, so the caller never
 * needs to add/remove this plugin, just let it return nothing to draw.
 */
function buildSessionDragPreviewPlugin(getPreviewState) {
  return {
    id: "sessionDragPreview",
    afterDatasetsDraw(chart) {
      const state = getPreviewState ? getPreviewState() : null;
      if (!state || state.hoverXVal == null) return;
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x) return;
      const { top, bottom } = chartArea;
      ctx.save();
      // Shaded range for the drag in progress — only while an actual drag
      // (pointer down) is underway, not during the plain pre-drag hover.
      if (state.dragStartXVal != null) {
        const fromVal = Math.min(state.dragStartXVal, state.hoverXVal);
        const toVal = Math.max(state.dragStartXVal, state.hoverXVal);
        const xA = scales.x.getPixelForValue(Math.max(fromVal, scales.x.min));
        const xB = scales.x.getPixelForValue(Math.min(toVal, scales.x.max));
        if (xB > xA) {
          ctx.fillStyle = "rgba(15, 118, 110, 0.18)";
          ctx.fillRect(xA, top, xB - xA, bottom - top);
        }
      }
      // The hover time itself — shown under the mouse the whole time this
      // row is armed, whether or not a drag is currently in progress, so
      // there's always a readable answer to "what time am I about to
      // start/end this at".
      const x = scales.x.getPixelForValue(state.hoverXVal);
      if (x >= chartArea.left && x <= chartArea.right) {
        ctx.strokeStyle = "#0f766e";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        const label = fmtNaive(state.hoverXVal, { hour: "2-digit", minute: "2-digit", hour12: false });
        ctx.font = "700 10px -apple-system, BlinkMacSystemFont, sans-serif";
        const textWidth = ctx.measureText(label).width;
        const boxPad = 5;
        const boxH = 15;
        const boxY = top + 2;
        let boxX = x - textWidth / 2 - boxPad;
        // Clamped to stay inside the plot area rather than running off the
        // edge when hovering right at the start/end of the visible range.
        boxX = Math.max(chartArea.left, Math.min(chartArea.right - (textWidth + boxPad * 2), boxX));
        ctx.fillStyle = "#0f766e";
        ctx.fillRect(boxX, boxY, textWidth + boxPad * 2, boxH);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(label, boxX + boxPad, boxY + 3);
      }
      ctx.restore();
    },
  };
}

function buildSessionSpanPlugin(spans) {
  // Accepts an ARRAY of {from,to} spans now, not just one — a single
  // location's row can have more than one qualifying session across the
  // displayed period (Week Ahead's new row-per-location layout), and all
  // of them need shading on the same chart. Invalid/incomplete spans are
  // filtered out up front so beforeDraw/afterDraw don't need to re-check
  // each one every frame.
  const validSpans = (spans || []).filter((s) => s && s.from != null && s.to != null);

  return {
    id: "sessionSpan",
    beforeDraw(chart) {
      if (validSpans.length === 0) return;
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x) return;
      const { top, bottom } = chartArea;
      ctx.save();
      ctx.fillStyle = "rgba(22, 163, 74, 0.14)";
      for (const { from, to } of validSpans) {
        const clampedFrom = Math.max(from, scales.x.min);
        const clampedTo = Math.min(to, scales.x.max);
        if (clampedTo <= clampedFrom) continue;
        const xStart = scales.x.getPixelForValue(clampedFrom);
        const xEnd = scales.x.getPixelForValue(clampedTo);
        ctx.fillRect(xStart, top, xEnd - xStart, bottom - top);
      }
      ctx.restore();
    },
    // afterDatasetsDraw, not afterDraw — same reasoning as the other
    // full-height overlay plugins above: these dashed lines/labels could
    // otherwise paint over a tooltip hovering nearby. afterDatasetsDraw
    // guarantees they draw before the tooltip regardless of plugin
    // registration order.
    afterDatasetsDraw(chart) {
      if (validSpans.length === 0) return;
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x) return;
      const { top, bottom } = chartArea;
      for (const { from, to } of validSpans) {
        [
          { t: from, label: "Session start" },
          { t: to, label: "Session end" },
        ].forEach(({ t, label }) => {
          if (t < scales.x.min || t > scales.x.max) return;
          const x = scales.x.getPixelForValue(t);
          ctx.save();
          ctx.strokeStyle = SESSION_SPAN_COLOR;
          ctx.lineWidth = 2;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, bottom);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = "700 9px -apple-system, BlinkMacSystemFont, sans-serif";
          ctx.fillStyle = SESSION_SPAN_COLOR;
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(label, x, bottom - 2);
          ctx.restore();
        });
      }
    },
  };
}

function renderConditionsChart({ canvas, rows, sunTimes, existingChart, locationName, tideMaxObserved, moonPhases, minTideHeight, stopFishingTime, compact, sessionSpan, computedSessionMarkers, dragPreviewState, showDayHeading = true, showSunTimes = true, xRange, disableBuiltinEvents = false, showFirstBoxIcons = false, tideOffsetMinutes, hideValueAxes = false, overlayHeading = false, extraPlugins = [] }) {
  if (existingChart) existingChart.destroy();
  if (!rows || rows.length === 0) return null;
  rows = bucketRowsHourly(rows);
  // Applied here, once, centrally — every caller of this shared function
  // (every graph on the site) gets the shift automatically as a result,
  // with no separate per-page code needed: the drawn curve, the high/low
  // labels, and the ramp-access threshold-crossing times all read
  // "Tide Height (m)" from these SAME rows, so shifting it here is enough
  // for all three at once. See applyTideOffsetToRows for what this
  // deliberately does NOT touch (Tide Status, Condition scores).
  rows = applyTideOffsetToRows(rows, tideOffsetMinutes);

  // On mobile, the full descriptive legend labels take up a lot of vertical space
  // under the chart (often wrapping to several lines) — shorten them there, since
  // desktop has plenty of room to keep the fuller, more descriptive text.
  const isMobile = typeof window !== "undefined" && window.innerWidth < 900;

  // Each location's own real observed tide range calibrates its own axis
  // ceiling, rather than one fixed number for every location — Western
  // Port's ~3m swings and Port Phillip Bay's sub-1m ones would otherwise
  // either clip the former or make the latter look flat/unreadable. Now
  // that tide has its own labeled axis (below), this headroom is just
  // normal chart practice — keeping the peak clear of the very top pixel —
  // not an attempt to dodge overlapping with a different, hidden axis
  // (that confusion is gone structurally now, not by tuning a margin).
  // Falls back to a sensible default if this specific location has no
  // tide data at all (older cached data, or no nearby tide station).
  const tideAxisMax = tideMaxObserved != null ? Math.round(tideMaxObserved * 1.15 * 100) / 100 : 3.5;
  const L = isMobile
    ? { tempFcst: "Tmp Fcst", tempNow: "Tmp Now", rain: "Rain %", windFcst: "Wind Fcst", windNow: "Wind Now", tide: "Tide", waterTemp: "Water °C", pressure: "Pressure" }
    : { tempFcst: "Temp Forecast (°C)", tempNow: "Temp Realtime (°C)", rain: "Rainfall Probability (%)", windFcst: "Wind Forecast (km/h)", windNow: "Wind Realtime (km/h)", tide: "Tide Height (m)", waterTemp: "Water Temp (°C)", pressure: "Pressure (hPa)" };

  const pointsFor = (field) => rows.map((r) => ({ x: r._t, y: r[field] ?? null }));

  const datasets = [
    {
      // Forecast — hollow/outline marker (see makeArrowCanvas's own
      // comment for the same forecast=hollow/realtime=solid convention
      // applied to every paired series below): pointBackgroundColor
      // "transparent" with a colored border is how Chart.js draws an
      // outline-only circle, rather than a separate shape.
      label: L.tempFcst,
      data: pointsFor("Temp Forecast (C)"),
      borderColor: "#f97316",
      borderWidth: 1,
      pointRadius: 4,
      pointBackgroundColor: "transparent",
      pointBorderColor: "#f97316",
      pointBorderWidth: 2,
      yAxisID: "yTemp",
      tension: 0.3,
    },
    {
      // Realtime — solid/filled marker (an actual observed reading, not a
      // prediction). Previously had no markers at all (pointRadius: 0);
      // now shows a dot only where a real reading exists, same
      // "only draw a point where there's really a value" guard the wind
      // arrows below already used.
      label: L.tempNow,
      data: pointsFor("Temp Realtime (C)"),
      borderColor: "#fdba74",
      borderWidth: 1,
      pointRadius: rows.map((r) => (r["Temp Realtime (C)"] != null ? 4 : 0)),
      pointBackgroundColor: "#fdba74",
      yAxisID: "yTemp",
      tension: 0.3,
    },
    {
      // Sea surface temperature, from Open-Meteo's Marine API — plotted on
      // the same Celsius axis as air temperature (yTemp) since it's the
      // same unit and a similar real-world range, rather than adding a
      // seventh axis just for one line. Thin and light — a trend line to
      // glance at alongside air temp, not something meant to compete
      // visually with the wind/rain/tide lines that actually drive the
      // Location/Fishing Condition scores. No forecast/realtime pairing
      // exists for this one (it's Open-Meteo's own forecast only), so it
      // stays a plain line with no point markers, same as Tide/Pressure
      // below — the forecast=hollow/realtime=solid convention only
      // applies to series that actually have both variants.
      label: L.waterTemp,
      data: pointsFor("Water Temp (C)"),
      borderColor: "#7dd3fc",
      borderWidth: 1,
      pointRadius: 0,
      yAxisID: "yTemp",
      tension: 0.3,
    },
    {
      // Rainfall probability only ever exists as a forecast (WillyWeather
      // has no "realtime rainfall" reading this site plots) — hollow
      // marker for the same reason Temp Forecast's is: it's a prediction,
      // not yet a fact.
      label: L.rain,
      data: pointsFor("Rainfall Probability (%)"),
      borderColor: "#3b82f6",
      pointRadius: 4,
      pointBackgroundColor: "transparent",
      pointBorderColor: "#3b82f6",
      pointBorderWidth: 2,
      yAxisID: "yRain",
      tension: 0.3,
    },
    {
      // Forecast — hollow arrow (makeArrowCanvas's filled=false), bigger
      // than before (radius 7 → 10, arrow canvas itself 14px → 20px).
      label: L.windFcst,
      data: pointsFor("Wind Forecast (km/h)"),
      borderColor: "#16a34a",
      borderWidth: 1,
      pointStyle: rows.map((r) => makeArrowCanvas(windColor(r["Wind Forecast (km/h)"]), false)),
      pointRadius: rows.map((r) => (r["Wind Forecast (km/h)"] != null ? 10 : 0)),
      pointRotation: rows.map((r) => dirToArrowRotation(r["Wind Forecast Dir"])),
      yAxisID: "yWind",
      tension: 0.3,
    },
    {
      // Realtime — solid arrow, same bigger size as the forecast one above.
      label: L.windNow,
      data: pointsFor("Wind Realtime (km/h)"),
      borderColor: "#86efac",
      borderWidth: 1,
      pointStyle: rows.map((r) => makeArrowCanvas(windColor(r["Wind Realtime (km/h)"]), true)),
      pointRadius: rows.map((r) => (r["Wind Realtime (km/h)"] != null ? 10 : 0)),
      pointRotation: rows.map((r) => dirToArrowRotation(r["Wind Realtime Dir"])),
      yAxisID: "yWind",
      tension: 0.3,
    },
    {
      label: L.tide,
      data: pointsFor("Tide Height (m)"),
      borderColor: "#4f46e5",
      backgroundColor: "rgba(79, 70, 229, 0.15)",
      fill: true,
      pointRadius: 0,
      yAxisID: "yTide",
      tension: 0.4,
    },
    {
      // Mean sea-level pressure, from Open-Meteo (the same hourly series
      // whose daily average already feeds the Fishing Condition score's
      // pressure factor). Its own hidden axis, same treatment as yTide —
      // hPa has no natural shared axis with anything else on this chart
      // (not Celsius, not km/h, not a percentage), and a full visible axis
      // for one supplementary trend line would be more clutter than the
      // line is worth. Plain black and thin so it reads as a subtle
      // reference line, not another line competing with wind/rain/tide.
      label: L.pressure,
      data: pointsFor("Pressure (hPa)"),
      borderColor: "#000000",
      borderWidth: 1,
      pointRadius: 0,
      yAxisID: "yPressure",
      tension: 0.3,
    },
  ];

  // xRange lets a caller lock this chart's x-axis to two exact timestamps
  // rather than the first/last row it happens to have data for — used by
  // Week Ahead's embedded per-tile graphs (week.js) so the chart's own
  // time-to-pixel scale matches PIXELS_PER_HOUR exactly and lines up with
  // the shared timeline's day/night shading and hour ticks sitting behind
  // it. Every other caller doesn't pass this, so falls back to the actual
  // row range exactly as before.
  const minT = xRange ? xRange.min : rows[0]._t;
  const maxT = xRange ? xRange.max : rows[rows.length - 1]._t;

  // sessionSpan may be a single {from,to} object (every existing caller —
  // app.js, live.js, week.js) or an array of them (Week Ahead's new
  // row-per-location layout, where one location can have several
  // qualifying sessions across the displayed period) — normalized to an
  // array here so buildSessionSpanPlugin only has to handle one shape.
  const sessionSpanList = sessionSpan == null ? [] : Array.isArray(sessionSpan) ? sessionSpan : [sessionSpan];

  const chart = new Chart(canvas, {
    type: "line",
    data: { datasets },
    plugins: [
      buildDayBandPlugin(rows, sunTimes, locationName, moonPhases, showDayHeading, showSunTimes, overlayHeading),
      buildSessionSpanPlugin(sessionSpanList),
      buildComputedSessionMarkersPlugin(computedSessionMarkers),
      buildSessionDragPreviewPlugin(dragPreviewState),
      buildConditionStripsPlugin(rows, isMobile, showFirstBoxIcons),
      buildNowAndThresholdPlugin(rows, minTideHeight, stopFishingTime),
      buildTideExtremaPlugin(rows),
      buildSwellMarkersPlugin(rows),
      buildTooltipCrosshairPlugin(rows),
      ...extraPlugins, // caller-supplied overlays (the Reports tab's session ribbon draws its session bars and catch dots this way)
      // Skipped in compact mode — nothing to label when there are no axes.
      // Also skipped when hideValueAxes alone is set (x-axis still shows,
      // but the °C/km/h axes these labels annotate don't) — same reasoning,
      // just for a narrower case than full compact mode.
      ...(compact || hideValueAxes ? [] : [buildAxisUnitLabelsPlugin()]),
    ],
    options: {
      responsive: true,
      // Skips Chart.js's own built-in tap/click/hover-triggered tooltip
      // interaction entirely (an empty events list means nothing native
      // triggers it) — for callers that want to drive the tooltip
      // themselves via chart.tooltip.setActiveElements() instead (Week
      // Ahead's hold-to-show-tooltip behavior — see week.js). This
      // has to happen at chart CONSTRUCTION time: Chart.js reads
      // options.events once, when it first binds its own internal
      // listeners, so mutating it after the chart already exists doesn't
      // reliably take effect. Every other caller doesn't pass this, so
      // defaults to false and gets Chart.js's normal tap/hover tooltip
      // behavior exactly as before.
      ...(disableBuiltinEvents ? { events: [] } : {}),
      // Chart.js defaults to maintainAspectRatio:true (with its own
      // built-in default aspectRatio, ~2:1 for line charts) — meaning
      // WITHOUT this, Chart.js computes the canvas's internal height from
      // its own aspect ratio instead of the container's actual measured
      // height, then the CSS width/height:100%!important on the canvas
      // (every chart-wrap on this site uses that pattern deliberately, to
      // let CSS fully control the container's size) forces that wrongly-
      // sized internal raster to fit anyway — invisible when a container's
      // real aspect ratio happens to be close to 2:1 (most of this site's
      // chart containers are), but severely distorted (aliased, jagged
      // lines) on anything far from that, like Week Ahead's row-per-
      // location graphs (~15:1 — very wide, fixed-height rows). Explicit
      // false makes Chart.js size the canvas to the container's actual
      // measured box instead, which is what every container on this site
      // already assumes is happening.
      maintainAspectRatio: false,
      spanGaps: true,
      // Extra top padding reserves space for two stacked elements above the
      // plot area: the moon phase glyph and the day heading text (see
      // buildDayBandPlugin). Shrunk when both are suppressed (showDayHeading:
      // false, moonPhases: null) so a tile that isn't drawing either doesn't
      // waste vertical space reserving room for them anyway.
      // autoPadding:false stops Chart.js reserving extra edge margin so
      // large point markers (the pointRadius:10 wind arrows) never get
      // clipped when they land exactly at the x-axis's own min/max — which
      // they do on Week Ahead's row-per-location graphs, since every row's
      // first/last row of data sits exactly at the displayed range's own
      // start/end. That auto-reserved margin (Chart.js's default) insets
      // the chart's own internal time-to-pixel mapping from the canvas's
      // true edges while the shared timeline header (plain CSS, no such
      // margin) doesn't — so the two drift apart the further from centre
      // you look: each row's graph reads a little late at its own start
      // and a little early at its own end relative to the header's
      // sunrise/sunset ticks above it. Turning this off makes the chart's
      // plot area span the canvas edge-to-edge, matching the header's own
      // unpadded pixel math exactly. Trade-off: the very first/last wind
      // arrow marker can now sit flush against (and be very slightly
      // clipped by) the canvas edge instead of being padded clear of it —
      // a minor cosmetic cost against every row lining up correctly with
      // the shared header, which matters far more here.
      // Also shrunk to the small (8) value, regardless of showDayHeading/
      // moonPhases, when overlayHeading is set — that draws the day
      // heading/moon icon INSIDE the plot area instead of in this reserved
      // strip above it, specifically to reclaim the space this padding
      // would otherwise set aside. See buildDayBandPlugin.
      // Bottom padding reserves vertical space for
      // buildConditionStripsPlugin's two condition-strip rows, so the
      // data lines' own Y-scale clears the strip zone instead of ever
      // rendering into it — same principle as the top padding already
      // reserving space for the day-heading strip above.
      //
      // EXACT match to what the strips actually use — stripHeight*2,
      // isMobile-aware (28px desktop, 22px mobile) — NOT a flat safe
      // over-estimate anymore. An earlier version of this reserved a
      // flat 39px "to be safe" regardless of isMobile, on the theory
      // that a little extra reserved-but-unused space was harmless.
      // Confirmed directly against the live rendered canvas (pixel-
      // sampling the actual output) that it wasn't harmless: the strips
      // only ever filled 28px of that reserved 39, leaving an 11px band
      // of literally transparent canvas between the bottom of the
      // strips and the edge of the chart frame — a second, genuinely
      // real gap, distinct from (and found after) the chart-to-strip
      // gap this same reservation was originally built to fix. Kept
      // isMobile-aware now specifically because being exact matters more
      // than being simple — the CSS values this depends on
      // (.location-hover-panel-chart-frame, .live-chart-frame,
      // .weeknew-row-chart, and index.html's mobile row-height script)
      // all have matching desktop/mobile numbers now for the same reason.
      //
      // THIS PADDING ALONE ONLY MOVES THE PROBLEM, IT DOESN'T FIX IT: it
      // shrinks the plot area within whatever total canvas height the
      // page's CSS gives it, which compresses every data line CLOSER to
      // the new (higher) bottom edge — for a value that only had a
      // little headroom to begin with, shrinking the available height
      // can push it INTO the now-higher strip zone rather than clear of
      // it (this is exactly what happened the first time this was
      // "fixed": it visibly got worse, not better). The other, equally
      // required half of this fix is in each page's CSS: the fixed chart
      // frame height (.location-hover-panel-chart-frame,
      // .live-chart-frame, .weeknew-row-chart) needs to grow by this
      // same reserved amount, so the plot area's OWN usable height stays
      // exactly what it was before this reservation existed, and the
      // reserved space is genuinely NEW space appended below it for the
      // strips — not carved out of space the data was already using.
      // Top padding is small (4px) for the compact/no-heading case —
      // just enough that a marker sitting right at an axis's max value
      // doesn't get clipped by the canvas edge, not a deliberate visual
      // gap. Reduced twice now — 8px, then 4px, now 2px — after feedback
      // each time that even a small margin still read as a gap above the
      // plot once the bottom-side strip overlap was actually fixed; 2px
      // is close to as tight as this can go while still keeping SOME
      // clearance for a marker sitting right at an axis's max value.
      layout: {
        padding: {
          top: overlayHeading ? 0 : showDayHeading || moonPhases ? 40 : 0,
          bottom: isMobile ? 22 : 28,
        },
        autoPadding: false,
      },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          type: "linear",
          min: minT,
          max: maxT,
          // hideValueAxes hides this too, despite its name being about the
          // y ("value") axes — its only actual caller (the Location tab's
          // preview panel, app.js) wants every axis gone, and there was no
          // reason to invent a second, near-identical flag just to cover
          // the x-axis as well once that became true too.
          display: !compact && !hideValueAxes,
          // stepSize is exactly one hour in ms — a candidate tick at every
          // hour boundary within the visible range, not Chart.js's default
          // "nice round numbers" spacing. autoSkip:false forces every one
          // of those candidates to actually render rather than Chart.js
          // thinning them out to fit — Oliver explicitly asked for every
          // hour, so on a multi-day view this axis will genuinely be
          // dense; that's the deliberate trade-off of what was asked for,
          // not an oversight (autoSkip:true + a real crowding problem is
          // the one-setting revert if it turns out too cluttered in
          // practice). maxTicksLimit no longer does anything once
          // autoSkip is off, so it's dropped rather than left in place
          // pretending to still matter.
          ticks: { stepSize: 3600000, autoSkip: false, callback: (value) => fmtAxisHourTick(value) },
          grid: { color: "rgba(0,0,0,0.05)" },
        },
        // Each axis's min used to be pushed well below any realistic data
        // value specifically to leave clear space at the bottom for the
        // condition strips — no longer needed for that now that the
        // strips draw in their own reserved padding.bottom zone instead
        // of inside the plot area (buildConditionStripsPlugin) — so
        // yRain's min is a real 0 now, meaning 0% rainfall correctly sits
        // right at the very bottom rather than floating above it.
        // yTemp/yWind keep a small negative floor (-2) below their real
        // minimum (0°C-ish, 0 km/h) purely as a little visual breathing
        // room, not because anything below them needs the space anymore.
        // Their MAX values were 40/50 until this point — hugely oversized
        // relative to what real conditions ever reach (confirmed against
        // actual plotted data: temp routinely tops out in the high teens,
        // wind in the high 30s at most, even in fairly active weather),
        // which meant the top third-to-half of the chart's vertical space
        // was structurally empty almost all the time — no data was ever
        // going to reach up there, regardless of anything else drawn
        // nearby (the day-band tint, the strips, none of that changes
        // this). 32/45 still leave real headroom above anything observed
        // so far without clipping a genuinely hot day or a strong blow,
        // but give both curves a realistic chance to actually use the
        // space they're drawn in, rather than permanently riding low.
        // No axis title here (display:false) — a rotated Chart.js title
        // reserves a full extra margin column on the left/right regardless
        // of how short the text is. A compact "°C"/"km/h" label is drawn
        // directly at the top of each axis instead, by buildAxisUnitLabelsPlugin
        // below, using space already reserved for the day heading rather
        // than adding new margin.
        yTemp: { position: "left", min: -2, max: 32, display: !compact && !hideValueAxes, title: { display: false } },
        yRain: { display: false, min: 0, max: 100 },
        yWind: { position: "right", min: -2, max: 45, display: !compact && !hideValueAxes, grid: { drawOnChartArea: false }, title: { display: false } },
        yTide: {
          // Always hidden — the filled tide shape on the chart already
          // conveys high/low visually; a numeric axis for it isn't needed,
          // and hiding it keeps that side of the chart clear for temperature.
          display: false,
          position: "left",
          min: 0,
          max: tideAxisMax,
        },
        yPressure: {
          // Always hidden, same reasoning as yTide above — the line itself
          // (a thin black trend) is the point, not a readable number scale.
          // Fixed 970-1050hPa range (not per-location calibrated, unlike
          // yTide) — pressure swings are weather-driven, not a property of
          // the location, so one sensible fixed range covering the real
          // range Victoria sees suits every location equally well.
          display: false,
          position: "left",
          min: 970,
          max: 1050,
        },
        ySwell: {
          // Always hidden, same reasoning as yPressure above — a swell
          // marker's own y-position already conveys its height visually
          // (buildSwellMarkersPlugin), no separate readable axis needed.
          // WillyWeather's swell forecast is offshore data (their own
          // docs: WaveWatch III / NOAA), not calibrated to any one
          // sheltered bay location the way yTide's own per-location max
          // is — a fixed range covering the real range Victoria's open
          // coast sees is the same reasoning yPressure's own fixed range
          // already uses, for the same reason.
          display: false,
          position: "left",
          min: 0,
          max: 4,
        },
      },
      plugins: {
        legend: {
          display: false,
          position: "bottom",
          labels: {
            boxWidth: isMobile ? 8 : 12,
            boxHeight: isMobile ? 8 : 12,
            padding: isMobile ? 6 : 10,
            font: { size: isMobile ? 8 : 10 },
          },
          // Preserves Chart.js's own default behavior (toggling that
          // dataset's visibility) while flagging that this click was a
          // genuine legend-item click — relying on Chart.js's own hit-
          // testing here, rather than reimplementing "was this click
          // inside the legend's drawn area" by hand. The canvas-level
          // "tap to show/hide the whole legend" handler below checks this
          // flag so it doesn't also fire for the same click.
          onClick: (e, legendItem, legend) => {
            Chart.defaults.plugins.legend.onClick.call(legend, e, legendItem, legend);
            canvas.dataset.legendItemJustClicked = "true";
          },
        },
        tooltip: {
          // Disabled entirely for callers that manually drive the
          // tooltip (disableBuiltinEvents — Live, Week Ahead) — see
          // buildTooltipCrosshairPlugin for why: Chart.js's own tooltip
          // rendering proved unreliable when triggered by an externally
          // set active element rather than a genuine hover, so those
          // pages draw their own box instead. enabled:false only turns
          // off the native BOX rendering — chart.tooltip.getActiveElements()
          // / setActiveElements() keep working exactly the same, which is
          // all that plugin needs. Every other caller is unaffected and
          // keeps Chart.js's normal tap/hover tooltip exactly as before.
          enabled: !disableBuiltinEvents,
          callbacks: {
            title: (items) =>
              items.length
                ? new Intl.DateTimeFormat([], { timeZone: "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(items[0].parsed.x))
                : "",
            // Location/Fishing Condition are drawn as strips, not real
            // datasets, so they don't get their own tooltip line from Chart.js
            // automatically — this adds one manually, looking up the same row
            // by index that the hovered point already resolved to.
            afterBody: (items) => {
              if (!items.length) return [];
              const row = rows[items[0].dataIndex];
              if (!row) return [];
              const lines = [];
              if (row["Condition"] != null) {
                lines.push(`Location ${row["Condition"].toFixed(1)}/5 — ${row["Condition Reason"] || ""}`);
              }
              if (row["Fishing Condition"] != null) {
                lines.push(`Fishing ${row["Fishing Condition"].toFixed(1)}/5 — ${row["Fishing Condition Reason"] || ""}`);
              }
              const swellLine = formatSwellTooltipLine(row);
              if (swellLine) lines.push(swellLine);
              return lines;
            },
          },
        },
      },
    },
  });

  // Tap the graph to show/hide the legend — cursor:pointer signals it's clickable.
  // Only wired up outside compact mode — a compact chart's own click is reserved
  // for opening the full view instead (see live.js), and a toggleable legend
  // doesn't fit a deliberately minimal view anyway. Attach only once per canvas
  // element (guarded via dataset), since the canvas persists in the DOM across
  // repeated calls even as the Chart.js instance itself gets destroyed/recreated
  // on every render — Chart.getChart() always looks up whichever instance is
  // *currently* attached, so a stale closure isn't a risk.
  if (!compact) {
    canvas.style.cursor = "pointer";
    if (!canvas.dataset.legendToggleAttached) {
      canvas.dataset.legendToggleAttached = "true";
      canvas.addEventListener("click", () => {
        // A genuine legend-item click already ran through Chart.js's own
        // legend.onClick above (toggling that dataset's visibility) —
        // don't also collapse the whole legend for that same click, or
        // clicking any legend item immediately hides the legend it just
        // acted on, making it impossible to toggle a second item.
        if (canvas.dataset.legendItemJustClicked === "true") {
          canvas.dataset.legendItemJustClicked = "false";
          return;
        }
        const current = Chart.getChart(canvas);
        if (!current) return;
        current.options.plugins.legend.display = !current.options.plugins.legend.display;
        current.update();
      });
    }
  }

  return chart;
}

// ============================================================================
// Shared "qualifying session window" logic — used by week.js (Week Ahead)
// to compute sessions from the site-wide threshold/filter settings, kept
// here rather than duplicated so bug fixes only need to happen once.
// ============================================================================
