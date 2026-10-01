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

/**
 * The Session Start mark for a trip Action (Live mode): named "Session N Start" (the number nextSessionNumber gives), with
 * the Action's species / fishing method / berley / bait, and rod / rig / rigOptions gathered from its Rod Setups
 * (unique names, comma-joined; rigOptions = the rigs' sub-list items). `ctx` supplies what only the caller knows: id, lat,
 * lng, dateTime, createdAt, sessionGroupId, sessionNumber, water (Water Condition default) and waterDepth (the Depth default, or the last mark's). `tide` is
 * {tideCondition, tideExtreme} worked out for the time.
 */
function buildSessionStartFromAction(action, rodSetups, ctx, tide) {
  const uniq = (list) => [...new Set((list || []).filter((v) => v != null && String(v).trim() !== "").map((v) => String(v).trim()))];
  const setups = (action.rodSetupIds || []).map((rid) => (rodSetups || []).find((r) => r.id === rid)).filter(Boolean);
  const mark = {
    id: ctx.id, lat: ctx.lat, lng: ctx.lng, name: `Session ${ctx.sessionNumber} Start`, type: "Session Start",
    dateTime: ctx.dateTime, createdAt: ctx.createdAt, source: "Manual", sessionRole: "start", sessionGroupId: ctx.sessionGroupId,
  };
  const set = (key, list) => {
    if (list.length) mark[key] = list.join(", ");
  };
  set("species", uniq(action.species));
  set("fishingMethod", uniq(action.fishingMethod));
  if (action.berley) mark.berley = action.berley;
  set("bait", uniq(action.bait));
  set("rod", uniq(setups.map((s) => s.rod)));
  set("rig", uniq(setups.map((s) => s.rig)));
  set("rigOptions", uniq(setups.flatMap((s) => s.subListItems || [])));
  if (ctx.water) mark.waterCondition = ctx.water;
  if (ctx.waterDepth != null) mark.waterDepth = ctx.waterDepth;
  if (tide && tide.tideCondition) mark.tideCondition = tide.tideCondition;
  if (tide && tide.tideExtreme) mark.tideExtreme = tide.tideExtreme;
  return mark;
}

/** Species targeted by the trip's OTHER actions (not `action` itself), in order, without duplicates. */
function tdOtherTargets(actions, action) {
  const seen = new Set(action.species || []);
  const out = [];
  for (const a of tdActionsForTrip(actions, action.tripId)) {
    if (a.id === action.id) continue;
    for (const s of a.species || []) if (!seen.has(s)) (seen.add(s), out.push(s));
  }
  return out;
}

/**
 * The gear fields a Catch takes from a trip Action: berley, fishing method and bait from the Action itself, rod / rig /
 * rigOptions from the chosen Rod Setup (`setupId`, or the Action's only one). Fields with nothing to say are left off.
 */
function tdCatchFieldsFromAction(action, rodSetups, setupId) {
  const ids = tdLiveRodSetupIds(action.rodSetupIds, rodSetups);
  const setup = (rodSetups || []).find((r) => r.id === (setupId || (ids.length === 1 ? ids[0] : null)));
  const out = {};
  if (action.berley) out.berley = action.berley;
  if ((action.fishingMethod || []).length) out.fishingMethod = action.fishingMethod.join(", ");
  if ((action.bait || []).length) out.bait = action.bait.join(", ");
  if (setup) {
    if (setup.rod) out.rod = setup.rod;
    if (setup.rig) out.rig = setup.rig;
    if ((setup.subListItems || []).length) out.rigOptions = setup.subListItems.join(", ");
  }
  return out;
}

