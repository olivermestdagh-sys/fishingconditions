const GITHUB_API = "https://api.github.com";
const FILE_PATH = "config/locations.json";
const BRANCH = "main";
const WORKFLOW_FILE = "update.yml";

/**
 * Same icon shapes as charts.js's typeIconSvg — duplicated here rather than
 * loading the whole chart-rendering file just for two small icons, since
 * this page has nothing else to do with charts. Keep both copies in sync
 * if either one changes.
 */
function typeIconSvg(type, size) {
  size = size || 16;
  if (type === "Kayak") {
    // Elongated hull + two rods angled outward from distinct mounting
    // points, reading as a fishing kayak rather than a plain kayak.
    return `<svg viewBox="0 0 32 24" width="${size}" height="${size}">
      <path d="M2 16 Q9 12.5 16 12.5 Q23 12.5 30 16 Q23 19 16 19 Q9 19 2 16 Z" fill="#f97316" stroke="#c2410c" stroke-width="0.8"/>
      <line x1="17" y1="14" x2="27" y2="3" stroke="#78350f" stroke-width="1.6" stroke-linecap="round"/>
      <line x1="15" y1="15" x2="5" y2="4" stroke="#78350f" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`;
  }
  // Land based: a rod holder planted in the ground, a rod at an angle,
  // reel, and the line arcing out to the water.
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}">
    <path d="M1 20 L9 20" stroke="#a8a29e" stroke-width="2" stroke-linecap="round"/>
    <path d="M13 20 Q16 18.5 19 20 Q21 21 23 20" fill="none" stroke="#38bdf8" stroke-width="1.3" stroke-linecap="round"/>
    <rect x="7.3" y="14" width="1.4" height="6.5" rx="0.6" fill="#57534e"/>
    <line x1="8" y1="15" x2="20" y2="4" stroke="#92400e" stroke-width="1.2" stroke-linecap="round"/>
    <circle cx="10.3" cy="12.6" r="1" fill="#44403c"/>
    <path d="M20 4 Q19 10 17.5 19" stroke="#0ea5e9" stroke-width="0.6" fill="none" stroke-dasharray="0.5 1"/>
  </svg>`;
}

const TYPE_OPTIONS = ["Kayak", "Land based"];
const SHORE_OPTIONS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

// Which timing fields apply to each type. Drive time is no longer a static
// setting here at all — Week Ahead calculates it live from the device's
// current location. Both types have a "getting to/from the actual spot"
// step now — paddling for Kayak, walking from the carpark for Land based
// (a real case: walking along the beach to a specific spot).
const TYPE_TIME_FIELDS = {
  Kayak: [
    { key: "setUp", label: "Set up" },
    { key: "packUp", label: "Pack up" },
    { key: "timeToSpot", label: "Time to Spot" },
    { key: "timeFromSpot", label: "Time From Spot" },
  ],
  "Land based": [
    { key: "setUp", label: "Set up" },
    { key: "packUp", label: "Pack up" },
    { key: "timeToSpot", label: "Time to Spot" },
    { key: "timeFromSpot", label: "Time From Spot" },
  ],
};

function defaultTypeConfig(type) {
  const config = { type };
  for (const f of TYPE_TIME_FIELDS[type]) config[f.key] = "00:00";
  return config;
}

let locations = [];
let currentSha = null;

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function parseHM(value) {
  const m = String(value || "").match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return { h: 0, m: 0 };
  return { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) };
}

function formatHM(h, m) {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function getConnection() {
  try {
    return JSON.parse(localStorage.getItem("ghConnection") || "null");
  } catch {
    return null;
  }
}

function setStatus(text, isError) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.style.color = isError ? "#fca5a5" : "";
}

function setSaveStatus(text, isError) {
  const el = document.getElementById("saveStatus");
  el.textContent = text;
  el.style.color = isError ? "#dc2626" : "#16a34a";
}

async function init() {
  const conn = getConnection();
  if (conn) {
    document.getElementById("ghOwner").value = conn.owner || "";
    document.getElementById("ghRepo").value = conn.repo || "";
    document.getElementById("ghToken").value = conn.token || "";
  }

  document.getElementById("btnConnect").addEventListener("click", onConnect);
  document.getElementById("btnDisconnect").addEventListener("click", onDisconnect);
  document.getElementById("btnAddRow").addEventListener("click", () => {
    locations.push({ name: "", shore: "N", types: [defaultTypeConfig("Kayak")] });
    renderRows();
  });
  document.getElementById("btnSave").addEventListener("click", () => onSave(false));
  document.getElementById("btnSaveAndRefresh").addEventListener("click", () => onSave(true));

  await loadLocations();
}

async function loadLocations() {
  const conn = getConnection();
  try {
    if (conn && conn.owner && conn.repo && conn.token) {
      const res = await fetch(`${GITHUB_API}/repos/${conn.owner}/${conn.repo}/contents/${FILE_PATH}?ref=${BRANCH}`, {
        headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json" },
      });
      if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
      const json = await res.json();
      currentSha = json.sha;
      const decoded = decodeURIComponent(escape(atob(json.content.replace(/\n/g, ""))));
      locations = JSON.parse(decoded);
      setStatus("Connected — editing live from GitHub");
    } else {
      // No connection yet — fall back to the public static file, read-only until connected
      const res = await fetch("config/locations.json", { cache: "no-store" });
      locations = await res.json();
      setStatus("Viewing current locations — connect above to edit");
    }
  } catch (err) {
    console.error(err);
    setStatus("Could not load locations: " + err.message, true);
    locations = [];
  }
  document.getElementById("locationsSection").style.display = "block";
  renderRows();
}

function renderRows() {
  const list = document.getElementById("locationsList");
  list.innerHTML = "";
  locations.forEach((loc, i) => {
    if (!loc.types) loc.types = [];
    const activeTypeNames = loc.types.map((t) => t.type);

    const row = document.createElement("div");
    row.className = "window-card loc-edit-card";
    row.innerHTML = `
      <div class="loc-edit-top">
        <div style="flex:2;min-width:180px;">
          <label class="loc-edit-label">Location name</label>
          <input type="text" data-field="name" data-idx="${i}" value="${(loc.name || "").replace(/"/g, "&quot;")}" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--grey-200);" />
        </div>
        <div style="min-width:100px;">
          <label class="loc-edit-label">Shore faces</label>
          <select data-field="shore" data-idx="${i}" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--grey-200);">
            ${SHORE_OPTIONS.map((s) => `<option value="${s}" ${loc.shore === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </div>
        <div style="min-width:140px;display:flex;align-items:flex-end;padding-bottom:8px;">
          <label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;cursor:pointer;">
            <input type="checkbox" data-boolfield="tidal" data-idx="${i}" ${loc.tidal === false ? "" : "checked"} />
            Affected by tides
          </label>
        </div>
        <button data-remove-loc="${i}" class="btn-secondary" style="height:38px;">Remove location</button>
      </div>

      <label class="loc-edit-label" style="display:block;margin:12px 0 6px;">Usable for</label>
      <div class="type-photo-row" style="max-width:340px;">
        ${TYPE_OPTIONS.map((type) => `
          <button type="button" class="type-photo-card${activeTypeNames.includes(type) ? " active" : ""}"
            data-toggle-type="${type}" data-idx="${i}">
            <img src="${type === "Kayak" ? "images/type-kayak.jpg" : "images/type-landbased.jpg"}" alt="${type}" />
            <span>${type}</span>
          </button>
        `).join("")}
      </div>

      <div class="loc-type-sections">
        ${loc.types.map((typeConfig, typeIdx) => renderTypeSection(loc, typeConfig, i, typeIdx)).join("")}
      </div>
    `;
    list.appendChild(row);
  });

  wireRowListeners(list);
}

