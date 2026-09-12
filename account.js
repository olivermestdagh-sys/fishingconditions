/**
 * account.js — talks to the user-backend Worker (see user-backend.js) to
 * let a signed-in user manage their OWN locations and check-frequency
 * settings. Entirely separate from locationsadmin.js, which edits
 * Public's own rows through the same v2 endpoints via ?userId=public —
 * this always acts as the signed-in user themselves (no override param
 * needed; that's the default for every v2 endpoint when omitted).
 *
 * v2 RECONCILIATION: this used to call the standalone v1 /api/locations
 * endpoint (a simpler, now-deprecated table). It now calls
 * /api/tracked-locations — the SAME endpoint Admin's own Locations page
 * uses — so a personal location and one of Public's curated ones are
 * genuinely the same kind of thing under the hood, just scoped to
 * different users. The UI here stays deliberately simpler than the admin
 * page: one type per location (not several), no per-type drive/setup/
 * pack-up timing fields exposed (defaulted to "00:00" — nothing here
 * reads them), no shore field. That's a carried-forward limitation from
 * the original v1 design, not a new one introduced by this reconciliation.
 *
 * REPLACE THIS in charts.js's own USER_BACKEND_URL constant after
 * deploying user-backend.js (see that file's own DEPLOYING THIS section)
 * — same one-time pattern as WILLYWEATHER_SEARCH_WORKER_URL. NOT declared
 * again here — charts.js loads before this file on account.html, and a
 * duplicate top-level `const` of the same name across two scripts
 * sharing one global scope is a fatal SyntaxError, not a harmless
 * redeclaration. It silently broke this entire file for a while (see
 * README's "A serious bug, found and fixed" note) until caught by a real
 * page-load test.
 */

const VALID_TYPES = ["Kayak", "Land based"];

// Populated once at init from GET /api/types — every signed-in user gets
// these two seeded automatically on first sign-in (see seedDefaultTypes,
// user-backend.js), so this lookup should always succeed for a real
// account; the one-off migration for accounts that existed before that
// seeding logic shipped is a separate SQL file, not something this code
// needs to handle at runtime.
let typeNameToId = new Map();

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

  await loadTypes();
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
// Settings — unrelated to the v2 locations model entirely (still the v1
// user_settings table; no v2 equivalent exists, so nothing here changed).
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
// Locations — v2: /api/tracked-locations + /api/types, own-user scoped
// (no ?userId= override — that's an Admin-only affordance for acting as
// Public, and this page is never that).
// ---------------------------------------------------------------------

async function loadTypes() {
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/types`, { credentials: "include" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const types = await res.json();
    typeNameToId = new Map(types.map((t) => [t.name, t.id]));
  } catch (err) {
    console.error("Failed to load types:", err);
    // Left empty — saveLocationRow's typeId resolution falls back to
    // defining a fresh type inline if this lookup comes up empty, so a
    // failure here degrades rather than blocks location-saving entirely.
  }
}

function blankLocation() {
  return { accessId: null, name: "", lat: "", lng: "", willyweatherId: null, type: "Kayak", tidal: true };
}

async function loadLocations() {
  const listEl = document.getElementById("myLocationsList");
  listEl.innerHTML = "";
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/tracked-locations`, { credentials: "include" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const tracked = await res.json();
    if (tracked.length === 0) {
      listEl.innerHTML = '<p class="footnote" style="text-align:left;">No locations yet — add one below.</p>';
    }
    // Reshaped from the API's {accessId, location:{...}, type:{...}, ...}
    // into the flatter shape this file's own UI already expects — keeps
    // addLocationRow/saveLocationRow's own logic close to what it was
    // under v1, rather than threading the nested shape through everywhere.
    tracked.forEach((row) =>
      addLocationRow({
        accessId: row.accessId,
        name: row.location.name,
        lat: row.location.lat,
        lng: row.location.lng,
        willyweatherId: row.location.willyweatherId,
        type: row.type.name,
        tidal: row.location.tidal,
      })
    );
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

  const isCreate = !loc.accessId;
  // Changing the Type dropdown on an ALREADY-SAVED location isn't a plain
  // field update — v2's access rows are keyed by (user, location, type),
  // so "change type" really means "stop tracking under the old type,
  // start under the new one". Detected here by comparing against what
  // was loaded/last-saved (loc.type), not the dropdown's own prior DOM
  // state, since loc IS the source of truth this closure keeps in sync
  // (see the field updates on `loc` below).
  const typeChanged = !isCreate && type !== loc.type;

  try {
    if (isCreate || typeChanged) {
      const typeId = typeNameToId.get(type);
      const body = { name, lat, lng, willyweatherId, tidal };
      if (typeId) body.typeId = typeId;
      else {
        // Shouldn't happen for a real account (seedDefaultTypes covers
        // both VALID_TYPES on first sign-in) — falls back to defining it
        // fresh rather than failing outright if it somehow comes up empty.
        body.newTypeName = type;
        body.newTypeBehavesLike = type;
      }
      if (!isCreate) {
        // Switching type: remove the old access row first — if the
        // create below fails, the old one is already gone, same
        // trade-off DELETE-then-recreate always has; simplest correct
        // behaviour for something this infrequent (changing a personal
        // location's type is rare, not a hot path worth extra
        // transactional care).
        await fetch(`${USER_BACKEND_URL}/api/tracked-locations/${loc.accessId}`, { method: "DELETE", credentials: "include" });
      }
      const res = await fetch(`${USER_BACKEND_URL}/api/tracked-locations`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `status ${res.status}`);
      }
      const created = await res.json();
      loc.accessId = created.accessId;
      loc.name = created.location.name;
      loc.lat = created.location.lat;
      loc.lng = created.location.lng;
      loc.willyweatherId = created.location.willyweatherId;
      loc.tidal = created.location.tidal;
      loc.type = created.type.name;
      if (!typeNameToId.has(created.type.name)) typeNameToId.set(created.type.name, created.type.id);
    } else {
      const res = await fetch(`${USER_BACKEND_URL}/api/tracked-locations/${loc.accessId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, lat, lng, willyweatherId, tidal }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `status ${res.status}`);
      }
      const updated = await res.json();
      loc.name = updated.location.name;
      loc.lat = updated.location.lat;
      loc.lng = updated.location.lng;
      loc.willyweatherId = updated.location.willyweatherId;
      loc.tidal = updated.location.tidal;
    }
    statusEl.textContent = "Saved.";
  } catch (err) {
    console.error("Failed to save location:", err);
    statusEl.textContent = `Couldn't save: ${err.message}`;
  }
}

async function deleteLocationRow(card, loc) {
  if (!loc.accessId) {
    // Never saved yet — just remove the card, nothing to delete server-side.
    card.remove();
    return;
  }
  if (!confirm(`Delete "${loc.name}"?`)) return;
  try {
    const res = await fetch(`${USER_BACKEND_URL}/api/tracked-locations/${loc.accessId}`, {
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
