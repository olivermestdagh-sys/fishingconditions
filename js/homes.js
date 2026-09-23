// homes.js
// The signed-in person's homes on the Map (normal and Live mode) — as many as they like (user_homes, the Worker's
// /api/homes). Each shows as a house pin whose popup can delete it; the toolbar's house-with-+ button (#btnAddHome)
// arms the next map click to add one there. Anything worked out from "home" uses the home closest to where the
// trip starts (nearestHome) — today that's Live's "Home By" drive from the fishing spot (map-live.js).

let myHomes = []; // [{id, lat, lng}] — the signed-in person's own
let myHomesPromise = null;
let homesMap = null; // the map the pins are on (null in Import mode, or signed out)
let homesLayer = null;
let homeAddArmed = false;

/** The signed-in person's homes, fetched once per page (or again with `force`); [] when signed out. */
function loadMyHomes(force) {
  if (typeof cachedIsSignedIn === "undefined" || !cachedIsSignedIn) {
    myHomes = [];
    return Promise.resolve(myHomes);
  }
  if (!myHomesPromise || force) {
    myHomesPromise = (async () => {
      try {
        const res = await fetch(`${USER_BACKEND_URL}/api/homes`, { credentials: "include" });
        myHomes = res.ok ? await res.json() : [];
      } catch (err) {
        console.error("Could not load your homes:", err);
        myHomes = [];
      }
      return myHomes;
    })();
  }
  return myHomesPromise;
}

/** Of `homes` (default: the loaded ones), the one closest to lat/lng as the crow flies — null when there are none. */
function nearestHome(lat, lng, homes = myHomes) {
  let best = null;
  let bestD = Infinity;
  const rad = Math.PI / 180;
  for (const h of homes || []) {
    const x = (h.lng - lng) * rad * Math.cos(((h.lat + lat) / 2) * rad);
    const y = (h.lat - lat) * rad;
    const d = x * x + y * y;
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

function addHomeMarker(home) {
  if (!homesLayer) return;
  const marker = L.marker([home.lat, home.lng], { icon: buildMapPinDivIcon("home"), zIndexOffset: 500, title: "Home" });
  marker.bindPopup(
    `<div class="home-popup">
      <div class="home-popup-title">Home</div>
      <button type="button" class="btn-secondary" data-delete-home style="color:#dc2626;">Delete home</button>
      <div class="home-popup-status" data-home-status></div>
    </div>`,
    { autoPan: true }
  );
  marker.on("popupopen", (e) => {
    const el = e.popup.getElement();
    L.DomEvent.disableClickPropagation(el);
    el.querySelector("[data-delete-home]").addEventListener("click", async (ev) => {
      L.DomEvent.stop(ev);
      const status = el.querySelector("[data-home-status]");
      status.textContent = "Deleting…";
      const res = await fetch(`${USER_BACKEND_URL}/api/homes/${encodeURIComponent(home.id)}`, { method: "DELETE", credentials: "include" }).catch(() => null);
      if (!res || (!res.ok && res.status !== 404)) {
        status.textContent = "Couldn't delete it — try again.";
        return;
      }
      myHomes = myHomes.filter((h) => h.id !== home.id);
      marker.closePopup();
      if (homesLayer) homesLayer.removeLayer(marker);
    });
  });
  marker.addTo(homesLayer);
}

/** Draws the signed-in person's homes on `map` and enables the toolbar button for it. Called whenever the Map or
 * Live map is (re)built. */
async function renderHomeMarkers(map) {
  homesMap = map;
  if (homesLayer) homesLayer.remove();
  homesLayer = L.layerGroup().addTo(map);
  setHomeAddArmed(false);
  const btn = document.getElementById("btnAddHome");
  if (btn) btn.style.display = cachedIsSignedIn ? "" : "none";
  await loadMyHomes();
  if (homesMap !== map) return; // the map was rebuilt meanwhile
  for (const home of myHomes) addHomeMarker(home);
}

/** Leaving a map (a mode switch, or Import mode): no pins to manage and nothing to add a home to. */
function detachHomes() {
  homesMap = null;
  homesLayer = null;
  setHomeAddArmed(false);
  const btn = document.getElementById("btnAddHome");
  if (btn) btn.style.display = "none";
}

function setHomeAddArmed(armed) {
  homeAddArmed = armed;
  const btn = document.getElementById("btnAddHome");
  if (btn) {
    btn.classList.toggle("active", armed);
    btn.setAttribute("aria-pressed", String(armed));
  }
  const hint = document.getElementById("homeAddHint");
  if (hint) hint.style.display = armed ? "" : "none";
  const mapEl = document.getElementById("locationMap");
  if (mapEl) mapEl.classList.toggle("map-click-armed", armed);
}

/** Wires the toolbar button: a tap arms (or cancels) "tap the map to add a home". */
function initHomesToolbar() {
  const btn = document.getElementById("btnAddHome");
  if (!btn) return;
  btn.addEventListener("click", () => setHomeAddArmed(!homeAddArmed && !!homesMap));
}

/** Called first by the map's click handler (handleMapClickForMarks, js/marks-tools.js): while armed, the click adds a
 * home there and nothing else happens. Returns whether it took the click. */
function homesConsumeMapClick(lat, lng) {
  if (!homeAddArmed || !homesMap) return false;
  setHomeAddArmed(false);
  (async () => {
    try {
      const res = await fetch(`${USER_BACKEND_URL}/api/homes`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `status ${res.status}`);
      const home = await res.json();
      myHomes = [...myHomes, home];
      addHomeMarker(home);
    } catch (err) {
      console.error("Could not add the home:", err);
      const hint = document.getElementById("homeAddHint");
      if (hint) {
        hint.textContent = `Couldn't add the home: ${err.message}`;
        hint.style.display = "";
        setTimeout(() => {
          hint.style.display = "none";
          hint.textContent = "Tap the map where your home is";
        }, 4000);
      }
    }
  })();
  return true;
}
