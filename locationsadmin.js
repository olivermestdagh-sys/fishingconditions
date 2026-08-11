const GITHUB_API = "https://api.github.com";
const FILE_PATH = "config/locations.json";
const BRANCH = "main";
const WORKFLOW_FILE = "update.yml";

const TYPE_OPTIONS = ["Kayak", "Surf"];
const SHORE_OPTIONS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

let locations = [];
let currentSha = null;

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
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
    locations.push({ name: "", type: "Kayak", shore: "N" });
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
    const row = document.createElement("div");
    row.className = "window-card";
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.alignItems = "flex-end";
    row.style.flexWrap = "wrap";
    row.innerHTML = `
      <div style="flex:2;min-width:180px;">
        <label style="display:block;font-size:0.72rem;color:var(--grey-500);margin-bottom:4px;">Location name</label>
        <input type="text" data-field="name" data-idx="${i}" value="${(loc.name || "").replace(/"/g, "&quot;")}" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--grey-200);" />
      </div>
      <div style="min-width:110px;">
        <label style="display:block;font-size:0.72rem;color:var(--grey-500);margin-bottom:4px;">Type</label>
        <select data-field="type" data-idx="${i}" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--grey-200);">
          ${TYPE_OPTIONS.map((t) => `<option value="${t}" ${loc.type === t ? "selected" : ""}>${t}</option>`).join("")}
        </select>
      </div>
      <div style="min-width:100px;">
        <label style="display:block;font-size:0.72rem;color:var(--grey-500);margin-bottom:4px;">Shore faces</label>
        <select data-field="shore" data-idx="${i}" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--grey-200);">
          ${SHORE_OPTIONS.map((s) => `<option value="${s}" ${loc.shore === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
      </div>
      <button data-remove="${i}" class="btn-secondary" style="height:38px;">Remove</button>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll("input[data-field], select[data-field]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const idx = Number(e.target.dataset.idx);
      const field = e.target.dataset.field;
      locations[idx][field] = e.target.value;
    });
  });
  list.querySelectorAll("button[data-remove]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = Number(e.target.dataset.remove);
      locations.splice(idx, 1);
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
    if (!TYPE_OPTIONS.includes(loc.type)) return `"${loc.name}" needs a valid Type`;
    if (!SHORE_OPTIONS.includes(loc.shore)) return `"${loc.name}" needs a valid Shore`;
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
