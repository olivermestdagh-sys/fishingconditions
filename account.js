/**
 * account.js — talks to the user-backend Worker (see user-backend.js) to
 * let a signed-in user manage their OWN locations and check-frequency
 * settings. Entirely separate from locationsadmin.js, which edits the
 * site-wide config/locations.json via a GitHub commit — this instead
 * calls a live API and saves per-row, immediately, no GitHub token
 * involved at all.
 *
 * REPLACE THIS after deploying user-backend.js (see that file's own
 * DEPLOYING THIS section) — same one-time pattern as
 * WILLYWEATHER_SEARCH_WORKER_URL in charts.js.
 */
const USER_BACKEND_URL = "https://fishingconditions-users.YOUR-SUBDOMAIN.workers.dev";

const VALID_TYPES = ["Kayak", "Land based"];

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("btnSignIn").addEventListener("click", () => {
    window.location.href = `${USER_BACKEND_URL}/auth/login`;
  });
  document.getElementById("btnSignOut").addEventListener("click", signOut);
  document.getElementById("btnSaveSettings").addEventListener("click", saveSettings);
  document.getElementById("btnAddLocation").addEventListener("click", () => addLocationRow(blankLocation()));

  init();
});

async function init() {
  const statusEl = document.getElementById("status");
  const user = await fetchMe();
  statusEl.textContent = "";

  if (!user) {
    document.getElementById("signedOutCard").style.display = "";
    document.getElementById("signedInCard").style.display = "none";
    document.getElementById("settingsSection").style.display = "none";
    document.getElementById("locationsSection").style.display = "none";
    return;
  }

  document.getElementById("signedOutCard").style.display = "none";
  document.getElementById("signedInCard").style.display = "";
  document.getElementById("settingsSection").style.display = "";
  document.getElementById("locationsSection").style.display = "";
  document.getElementById("whoAmI").textContent = `Signed in as ${user.name ? `${user.name} (${user.email})` : user.email}`;

  await Promise.all([loadSettings(), loadLocations()]);
}

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------

async function fetchMe() {
  try {
    const res = await fetch(`${USER_BACKEND_URL}/auth/me`, { credentials: "include" });
    if (!res.ok) return null; // 401 = not signed in, treated the same as any other failure here
    return await res.json();
  } catch (err) {
    console.error("Failed to check sign-in state:", err);
    return null;
  }
}

async function signOut() {
  try {
    await fetch(`${USER_BACKEND_URL}/auth/logout`, { method: "POST", credentials: "include" });
  } catch (err) {
    console.error("Sign-out request failed:", err);
    // Still refresh the UI below — even if the network call failed, there's
    // nothing more useful to do than re-check the actual sign-in state.
  }
  init();
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------

async function loadSettings() {
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/settings`, { credentials: "include" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const settings = await res.json();
    document.getElementById("checkFrequency").value = settings.checkFrequencyMinutes;
    document.getElementById("windowStart").value = settings.activeWindowStart;
    document.getElementById("windowEnd").value = settings.activeWindowEnd;
  } catch (err) {
    console.error("Failed to load settings:", err);
    setStatus("settingsStatus", "Couldn't load your settings — try reloading the page.", true);
  }
}

async function saveSettings() {
  const body = {
    checkFrequencyMinutes: parseInt(document.getElementById("checkFrequency").value, 10),
    activeWindowStart: document.getElementById("windowStart").value,
    activeWindowEnd: document.getElementById("windowEnd").value,
  };
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/settings`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `status ${res.status}`);
    }
    setStatus("settingsStatus", "Saved.", false);
  } catch (err) {
    console.error("Failed to save settings:", err);
    setStatus("settingsStatus", `Couldn't save: ${err.message}`, true);
  }
}

// ---------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------

function blankLocation() {
  return { id: null, name: "", lat: "", lng: "", willyweatherId: null, type: "Kayak", tidal: true };
}