function renderTypeSection(loc, typeConfig, locIdx, typeIdx) {
  const fields = TYPE_TIME_FIELDS[typeConfig.type] || [];
  return `
    <div class="loc-type-section">
      <div class="loc-type-section-header">
        ${typeIconSvg(typeConfig.type, 15)}
        <label class="loc-edit-label" style="margin:0;">${typeConfig.type} timings (duration, hours : minutes)</label>
      </div>
      <div class="loc-time-grid">
        ${fields.map((f) => {
          const { h, m } = parseHM(typeConfig[f.key]);
          return `
          <div>
            <label class="loc-edit-label">${f.label}</label>
            <div class="hm-pair">
              <input type="number" min="0" max="23" step="1" inputmode="numeric" data-hmfield="${f.key}" data-hmpart="h" data-idx="${locIdx}" data-typeidx="${typeIdx}" value="${h}" aria-label="${f.label} hours" />
              <span class="hm-sep">:</span>
              <input type="number" min="0" max="59" step="1" inputmode="numeric" data-hmfield="${f.key}" data-hmpart="m" data-idx="${locIdx}" data-typeidx="${typeIdx}" value="${String(m).padStart(2, "0")}" aria-label="${f.label} minutes" />
            </div>
          </div>
        `;
        }).join("")}
      </div>

      ${typeConfig.type === "Kayak" ? `
      <label class="loc-edit-label" style="display:block;margin:12px 0 6px;">Minimum tide height for access (m) — leave blank if not applicable</label>
      <input type="number" min="0" step="0.1" inputmode="decimal" data-typefield="minTideHeight" data-idx="${locIdx}" data-typeidx="${typeIdx}"
        value="${typeConfig.minTideHeight != null ? typeConfig.minTideHeight : ""}"
        placeholder="e.g. 1.2"
        style="width:140px;padding:8px 10px;border-radius:8px;border:1px solid var(--grey-200);" />
      ` : ""}
    </div>
  `;
}

