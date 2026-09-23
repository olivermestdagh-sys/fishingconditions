// location-move.js
// Moving a location's pin on the Map: hold a pin for 2 seconds (wireMarkerLongPress, js/map-core.js) to pick it up —
// the cursor becomes the pin and the original fades — then click the new spot and its position is saved. Esc, or
// clicking the carried pin again, puts it down where it was. After a move there's a short "Undo".
//
// Only the location's owner or Admin (same rule as the full location editor, js/location-editor.js). The new position
// is saved through the same location save the editor uses (PUT /api/tracked-locations/:accessId {lat, lng}), so the
// Map and Week Ahead use it straight away. WillyWeather is unaffected: forecasts are fetched by the location's cached
// WillyWeather id, and the pipeline never overwrites a stored position (process_location, scripts/fetch_conditions.py).
// What does follow the pin: drive times, Home By, nearest-location matching and the Open-Meteo look-ups.

let pinMove = null; // the pin being carried: {loc, marker, iconKind, from: L.LatLng}
let pinMoveHintTimer = null;

function showPinMoveHint(html, ms) {
  const hint = document.getElementById("pinMoveHint");
  if (!hint) return;
  clearTimeout(pinMoveHintTimer);
  hint.innerHTML = html;
  hint.style.display = html ? "" : "none";
  if (html && ms) pinMoveHintTimer = setTimeout(() => showPinMoveHint(""), ms);
}

/** The pin's own picture as a CSS cursor, with its hotspot at the pin's tip (the spot it will be dropped on). */
function pinCursorCss(iconKind) {
  const svg = buildMapPinIconHtml(iconKind || "kayak").trim();
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") 17 44, crosshair`;
}

/** Whether `marker` is the pin currently being carried. */
function isCarryingPin(marker) {
  return !!pinMove && pinMove.marker === marker;
}

function endPinCarry() {
  const mapEl = document.getElementById("locationMap");
  if (mapEl) {
    mapEl.classList.remove("pin-carrying");
    mapEl.style.removeProperty("--pin-cursor");
  }
  document.removeEventListener("keydown", onPinMoveKey);
  if (pinMove) pinMove.marker.setOpacity(1);
  pinMove = null;
}

/** Puts a carried pin back down where it was, without saving anything. */
function cancelPinMove() {
  if (!pinMove) return;
  endPinCarry();
  showPinMoveHint("");
}

function onPinMoveKey(e) {
  if (e.key === "Escape") cancelPinMove();
}

/** Picks up a location's pin (called after a 2-second hold). */
function startPinMove(loc, marker, iconKind) {
  if (typeof cachedIsSignedIn === "undefined" || !cachedIsSignedIn || !(cachedIsAdmin || loc.ownerId === cachedUserId)) {
    showPinMoveHint("Only this location's owner can move its pin.", 3500);
    return;
  }
  cancelPinMove();
  pinMove = { loc, marker, iconKind, from: marker.getLatLng() };
  marker.setOpacity(0.35);
  const mapEl = document.getElementById("locationMap");
  mapEl.style.setProperty("--pin-cursor", pinCursorCss(iconKind));
  mapEl.classList.add("pin-carrying");
  document.addEventListener("keydown", onPinMoveKey);
  showPinMoveHint(`Click the new spot for <strong>${escapeHtml(displayNameFor(loc))}</strong> · Esc to cancel`);
}

/** Saves a location's position in its owner's account (the location editor's own look-up gives the access row and
 * the ?userId= for Admin editing someone else's). */
async function savePinPosition(loc, lat, lng) {
  const ctx = await locEdLoad(loc.name);
  if (!ctx || ctx.mode !== "manage" || !ctx.loc.types.length) throw new Error("only its owner can move it");
  const res = await fetch(`${USER_BACKEND_URL}/api/tracked-locations/${ctx.loc.types[0]._accessId}${ctx.param}`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat, lng }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `status ${res.status}`);
}

/** Moves the pin and every loaded entry for the location (Kayak and Land based share one place) to lat/lng. */
function placePin(loc, marker, lat, lng) {
  marker.setLatLng([lat, lng]);
  if (typeof state !== "undefined" && state.data) {
    for (const l of state.data.locations) {
      if (l.name === loc.name) {
        l.lat = lat;
        l.lng = lng;
      }
    }
  }
}

async function movePinTo(loc, marker, lat, lng, from) {
  placePin(loc, marker, lat, lng);
  showPinMoveHint(`Saving ${escapeHtml(displayNameFor(loc))}'s new position…`);
  try {
    await savePinPosition(loc, lat, lng);
  } catch (err) {
    console.error("Could not move the pin:", err);
    placePin(loc, marker, from.lat, from.lng);
    showPinMoveHint(`Couldn't move it: ${escapeHtml(err.message)}`, 6000);
    return;
  }
  showPinMoveHint(`Moved <strong>${escapeHtml(displayNameFor(loc))}</strong> · <button type="button" class="pin-move-undo">Undo</button>`, 10000);
  const undo = document.querySelector("#pinMoveHint .pin-move-undo");
  if (undo) {
    undo.addEventListener("click", async () => {
      showPinMoveHint("Putting it back…");
      placePin(loc, marker, from.lat, from.lng);
      try {
        await savePinPosition(loc, from.lat, from.lng);
        showPinMoveHint(`${escapeHtml(displayNameFor(loc))} is back where it was.`, 4000);
      } catch (err) {
        placePin(loc, marker, lat, lng);
        showPinMoveHint(`Couldn't undo it: ${escapeHtml(err.message)}`, 6000);
      }
    });
  }
}

/** Called first by the map's click handler (handleMapClickForMarks, js/marks-tools.js): while a pin is being carried,
 * the click puts it down there and nothing else happens. Returns whether it took the click. */
function locationMoveConsumeMapClick(lat, lng) {
  if (!pinMove) return false;
  const { loc, marker, from } = pinMove;
  endPinCarry();
  movePinTo(loc, marker, Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6, from);
  return true;
}