async function loadLocations() {
  const listEl = document.getElementById("myLocationsList");
  listEl.innerHTML = "";
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/locations`, { credentials: "include" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const locations = await res.json();
    if (locations.length === 0) {
      listEl.innerHTML = '<p class="footnote" style="text-align:left;">No locations yet — add one below.</p>';
    }
    locations.forEach((loc) => addLocationRow(loc));
  } catch (err) {
    console.error("Failed to load locations:", err);
    listEl.innerHTML = '<p class="footnote" style="text-align:left;">Couldn\'t load your locations — try reloading the page.</p>';
  }
}

/**
 * Builds one editable location card and appends it to the list. Each card
 * is self-contained (its own Save/Delete handlers close over `loc` and the
 * card's own input elements) rather than re-reading the whole list on
 * every action — matches this being a per-row API, not a whole-file commit
 * the way locationsadmin.js's Save button is.
 */
function addLocationRow(loc) {
  const listEl = document.getElementById("myLocationsList");
  const card = document.createElement("div");
  card.className = "window-card loc-edit-card";
  card.style.marginBottom = "10px";

  const typeOptions = VALID_TYPES.map(
    (t) => `<option value="${t}"${t === loc.type ? " selected" : ""}>${t}</option>`
  ).join("");

  card.innerHTML = `
    <div class="filter-row" style="margin-bottom:8px;">
      <div style="flex:2;min-width:160px;">
        <label class="loc-edit-label">Name</label>
        <input type="text" class="f-name" value="${escapeHtml(loc.name)}" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--grey-200);" />
      </div>
      <div style="flex:1;min-width:110px;">
        <label class="loc-edit-label">Type</label>
        <select class="f-type" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--grey-200);">${typeOptions}</select>
      </div>
    </div>
    <div class="filter-row" style="margin-bottom:8px;">
      <div style="flex:1;min-width:110px;">
        <label class="loc-edit-label">Latitude</label>
        <input type="number" step="any" class="f-lat" value="${loc.lat}" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--grey-200);" />
      </div>
      <div style="flex:1;min-width:110px;">
        <label class="loc-edit-label">Longitude</label>
        <input type="number" step="any" class="f-lng" value="${loc.lng}" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--grey-200);" />
      </div>
      <div style="flex:1;min-width:110px;display:flex;align-items:flex-end;">
        <label style="display:flex;align-items:center;gap:6px;font-size:0.85rem;">
          <input type="checkbox" class="f-tidal" ${loc.tidal ? "checked" : ""} />
          Tidal
        </label>
      </div>
    </div>
    <p class="footnote f-wwstatus" style="margin:0 0 8px;text-align:left;">
      ${loc.willyweatherId ? `Matched to WillyWeather station ${loc.willyweatherId}.` : "No WillyWeather station matched yet — enter coordinates and Save to look one up."}
    </p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button type="button" class="btn-primary f-save">Save</button>
      <button type="button" class="btn-secondary f-delete">Delete</button>
    </div>
    <div class="f-status" style="margin-top:8px;font-size:0.85rem;"></div>
  `;

  card.querySelector(".f-save").addEventListener("click", () => saveLocationRow(card, loc));
  card.querySelector(".f-delete").addEventListener("click", () => deleteLocationRow(card, loc));

  listEl.appendChild(card);
}

async function saveLocationRow(card, loc) {
  const name = card.querySelector(".f-name").value.trim();
  const lat = parseFloat(card.querySelector(".f-lat").value);
  const lng = parseFloat(card.querySelector(".f-lng").value);
  const type = card.querySelector(".f-type").value;
  const tidal = card.querySelector(".f-tidal").checked;
  const statusEl = card.querySelector(".f-status");
  const wwStatusEl = card.querySelector(".f-wwstatus");

  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    statusEl.textContent = "Name, latitude, and longitude are required.";
    return;
  }

  // Best-effort WillyWeather station match via the existing search Worker
  // (fetchWillyWeatherCandidates, charts.js) — same helper the site-wide
  // admin UI already uses for its own map-click lookup, not a second
  // implementation of the same thing. Only attempted when the location
  // doesn't already carry an id, so re-saving an already-matched location
  // doesn't repeatedly spend WillyWeather calls on the same lookup.
  let willyweatherId = loc.willyweatherId;
  if (!willyweatherId) {
    wwStatusEl.textContent = "Looking up nearest WillyWeather station…";
    const candidates = await fetchWillyWeatherCandidates(lat, lng);
    if (candidates && candidates.length > 0) {
      willyweatherId = candidates[0].id;
      wwStatusEl.textContent = `Matched to WillyWeather station ${willyweatherId} (${candidates[0].name}).`;
    } else {
      wwStatusEl.textContent = "No WillyWeather station found nearby — saved without one; you can try again after moving the pin.";
    }
  }

  const body = { name, lat, lng, type, tidal, willyweatherId };
  const isCreate = !loc.id;
  const url = isCreate ? `${USER_BACKEND_URL}/api/locations` : `${USER_BACKEND_URL}/api/locations/${loc.id}`;

  try {
    const res = await fetch(url, {
      method: isCreate ? "POST" : "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `status ${res.status}`);
    }
    const saved = await res.json();
    Object.assign(loc, saved); // keep this card's closure in sync so a second Save is an update, not another create
    statusEl.textContent = "Saved.";
  } catch (err) {
    console.error("Failed to save location:", err);
    statusEl.textContent = `Couldn't save: ${err.message}`;
  }
}

async function deleteLocationRow(card, loc) {
  if (!loc.id) {
    // Never saved yet — just remove the card, nothing to delete server-side.
    card.remove();
    return;
  }
  if (!confirm(`Delete "${loc.name}"?`)) return;
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/locations/${loc.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok && res.status !== 404) throw new Error(`status ${res.status}`);
    card.remove();
  } catch (err) {
    console.error("Failed to delete location:", err);
    card.querySelector(".f-status").textContent = `Couldn't delete: ${err.message}`;
  }
}

function setStatus(elementId, message, isError) {
  const el = document.getElementById(elementId);
  el.textContent = message;
  el.style.color = isError ? "var(--red-600, #c0392b)" : "var(--grey-500)";
}