function wireRowListeners(list) {
  list.querySelectorAll("input[data-field], select[data-field]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const idx = Number(e.target.dataset.idx);
      const field = e.target.dataset.field;
      locations[idx][field] = e.target.value;
    });
  });

  list.querySelectorAll("input[data-boolfield]").forEach((el) => {
    el.addEventListener("change", (e) => {
      const idx = Number(e.target.dataset.idx);
      const field = e.target.dataset.boolfield;
      locations[idx][field] = e.target.checked;
    });
  });

  list.querySelectorAll("input[data-typefield]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const idx = Number(e.target.dataset.idx);
      const typeIdx = Number(e.target.dataset.typeidx);
      const field = e.target.dataset.typefield;
      // Store a real number (or null if cleared) rather than the raw
      // string every input's .value naturally is — otherwise this would
      // save as a quoted string in the JSON, breaking numeric comparisons
      // downstream (chart threshold-line math, Python min/max logic).
      locations[idx].types[typeIdx][field] = e.target.value === "" ? null : parseFloat(e.target.value);
    });
  });

  list.querySelectorAll("input[data-hmfield]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const idx = Number(e.target.dataset.idx);
      const typeIdx = Number(e.target.dataset.typeidx);
      const field = e.target.dataset.hmfield;
      const part = e.target.dataset.hmpart;
      const typeConfig = locations[idx].types[typeIdx];
      const current = parseHM(typeConfig[field]);
      const raw = Math.max(0, Math.floor(Number(e.target.value) || 0));
      if (part === "h") current.h = Math.min(23, raw);
      else current.m = Math.min(59, raw);
      typeConfig[field] = formatHM(current.h, current.m);
    });
  });

  list.querySelectorAll("button[data-remove-loc]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = Number(e.currentTarget.dataset.removeLoc);
      locations.splice(idx, 1);
      renderRows();
    });
  });

  list.querySelectorAll("button[data-toggle-type]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = Number(e.currentTarget.dataset.idx);
      const type = e.currentTarget.dataset.toggleType;
      const loc = locations[idx];
      const existingIdx = loc.types.findIndex((t) => t.type === type);
      if (existingIdx >= 0) {
        // Don't allow removing the LAST type — a location needs at least
        // one, otherwise it has no timings/scoring at all.
        if (loc.types.length <= 1) return;
        loc.types.splice(existingIdx, 1);
      } else {
        loc.types.push(defaultTypeConfig(type));
      }
      renderRows();
    });
  });
}