/** Whether `list` already holds `value` (case-insensitive, trimmed) — new pick-list values must not duplicate. */
function tdHasValue(list, value) {
  const v = String(value).trim().toLowerCase();
  return (list || []).some((x) => String(x).trim().toLowerCase() === v);
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

/** Public's mark lists (tagged _isPublic: read-only for a normal user) merged with the signed-in user's own — own wins on a clash. */
async function tdLoadMarkLists() {
  const [pub, own] = await Promise.all([tdApi("/api/marklists?userId=public").catch(() => []), tdApi("/api/marklists").catch(() => [])]);
  const merged = new Map();
  for (const row of pub) merged.set(`${row.field}|${row.value}`, { ...row, _isPublic: true });
  for (const row of own) merged.set(`${row.field}|${row.value}`, row);
  return Array.from(merged.values());
}

async function tdLoadAll() {
  const [trips, actions, rodSetups, lists, overrides] = await Promise.all([
    tdApi("/api/tripsetups"),
    tdApi("/api/tripactions"),
    tdApi("/api/rodsetups"),
    tdLoadMarkLists(),
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
    overrideImages: new Map(overrides.map((r) => [r.rigId, r.optionImages || {}])), // pictures on the options of your private sub lists
  };
}

// --- UI -----------------------------------------------------------------------------------------------------

const TD_GEAR_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg>';

/** Opens the hub. Returns {close}. `onClose` runs when it is closed. */
async function showTripDefaults({ onClose, start } = {}) {
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

  // `start` ({tripId, actionId}) opens straight on that Action (the Live toolbar's gear); Back from it then closes the hub.
  const direct = start && data.actions.some((a) => a.id === start.actionId) ? { name: "action", tripId: start.tripId, actionId: start.actionId } : null;
  let view = direct || { name: "trips" }; // trips | trip {tripId} | action {tripId, actionId} | rod {tripId, actionId, rodId}
  let status = "";
  let adding = null; // {kind, viewKey}: which "+ Add" pill is open as an inline text box, and on which screen
  const viewKey = () => JSON.stringify(view);
  const addingKind = () => (adding && adding.viewKey === viewKey() ? adding.kind : null);
  const close = () => {
    hideHoverImagePreview();
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

  // `thumb` ({id, version}, optional): the value's first picture, shown beside its name.
  const choice = (label, attrs, selected, thumb) =>
    `<button type="button" class="live-card-choice${selected ? " selected" : ""}${thumb ? " has-thumb" : ""}" ${attrs} aria-pressed="${!!selected}">${thumb ? `<img class="live-card-choice-thumb" src="${esc(speciesImageUrl(thumb))}" alt="" loading="lazy" />` : ""}<span>${esc(label)}</span></button>`;
  const section = (title, body, kind) =>
    `<div class="td-section"><div class="td-section-title">${esc(title)}</div><div class="td-choices">${body}${kind ? addValuePill(kind) : ""}</div></div>`;
  // A "+ Add" pill at the end of a pick-list; tapped, it becomes a text box with Add/Cancel in place.
  const addValuePill = (kind) =>
    addingKind() === kind
      ? `<span class="td-inline-add"><input type="text" class="live-card-datetime-input td-input" data-new-value maxlength="80" placeholder="New name" /><button type="button" class="live-card-choice" data-save-value="${kind}">Add</button><button type="button" class="live-card-choice" data-cancel-value>Cancel</button></span>`
      : `<button type="button" class="live-card-choice td-add-pill" data-add-value="${kind}">+ Add</button>`;
  const nameInput = (value, placeholder) =>
    `<input type="text" class="live-card-datetime-input td-input" data-name-input value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="80" />`;
  // "+ Add trip/action/rod setup": no default name — tapped, it opens a text box (Add / Cancel) to type the name.
  const addRow = (kind, buttonLabel) => `
    <div class="td-add-row">
      ${
        addingKind() === kind
          ? addValuePill(kind)
          : `<button type="button" class="live-card-choice td-add-pill" data-add-value="${kind}">${esc(buttonLabel)}</button>`
      }
    </div>`;
  // Back is the big primary button; Exit is a small pill beside it (alone, on the trips list).
  const navHtml = (backLabel) =>
    backLabel
      ? `<div class="live-card-nav td-nav">
      <button type="button" class="live-card-nav-btn live-card-next td-back-btn" data-nav="back">&larr; ${backLabel}</button>
      <button type="button" class="live-card-nav-btn td-exit-btn" data-nav="close">Exit</button>
    </div>`
      : `<div class="live-card-nav td-nav">
      <span></span>
      <button type="button" class="live-card-nav-btn td-exit-btn" data-nav="close">Exit</button>
    </div>`;

  function tripsScreen() {
    const list = data.trips.length
      ? data.trips.map((t) => choice(t.name, `data-open-trip="${esc(t.id)}"`, false)).join("")
      : `<p class="live-card-empty">No trips yet — add one below.</p>`;
    return { title: "Trip Defaults", prompt: "Pick a trip, or add a new one", body: `<div class="td-choices">${list}</div>${addRow("trip", "+ Add trip")}`, nav: navHtml(null) };
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
        ${addRow("action", "+ Add action")}
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
        ${section("Fishing method", o.fishingMethod.map((m) => choice(m, `data-method="${esc(m)}"`, a.fishingMethod.includes(m), o.thumbs.fishingMethod[m])).join("") || "", "method")}
        ${section("Berley", o.berley.map((b) => choice(b, `data-berley="${esc(b)}"`, a.berley === b, o.thumbs.berley[b])).join("") || "", "berley")}
        ${section("Bait", o.baits.map((b) => choice(b, `data-bait="${esc(b)}"`, (a.bait || []).includes(b), o.thumbs.baits[b])).join("") || "", "bait")}
        <div class="td-section"><div class="td-section-title">Rod setups</div><div class="td-pills">${pills}</div>${addRow("rodsetup", "+ Add rod setup")}</div>
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
    const subThumbs = rigOptionThumbs(rigRow, data.overrideImages);
    return {
      title: r.name,
      prompt: "Rod setup name",
      body: `${nameInput(r.name, "Rod setup name")}
        ${section("Rod", o.rods.map((v) => choice(v, `data-rod="${esc(v)}"`, r.rod === v, o.thumbs.rods[v])).join("") || "", "rod")}
        ${section("Rig", o.rigs.map((v) => choice(v, `data-rig="${esc(v)}"`, r.rig === v, o.thumbs.rigs[v])).join("") || "", "rig")}
        ${r.rig ? section(`${r.rig} options`, sub.map((v) => choice(v, `data-sub="${esc(v)}"`, r.subListItems.includes(v), subThumbs[v])).join(""), "sub") : ""}
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
    hideHoverImagePreview(); // the picture under the pointer is about to be replaced
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
    wireHoverImagePreview(overlay); // hover a choice's picture to see it large
    const newValueEl = overlay.querySelector("[data-new-value]");
    if (newValueEl) newValueEl.focus();
  }

  function goBack() {
    status = "";
    if (view.name === "action" && direct && view.actionId === direct.actionId) {
      close();
      return;
    }
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
    // Action fields
    const setAction = (patch) => attempt(() => put("/api/tripactions", data.actions, view.actionId, patch));
    on("[data-method]", (el) => setAction({ fishingMethod: tdToggle(action().fishingMethod, el.dataset.method) }));
    on("[data-bait]", (el) => setAction({ bait: tdToggle(action().bait, el.dataset.bait) }));
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

    // "+ Add" on a pick-list: open the inline box, or save what was typed under the signed-in user and select it.
    on("[data-add-value]", (el) => {
      adding = { kind: el.dataset.addValue, viewKey: viewKey() };
      render();
    });
    on("[data-cancel-value]", () => {
      adding = null;
      render();
    });
    const newValueInput = overlay.querySelector("[data-new-value]");
    const saveNewValue = () => {
      const value = newValueInput.value.trim();
      const kind = addingKind();
      adding = null;
      if (!value) return render();
      attempt(async () => {
        if (kind === "trip") {
          if (tdHasValue(data.trips.map((t) => t.name), value)) throw new Error(`You already have a trip named "${value}".`);
          const created = await tdApi("/api/tripsetups", "POST", { name: value });
          data.trips.push(created);
          data.trips.sort((x, y) => x.name.localeCompare(y.name));
          view = { name: "trip", tripId: created.id };
          return;
        }
        if (kind === "action") {
          if (tdHasValue(tdActionsForTrip(data.actions, view.tripId).map((x) => x.name), value)) throw new Error(`This trip already has an action named "${value}".`);
          const created = await tdApi("/api/tripactions", "POST", { name: value, tripId: view.tripId });
          data.actions.push(created);
          view = { name: "action", tripId: view.tripId, actionId: created.id };
          return;
        }
        if (kind === "rodsetup") {
          if (tdHasValue(data.rodSetups.map((r) => r.name), value)) throw new Error(`You already have a rod setup named "${value}".`);
          const created = await tdApi("/api/rodsetups", "POST", { name: value });
          data.rodSetups.push(created);
          data.rodSetups.sort((x, y) => x.name.localeCompare(y.name));
          // A brand-new rod setup is switched on for this action and opened straight away for its rod/rig.
          await put("/api/tripactions", data.actions, view.actionId, { rodSetupIds: [...tdLiveRodSetupIds(action().rodSetupIds, data.rodSetups), created.id] });
          view = { name: "rod", tripId: view.tripId, actionId: view.actionId, rodId: created.id };
          return;
        }
        if (kind === "sub") {
          const rigRow = data.rigRows.find((row) => row.value === rod().rig);
          if (!rigRow) throw new Error("Choose a rig first.");
          const current = tdRigSublist(rigRow, data.overrides);
          if (tdHasValue(current, value)) throw new Error(`"${value}" is already an option.`);
          const subList = [...current, value];
          if (rigRow._isPublic) {
            // Not your rig: a private sub-list layered on top of Public's, same as Settings did.
            const saved = await tdApi(`/api/rig-sublist-overrides/${rigRow.id}`, "PUT", { subList });
            data.overrides.set(rigRow.id, saved.subList);
          } else {
            Object.assign(rigRow, await tdApi(`/api/marklists/${rigRow.id}`, "PUT", { hasSublist: true, subList }));
          }
          await put("/api/rodsetups", data.rodSetups, view.rodId, { subListItems: tdToggle(rod().subListItems, value) });
          return;
        }
        const field = { method: "Fishing Method", berley: "Berley", bait: "Bait", rod: "Rod", rig: "Rig" }[kind];
        if (tdHasValue(data.lists.filter((r) => r.field === field).map((r) => r.value), value)) throw new Error(`"${value}" already exists under ${field}.`);
        const created = await tdApi("/api/marklists", "POST", { field, value });
        data.lists.push(created);
        data.options = sessionCardOptions(data.lists);
        data.rigRows = data.lists.filter((r) => r.field === "Rig");
        // The new value is picked straight away.
        if (kind === "method") await put("/api/tripactions", data.actions, view.actionId, { fishingMethod: tdToggle(action().fishingMethod, value) });
        else if (kind === "bait") await put("/api/tripactions", data.actions, view.actionId, { bait: tdToggle(action().bait, value) });
        else if (kind === "berley") await put("/api/tripactions", data.actions, view.actionId, { berley: value });
        else if (kind === "rod") await put("/api/rodsetups", data.rodSetups, view.rodId, { rod: value });
        else await put("/api/rodsetups", data.rodSetups, view.rodId, { rig: value, subListItems: [] });
      });
    };
    on("[data-save-value]", saveNewValue);
    if (newValueInput) {
      newValueInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") saveNewValue();
      });
    }

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
