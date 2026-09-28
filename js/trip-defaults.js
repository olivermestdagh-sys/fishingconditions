// Map > "Trip Defaults" (conditions.html, Normal mode): a full-screen hub, styled with the same `.live-card-*` look as
// Session defaults (js/live-cards.js), for managing Trips -> Actions -> Rod Setups. Data only: nothing here feeds Live mode.
//   Trips        = user_trip_setups   (/api/tripsetups)
//   Actions      = user_trip_actions  (/api/tripactions), one Trip's steps: Fishing Methods, Berley, Rod Setups, Species
//   Rod Setups   = user_rod_setups    (/api/rodsetups), shared with Settings > Trips
// Every change is saved as it is made (PUT/POST/DELETE), like Session defaults.

// --- Pure helpers (unit-tested: tests/trip-defaults.test.mjs) ----------------------------------------------

/** `list` with `value` added, or removed if it is already there. */
function tdToggle(list, value) {
  const arr = Array.isArray(list) ? list : [];
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

/** A single-choice value after tapping `value`: tapping the chosen one clears it. */
function tdToggleSingle(current, value) {
  return current === value ? null : value;
}

/** The sub-list options offered under a Rig row: its own list when it has one, otherwise the signed-in person's private
 * override on a Rig they don't own (`overrides`: Map rigId -> string[]). */
function tdRigSublist(rigRow, overrides) {
  if (!rigRow) return [];
  if (rigRow.hasSublist) return Array.isArray(rigRow.subList) ? rigRow.subList : [];
  return (overrides && overrides.get(rigRow.id)) || [];
}

/** The Actions of one Trip, oldest first. */
function tdActionsForTrip(actions, tripId) {
  return (actions || []).filter((a) => a.tripId === tripId);
}

/** Rod Setup ids that still exist (a deleted Rod Setup silently drops out of an Action's list). */
function tdLiveRodSetupIds(ids, rodSetups) {
  const known = new Set((rodSetups || []).map((r) => r.id));
  return (ids || []).filter((id) => known.has(id));
}

// --- Backend ------------------------------------------------------------------------------------------------

async function tdApi(path, method = "GET", body) {
  const res = await fetch(`${USER_BACKEND_URL}${path}`, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function tdLoadAll() {
  const [trips, actions, rodSetups, lists, overrides] = await Promise.all([
    tdApi("/api/tripsetups"),
    tdApi("/api/tripactions"),
    tdApi("/api/rodsetups"),
    fetchUnionedMarkLists().catch(() => []),
    tdApi("/api/rig-sublist-overrides").catch(() => []),
  ]);
  return {
    trips,
    actions,
    rodSetups,
    lists,
    options: sessionCardOptions(lists),
    rigRows: lists.filter((r) => r.field === "Rig"),
    overrides: new Map(overrides.map((r) => [r.rigId, r.subList])),
  };
}

// --- UI -----------------------------------------------------------------------------------------------------

const TD_GEAR_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>';

/** Opens the hub. Returns {close}. `onClose` runs when it is closed. */
async function showTripDefaults({ onClose } = {}) {
  let data;
  try {
    data = await tdLoadAll();
  } catch (err) {
    if (typeof showLiveToast === "function") showLiveToast(`Could not load trips: ${err.message}`, true);
    if (onClose) onClose();
    return { close() {} };
  }

  const overlay = document.createElement("div");
  overlay.className = "live-card-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  document.body.appendChild(overlay);
  document.body.classList.add("live-card-open");

  let view = { name: "trips" }; // trips | trip {tripId} | action {tripId, actionId} | rod {tripId, actionId, rodId}
  let status = "";
  const close = () => {
    overlay.remove();
    document.body.classList.remove("live-card-open");
    if (onClose) onClose();
  };

  const esc = escapeHtml;
  const trip = () => data.trips.find((t) => t.id === view.tripId);
  const action = () => data.actions.find((a) => a.id === view.actionId);
  const rod = () => data.rodSetups.find((r) => r.id === view.rodId);

  // Runs a save; on failure shows the message and re-renders so the field snaps back to what is really stored.
  async function attempt(fn) {
    status = "";
    try {
      await fn();
    } catch (err) {
      status = err.message;
    }
    render();
  }

  const choice = (label, attrs, selected) =>
    `<button type="button" class="live-card-choice${selected ? " selected" : ""}" ${attrs} aria-pressed="${!!selected}"><span>${esc(label)}</span></button>`;
  const section = (title, body) => `<div class="td-section"><div class="td-section-title">${esc(title)}</div><div class="td-choices">${body}</div></div>`;
  const nameInput = (value, placeholder) =>
    `<input type="text" class="live-card-datetime-input td-input" data-name-input value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="80" />`;
  const addRow = (placeholder, buttonLabel) => `
    <div class="td-add-row">
      <input type="text" class="live-card-datetime-input td-input" data-add-input placeholder="${esc(placeholder)}" maxlength="80" />
      <button type="button" class="live-card-nav-btn td-add-btn" data-add>${esc(buttonLabel)}</button>
    </div>`;
  const navHtml = (backLabel) =>
    backLabel
      ? `<div class="live-card-nav live-card-nav-2">
      <button type="button" class="live-card-nav-btn" data-nav="back">${backLabel}</button>
      <button type="button" class="live-card-nav-btn live-card-next" data-nav="close">Done</button>
    </div>`
      : `<div class="live-card-nav live-card-nav-1">
      <button type="button" class="live-card-nav-btn live-card-next" data-nav="close">Close</button>
    </div>`;

  function tripsScreen() {
    const list = data.trips.length
      ? data.trips.map((t) => choice(t.name, `data-open-trip="${esc(t.id)}"`, false)).join("")
      : `<p class="live-card-empty">No trips yet — add one below.</p>`;
    return { title: "Trip Defaults", prompt: "Pick a trip, or add a new one", body: `<div class="td-choices">${list}</div>${addRow("New trip name", "Add trip")}`, nav: navHtml(null) };
  }

  function tripScreen() {
    const t = trip();
    const acts = tdActionsForTrip(data.actions, t.id);
    const list = acts.length
      ? acts.map((a) => choice(a.name, `data-open-action="${esc(a.id)}"`, false)).join("")
      : `<p class="live-card-empty">No actions yet — add one below.</p>`;
    return {
      title: t.name,
      prompt: "Trip name",
      body: `${nameInput(t.name, "Trip name")}
        <div class="td-section-title">Actions</div><div class="td-choices">${list}</div>
        ${addRow("New action name", "Add action")}
        ${confirmDeleteHtml("Delete this trip and its actions")}`,
      nav: navHtml("Back"),
    };
  }

  function rodSetupPill(r, selected) {
    return `<div class="td-pill${selected ? " selected" : ""}">
      <button type="button" class="td-pill-main" data-toggle-rodsetup="${esc(r.id)}" aria-pressed="${selected}">${esc(r.name)}</button>
      <button type="button" class="td-pill-gear" data-edit-rodsetup="${esc(r.id)}" aria-label="Edit ${esc(r.name)}" title="Edit rod setup">${TD_GEAR_SVG}</button>
    </div>`;
  }

  function actionScreen() {
    const a = action();
    const o = data.options;
    const ids = tdLiveRodSetupIds(a.rodSetupIds, data.rodSetups);
    const pills = data.rodSetups.length ? data.rodSetups.map((r) => rodSetupPill(r, ids.includes(r.id))).join("") : `<p class="live-card-empty">No rod setups yet.</p>`;
    return {
      title: a.name,
      prompt: "Action name",
      body: `${nameInput(a.name, "Action name")}
        ${section("Fishing method", o.fishingMethod.map((m) => choice(m, `data-method="${esc(m)}"`, a.fishingMethod.includes(m))).join("") || `<p class="live-card-empty">Nothing to choose yet.</p>`)}
        ${section("Berley", o.berley.map((b) => choice(b, `data-berley="${esc(b)}"`, a.berley === b)).join("") || `<p class="live-card-empty">Nothing to choose yet.</p>`)}
        <div class="td-section"><div class="td-section-title">Rod setups</div><div class="td-pills">${pills}</div>${addRow("New rod setup name", "Add rod setup")}</div>
        ${section("Species", o.species.map((s) => choice(s, `data-species="${esc(s)}"`, a.species.includes(s))).join("") || `<p class="live-card-empty">Nothing to choose yet.</p>`)}
        ${confirmDeleteHtml("Delete this action")}`,
      nav: navHtml("Back"),
    };
  }

  function rodScreen() {
    const r = rod();
    const o = data.options;
    const rigRow = data.rigRows.find((row) => row.value === r.rig);
    const sub = tdRigSublist(rigRow, data.overrides);
    return {
      title: r.name,
      prompt: "Rod setup name",
      body: `${nameInput(r.name, "Rod setup name")}
        ${section("Rod", o.rods.map((v) => choice(v, `data-rod="${esc(v)}"`, r.rod === v)).join("") || `<p class="live-card-empty">Nothing to choose yet.</p>`)}
        ${section("Rig", o.rigs.map((v) => choice(v, `data-rig="${esc(v)}"`, r.rig === v)).join("") || `<p class="live-card-empty">Nothing to choose yet.</p>`)}
        ${sub.length ? section(`${r.rig} options`, sub.map((v) => choice(v, `data-sub="${esc(v)}"`, r.subListItems.includes(v))).join("")) : ""}
        ${confirmDeleteHtml("Delete this rod setup")}`,
      nav: navHtml("Back"),
    };
  }

  // A two-tap delete: the first tap reveals a red confirm button, the second does it.
  function confirmDeleteHtml(label) {
    return `<div class="td-delete"><button type="button" class="live-card-nav-btn td-delete-btn" data-delete>${esc(label)}</button>
      <button type="button" class="live-card-nav-btn td-delete-btn td-delete-yes" data-delete-yes hidden>Yes, delete</button></div>`;
  }

  function render() {
    const scroll = overlay.querySelector(".live-card-grid");
    const scrollTop = scroll ? scroll.scrollTop : 0;
    const screen = view.name === "trips" ? tripsScreen() : view.name === "trip" ? tripScreen() : view.name === "action" ? actionScreen() : rodScreen();
    overlay.innerHTML = `
      <div class="live-card">
        <div class="live-card-head">
          <h2 class="live-card-title">${esc(screen.title)}</h2>
          <p class="live-card-prompt">${esc(screen.prompt)}</p>
          ${status ? `<p class="live-card-hint">${esc(status)}</p>` : ""}
        </div>
        <div class="live-card-grid td-grid">${screen.body}</div>
        ${screen.nav}
      </div>`;
    overlay.querySelector(".live-card-grid").scrollTop = scrollTop;
    wire();
  }

  function goBack() {
    status = "";
    if (view.name === "rod") view = { name: "action", tripId: view.tripId, actionId: view.actionId };
    else if (view.name === "action") view = { name: "trip", tripId: view.tripId };
    else view = { name: "trips" };
    render();
  }

  function wire() {
    const on = (selector, handler) => overlay.querySelectorAll(selector).forEach((el) => el.addEventListener("click", () => handler(el)));
    const put = async (path, list, id, patch) => {
      const saved = await tdApi(`${path}/${id}`, "PUT", patch);
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) list[i] = saved;
    };

    on('[data-nav="close"]', close);
    on('[data-nav="back"]', goBack);

    // Trips list / trip screen
    on("[data-open-trip]", (el) => {
      status = "";
      view = { name: "trip", tripId: el.dataset.openTrip };
      render();
    });
    on("[data-open-action]", (el) => {
      status = "";
      view = { name: "action", tripId: view.tripId, actionId: el.dataset.openAction };
      render();
    });

    // Rename (saved when the field loses focus or Enter is pressed)
    const nameEl = overlay.querySelector("[data-name-input]");
    if (nameEl) {
      nameEl.addEventListener("change", () => {
        const name = nameEl.value.trim();
        if (!name) return render();
        if (view.name === "trip") attempt(() => put("/api/tripsetups", data.trips, view.tripId, { name }));
        else if (view.name === "action") attempt(() => put("/api/tripactions", data.actions, view.actionId, { name }));
        else attempt(() => put("/api/rodsetups", data.rodSetups, view.rodId, { name }));
      });
    }

    // Add (trip / action / rod setup, depending on the screen)
    const addInput = overlay.querySelector("[data-add-input]");
    const doAdd = () => {
      const name = addInput.value.trim();
      if (!name) return;
      if (view.name === "trips") {
        attempt(async () => {
          const created = await tdApi("/api/tripsetups", "POST", { name });
          data.trips.push(created);
          data.trips.sort((a, b) => a.name.localeCompare(b.name));
          view = { name: "trip", tripId: created.id };
        });
      } else if (view.name === "trip") {
        attempt(async () => {
          const created = await tdApi("/api/tripactions", "POST", { name, tripId: view.tripId });
          data.actions.push(created);
          view = { name: "action", tripId: view.tripId, actionId: created.id };
        });
      } else if (view.name === "action") {
        attempt(async () => {
          const created = await tdApi("/api/rodsetups", "POST", { name });
          data.rodSetups.push(created);
          data.rodSetups.sort((a, b) => a.name.localeCompare(b.name));
          // A brand-new rod setup is switched on for this action and opened straight away for its rod/rig.
          await put("/api/tripactions", data.actions, view.actionId, { rodSetupIds: [...tdLiveRodSetupIds(action().rodSetupIds, data.rodSetups), created.id] });
          view = { name: "rod", tripId: view.tripId, actionId: view.actionId, rodId: created.id };
        });
      }
    };
    if (addInput) {
      overlay.querySelector("[data-add]").addEventListener("click", doAdd);
      addInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doAdd();
      });
    }

    // Action fields
    const setAction = (patch) => attempt(() => put("/api/tripactions", data.actions, view.actionId, patch));
    on("[data-method]", (el) => setAction({ fishingMethod: tdToggle(action().fishingMethod, el.dataset.method) }));
    on("[data-berley]", (el) => setAction({ berley: tdToggleSingle(action().berley, el.dataset.berley) }));
    on("[data-species]", (el) => setAction({ species: tdToggle(action().species, el.dataset.species) }));
    on("[data-toggle-rodsetup]", (el) => setAction({ rodSetupIds: tdToggle(tdLiveRodSetupIds(action().rodSetupIds, data.rodSetups), el.dataset.toggleRodsetup) }));
    on("[data-edit-rodsetup]", (el) => {
      status = "";
      view = { name: "rod", tripId: view.tripId, actionId: view.actionId, rodId: el.dataset.editRodsetup };
      render();
    });

    // Rod setup fields (choosing a different rig clears the sub-list picks, same as Settings)
    const setRod = (patch) => attempt(() => put("/api/rodsetups", data.rodSetups, view.rodId, patch));
    on("[data-rod]", (el) => setRod({ rod: tdToggleSingle(rod().rod, el.dataset.rod) }));
    on("[data-rig]", (el) => setRod({ rig: tdToggleSingle(rod().rig, el.dataset.rig), subListItems: [] }));
    on("[data-sub]", (el) => setRod({ subListItems: tdToggle(rod().subListItems, el.dataset.sub) }));

    // Delete (two taps)
    on("[data-delete]", (el) => {
      el.hidden = true;
      overlay.querySelector("[data-delete-yes]").hidden = false;
    });
    on("[data-delete-yes]", () => {
      if (view.name === "trip") {
        const id = view.tripId;
        attempt(async () => {
          await tdApi(`/api/tripsetups/${id}`, "DELETE");
          data.trips = data.trips.filter((t) => t.id !== id);
          data.actions = data.actions.filter((a) => a.tripId !== id);
          view = { name: "trips" };
        });
      } else if (view.name === "action") {
        const id = view.actionId;
        attempt(async () => {
          await tdApi(`/api/tripactions/${id}`, "DELETE");
          data.actions = data.actions.filter((a) => a.id !== id);
          view = { name: "trip", tripId: view.tripId };
        });
      } else if (view.name === "rod") {
        const id = view.rodId;
        attempt(async () => {
          await tdApi(`/api/rodsetups/${id}`, "DELETE");
          data.rodSetups = data.rodSetups.filter((r) => r.id !== id);
          view = { name: "action", tripId: view.tripId, actionId: view.actionId };
        });
      }
    });
  }

  render();
  return { close };
}