function onConnect() {
  const owner = document.getElementById("ghOwner").value.trim();
  const repo = document.getElementById("ghRepo").value.trim();
  const token = document.getElementById("ghToken").value.trim();
  if (!owner || !repo || !token) {
    setStatus("Fill in username, repo, and token first", true);
    return;
  }
  localStorage.setItem("ghConnection", JSON.stringify({ owner, repo, token }));
  loadLocations();
}

function onDisconnect() {
  localStorage.removeItem("ghConnection");
  document.getElementById("ghOwner").value = "";
  document.getElementById("ghRepo").value = "";
  document.getElementById("ghToken").value = "";
  currentSha = null;
  loadLocations();
}

function validateLocations() {
  for (const loc of locations) {
    if (!loc.name || !loc.name.trim()) return "Every location needs a name";
    if (!SHORE_OPTIONS.includes(loc.shore)) return `"${loc.name}" needs a valid Shore`;
    if (!loc.types || loc.types.length === 0) return `"${loc.name}" needs at least one type (Kayak or Land based)`;
    for (const t of loc.types) {
      if (!TYPE_OPTIONS.includes(t.type)) return `"${loc.name}" has an invalid type`;
    }
  }
  return null;
}

async function onSave(alsoRefresh) {
  const conn = getConnection();
  if (!conn) {
    setSaveStatus("Connect to GitHub first (above) before saving.", true);
    return;
  }
  const problem = validateLocations();
  if (problem) {
    setSaveStatus(problem, true);
    return;
  }

  // Native time inputs return "" if left untouched/cleared — normalize to
  // "00:00" so every saved type variant always has a valid HH:MM value for
  // all of its applicable fields.
  for (const loc of locations) {
    for (const t of loc.types) {
      for (const f of TYPE_TIME_FIELDS[t.type] || []) {
        if (!t[f.key]) t[f.key] = "00:00";
      }
    }
  }

  setSaveStatus("Saving…");
  try {
    // Re-fetch the current sha immediately before writing, in case the file changed elsewhere
    const getRes = await fetch(`${GITHUB_API}/repos/${conn.owner}/${conn.repo}/contents/${FILE_PATH}?ref=${BRANCH}`, {
      headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json" },
    });
    if (!getRes.ok) throw new Error(`Could not read current file (${getRes.status})`);
    const getJson = await getRes.json();
    currentSha = getJson.sha;

    const content = JSON.stringify(locations, null, 2) + "\n";
    const putRes = await fetch(`${GITHUB_API}/repos/${conn.owner}/${conn.repo}/contents/${FILE_PATH}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${conn.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "Update locations via site",
        content: utf8ToBase64(content),
        sha: currentSha,
        branch: BRANCH,
      }),
    });
    if (!putRes.ok) {
      const errBody = await putRes.json().catch(() => ({}));
      throw new Error(errBody.message || `GitHub returned ${putRes.status}`);
    }
    const putJson = await putRes.json();
    currentSha = putJson.content.sha;
    setSaveStatus("Saved to GitHub.");

    if (alsoRefresh) {
      setSaveStatus("Saved. Triggering data refresh…");
      const dispatchRes = await fetch(
        `${GITHUB_API}/repos/${conn.owner}/${conn.repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${conn.token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ref: BRANCH }),
        }
      );
      if (!dispatchRes.ok) {
        setSaveStatus("Saved, but couldn't trigger the refresh automatically — run it manually from the Actions tab.", true);
      } else {
        setSaveStatus("Saved and refresh triggered — check the Actions tab, then the Conditions tab in a minute or two.");
      }
    }
  } catch (err) {
    console.error(err);
    setSaveStatus("Save failed: " + err.message, true);
  }
}

init();
