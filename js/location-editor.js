// location-editor.js
// The Map page's location editor: the gear after a location's name on its graph opens a dialog, styled like the
// map's filter dialog (collapsible sections, pills), for every field the Settings page's Locations editor
// (locationsadmin.js) can change — display name, WillyWeather search name, shore, groups, tides, tide offset, the
// types it's usable for, and each type's timings / minimum tide height. Edits save straight away through the same
// Worker endpoints Settings uses (typing is debounced), then `onChanged` lets the page re-read the live config.
//
// Anyone signed in gets the gear. The location's owner, or Admin, edit the location itself in the owner's account
// (?userId=<owner> for Admin editing someone else's), and can remove it; Admin can also hand it to another account
// (Owner — PUT /api/admin/locations/:id/owner). Anyone else edits "My times": their own Set up / Pack up / Time to
// Spot / Time From Spot / minimum tide height for it, kept as their own entry for the location (created on their
// first change) and shown only to them (applyMyLocationTimings, js/chart-render.js).

// Which sections are open — kept across openings, like the filter dialog's.
const locEdOpenGroups = new Set();

// Timings are stored as "HH:MM" (what Week Ahead's timeToMinutes and the pipeline read) but edited as a single
// number of minutes — the hours were hardly ever used. 0-1439, the most "HH:MM" holds within a day.
function locEdHmToMinutes(value) {
  const m = String(value || "").match(/^(\d{1,2}):(\d{1,2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}
function locEdMinutesToHm(minutes) {
  const total = Math.min(1439, Math.max(0, Math.floor(Number(minutes) || 0)));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** "Public" or the account's name, for an owner id. */
function locEdOwnerLabel(ownerId) {
  if (ownerId === "public") return "Public";
  const u = cachedAdminUsers.find((x) => x.id === ownerId);
  return u ? u.name || u.email || ownerId : ownerId;
}

/** Loads the Map location whose search name is `name`, in the Settings page's shape (place fields, groups, one
 * entry per type with its access-row id and timings) plus the account's type and group vocabularies. `mode`:
 * "manage" for its owner or Admin (the owner's own entries), "mine" for anyone else (their own entries where they
 * have them, the owner's values otherwise). Null when the location isn't found. */
async function locEdLoad(name) {
  const liveRes = await fetch(`${USER_BACKEND_URL}/api/public/locations?_=${Date.now()}`, { cache: "no-store" });
  if (!liveRes.ok) throw new Error(`locations status ${liveRes.status}`);
  const live = (await liveRes.json()).find((l) => l.name === name);
  if (!live) return null;
  const ownerId = live.ownerId;
  const typeOf = (r) => ({
    _accessId: r.accessId,
    _typeId: r.type.id,
    type: r.type.name,
    behavesLike: r.type.behavesLike,
    driveTo: r.driveTo,
    driveBack: r.driveBack,
    setUp: r.setUp,
    packUp: r.packUp,
    timeToSpot: r.timeToSpot,
    timeFromSpot: r.timeFromSpot,
    minTideHeight: r.minTideHeight,
  });

  if (cachedIsAdmin || ownerId === cachedUserId) {
    if (cachedIsAdmin && typeof fetchAdminUsersList === "function" && !cachedAdminUsers.length) await fetchAdminUsersList();
    const param = ownerId === cachedUserId ? "" : `?userId=${encodeURIComponent(ownerId)}`;
    const [rowsRes, typesRes, groupsRes] = await Promise.all([
      fetch(`${USER_BACKEND_URL}/api/tracked-locations${param}`, { credentials: "include" }),
      fetch(`${USER_BACKEND_URL}/api/types${param}`, { credentials: "include" }),
      fetch(`${USER_BACKEND_URL}/api/groups${param}`, { credentials: "include" }),
    ]);
    for (const r of [rowsRes, typesRes, groupsRes]) if (!r.ok) throw new Error(`status ${r.status}`);
    const rows = (await rowsRes.json()).filter((r) => r.location.id === live.id);
    if (!rows.length) return null;
    const p = rows[0].location;
    return {
      mode: "manage",
      param,
      ownerId,
      types: await typesRes.json(),
      groups: await groupsRes.json(),
      loc: {
        _id: p.id,
        name: p.name,
        displayName: p.displayName,
        shore: p.shore,
        tidal: p.tidal,
        tideOffset: p.tideOffset,
        locationGroups: rows[0].groups.map((g) => g.name),
        types: rows.map(typeOf),
      },
    };
  }

  // "My times": the owner's types, each with this person's own entry where they have one.
  const [rowsRes, typesRes] = await Promise.all([
    fetch(`${USER_BACKEND_URL}/api/tracked-locations`, { credentials: "include" }),
    fetch(`${USER_BACKEND_URL}/api/types`, { credentials: "include" }),
  ]);
  for (const r of [rowsRes, typesRes]) if (!r.ok) throw new Error(`status ${r.status}`);
  const mine = (await rowsRes.json()).filter((r) => r.location.id === live.id);
  return {
    mode: "mine",
    param: "",
    ownerId,
    types: await typesRes.json(), // this person's own type vocabulary — their entry uses their type of the same name
    groups: [],
    loc: {
      _id: live.id,
      name: live.name,
      displayName: live.displayName,
      types: (live.types || []).map((ot) => {
        const my = mine.find((r) => r.type.name === ot.type);
        const ownerValues = { setUp: ot.setUp, packUp: ot.packUp, timeToSpot: ot.timeToSpot, timeFromSpot: ot.timeFromSpot, minTideHeight: ot.minTideHeight };
        return my ? { ...typeOf(my), _ownerValues: ownerValues } : { _accessId: null, type: ot.type, behavesLike: ot.behavesLike, ...ownerValues, _ownerValues: ownerValues };
      }),
    },
  };
}

/**
 * Opens the editor for the Map location whose WillyWeather search name is `name`. `onChanged` runs after every
 * successful save (the Map uses it to re-merge the live location config and redraw the graph); `onRemoved` after the
 * location is removed.
 */
async function openLocationEditor(name, { onChanged, onRemoved } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "ww-candidate-overlay";
  overlay.innerHTML = `
    <div class="ww-candidate-dialog loc-editor">
      <button type="button" class="ww-candidate-close" aria-label="Close">&times;</button>
      <h3 style="margin:0 0 8px;" data-loced-title>Edit location</h3>
      <div data-loced-body><p class="footnote" style="margin:0;">Loading…</p></div>
      <div data-loced-status class="loc-editor-status"></div>
      <button type="button" class="btn-primary" data-loced-done style="width:100%;margin-top:8px;">Done</button>
    </div>`;
  document.body.appendChild(overlay);
  const bodyEl = overlay.querySelector("[data-loced-body]");
  const statusEl = overlay.querySelector("[data-loced-status]");
  const setStatus = (text, isError) => {
    statusEl.textContent = text;
    statusEl.style.color = isError ? "#dc2626" : "var(--grey-500)";
  };

  // Debounced saves (typing), flushed when the dialog closes so nothing typed is lost.
  const timers = new Map();
  const pending = new Map();
  const debounce = (key, fn) => {
    clearTimeout(timers.get(key));
    pending.set(key, fn);
    timers.set(
      key,
      setTimeout(() => {
        pending.delete(key);
        fn();
      }, 600)
    );
  };
  const close = () => {
    for (const [key, fn] of pending) {
      clearTimeout(timers.get(key));
      fn();
    }
    pending.clear();
    overlay.remove();
  };
  overlay.querySelector(".ww-candidate-close").addEventListener("click", close);
  overlay.querySelector("[data-loced-done]").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  let ctx;
  try {
    ctx = await locEdLoad(name);
  } catch (err) {
    console.error("Could not load the location:", err);
    bodyEl.innerHTML = `<p class="footnote" style="margin:0;color:#dc2626;">Couldn't load this location: ${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!ctx) {
    bodyEl.innerHTML = `<p class="footnote" style="margin:0;">This location couldn't be found — it may have just been removed.</p>`;
    return;
  }
  const mineMode = ctx.mode === "mine";
  if (mineMode) overlay.querySelector("[data-loced-title]").textContent = "My times";
  let { loc, param } = ctx; // replaced when the Owner changes (see the owner pills below)

  async function send(url, method, body) {
    const res = await fetch(`${USER_BACKEND_URL}${url}${param}`, {
      method,
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `status ${res.status}`);
    }
    return res.status === 204 ? null : res.json().catch(() => null);
  }
  async function saved(promise, what) {
    try {
      setStatus("Saving…");
      await promise;
      setStatus("Saved.");
      if (onChanged) onChanged();
      return true;
    } catch (err) {
      console.error(`Failed to save ${what}:`, err);
      setStatus(`Couldn't save ${what}: ${err.message}`, true);
      return false;
    }
  }
  const savePlace = () =>
    saved(
      send(`/api/tracked-locations/${loc.types[0]._accessId}`, "PUT", {
        name: loc.name,
        displayName: loc.displayName,
        shore: loc.shore,
        tideOffset: loc.tideOffset,
        tidal: loc.tidal !== false,
      }),
      "the location"
    );
  const saveType = (t) => (mineMode ? saveMyType(t) : saveOwnerType(t));
  function saveMyType(t) {
    const timings = { driveTo: "00:00", driveBack: "00:00", setUp: t.setUp, packUp: t.packUp, timeToSpot: t.timeToSpot, timeFromSpot: t.timeFromSpot, minTideHeight: t.minTideHeight };
    if (t._accessId) return saved(send(`/api/tracked-locations/${t._accessId}`, "PUT", timings), `your ${t.type} times`);
    // Their type of the same name, or a new one in their account (same name and scoring).
    const myType = ctx.types.find((x) => x.name === t.type);
    const body = { locationId: loc._id, ...timings, ...(myType ? { typeId: myType.id } : { newTypeName: t.type, newTypeBehavesLike: t.behavesLike }) };
    t._creating =
      t._creating ||
      (async () => {
        let created = null;
        const ok = await saved(
          send("/api/tracked-locations", "POST", body).then((r) => (created = r)),
          `your ${t.type} times`
        );
        if (ok && created) {
          t._accessId = created.accessId;
          if (!myType) ctx.types.push({ id: created.type.id, name: created.type.name, behavesLike: created.type.behavesLike });
          renderKeepingFocus();
        }
        t._creating = null;
      })();
    return t._creating;
  }
  const saveOwnerType = (t) =>
    saved(
      send(`/api/tracked-locations/${t._accessId}`, "PUT", {
        driveTo: t.driveTo,
        driveBack: t.driveBack,
        setUp: t.setUp,
        packUp: t.packUp,
        timeToSpot: t.timeToSpot,
        timeFromSpot: t.timeFromSpot,
        minTideHeight: t.minTideHeight,
      }),
      `the ${t.type} timings`
    );
  const saveGroups = () => {
    const ids = loc.locationGroups.map((g) => (ctx.groups.find((x) => x.name === g) || {}).id).filter(Boolean);
    return saved(send(`/api/locations/${loc._id}/groups`, "PUT", { groupIds: ids }), "the groups");
  };
  async function reloadTypes() {
    const fresh = await locEdLoad(loc.name);
    if (fresh) {
      ctx.types = fresh.types;
      loc.types = fresh.loc.types;
    }
  }

  // --- rendering -----------------------------------------------------------------------------------------------
  const pill = (attr, value, label, on) =>
    `<span class="loc-chip mark-pill${on ? " is-on" : ""}" ${attr}="${escapeHtml(value)}" role="button" aria-pressed="${on}">${escapeHtml(label)}</span>`;
  const summaryChips = (items) => items.map((t) => `<span class="loc-chip mark-edit-summary-chip">${escapeHtml(t)}</span>`).join("");
  function group(key, label, summary, bodyHtml) {
    const open = locEdOpenGroups.has(key);
    return `
      <div class="mark-edit-group" data-loced-group="${key}">
        <button type="button" class="mark-edit-group-head" data-loced-toggle="${key}" aria-expanded="${open}">
          <span class="mark-edit-caret" aria-hidden="true">▾</span>
          <span class="mark-edit-group-label">${escapeHtml(label)}</span>
          <span class="mark-edit-summary">${summaryChips(summary)}</span>
        </button>
        <div class="mark-edit-group-body"${open ? "" : " hidden"}>${bodyHtml}</div>
      </div>`;
  }
  function typeSection(t, i) {
    const fields = TYPE_TIME_FIELDS[t.type] || TYPE_TIME_FIELDS[t.behavesLike] || [];
    const summary = fields.map((f) => `${f.label} ${locEdHmToMinutes(t[f.key])} min`);
    if (t.behavesLike === "Kayak" && t.minTideHeight != null) summary.push(`Min tide ${t.minTideHeight} m`);
    const body =
      `<div class="loc-editor-hm-grid">${fields
        .map(
          (f) => `<label class="mark-edit-field">${escapeHtml(f.label)} (min)
            <input type="number" min="0" max="1439" step="1" inputmode="numeric" data-loced-min="${i}:${f.key}" value="${locEdHmToMinutes(t[f.key])}" style="${MARK_POPUP_INPUT_STYLE}" /></label>`
        )
        .join("")}</div>` +
      (t.behavesLike === "Kayak"
        ? `<label class="mark-edit-field">Minimum tide height for access (m) — blank if not applicable
            <input type="number" min="0" step="0.1" inputmode="decimal" data-loced-mintide="${i}" value="${t.minTideHeight != null ? t.minTideHeight : ""}" placeholder="e.g. 1.2" style="${MARK_POPUP_INPUT_STYLE}" /></label>`
        : "");
    const mineNote = mineMode
      ? t._accessId
        ? `<p class="footnote" style="margin:8px 0 0;text-align:left;">These are your own times.
             <button type="button" class="btn-secondary" data-loced-reset="${i}" style="padding:2px 8px;font-size:0.75rem;">Use ${escapeHtml(locEdOwnerLabel(ctx.ownerId))}'s times</button></p>`
        : `<p class="footnote" style="margin:8px 0 0;text-align:left;">Showing ${escapeHtml(locEdOwnerLabel(ctx.ownerId))}'s times — change any to keep your own.</p>`
      : "";
    return group(`type:${t.type}`, `${t.type} timings`, summary, body + mineNote);
  }
  function render() {
    if (mineMode) {
      bodyEl.innerHTML = `
        <p class="footnote" style="margin:0 0 8px;text-align:left;">${escapeHtml(loc.displayName || loc.name)} belongs to ${escapeHtml(locEdOwnerLabel(ctx.ownerId))}. Your own times for it apply only to you, on the Map and Week Ahead, and save as you make them.</p>
        <div class="mark-edit-groups">${loc.types.map(typeSection).join("")}</div>`;
      return;
    }
    const activeTypeIds = loc.types.map((t) => t._typeId);
    const groupNames = ctx.groups.map((g) => g.name);
    bodyEl.innerHTML = `
      <p class="footnote" style="margin:0 0 8px;text-align:left;">Changes save as you make them.</p>
      <label class="mark-edit-field" style="margin-top:0;">Display name
        <input type="text" data-loced-text="displayName" value="${escapeHtml(loc.displayName || "")}" style="${MARK_POPUP_INPUT_STYLE}" /></label>
      <label class="mark-edit-field">WillyWeather search name
        <input type="text" data-loced-text="name" value="${escapeHtml(loc.name || "")}" style="${MARK_POPUP_INPUT_STYLE}" /></label>
      <p class="footnote" style="margin:2px 0 8px;text-align:left;">Changing the search name links the location to a different WillyWeather place from the next data refresh.</p>
      <div class="mark-edit-groups">
        ${!cachedIsAdmin ? "" : group(
          "owner",
          "Owner",
          [locEdOwnerLabel(ctx.ownerId)],
          `<div class="mark-pill-row">${["public", ...cachedAdminUsers.map((u) => u.id)]
            .map((id) => pill("data-loced-owner", id, id === "public" ? "Public (shared)" : locEdOwnerLabel(id), id === ctx.ownerId))
            .join("")}</div>
           <p class="footnote" style="margin:6px 0 0;text-align:left;">Everyone sees Public's locations plus their own on the Map and Week Ahead — never another account's. Its types and groups move with it.</p>`
        )}
        ${group("shore", "Shore faces", loc.shore ? [loc.shore] : [], `<div class="mark-pill-row">${SHORE_OPTIONS.map((s) => pill("data-loced-shore", s, s, loc.shore === s)).join("")}</div>`)}
        ${group(
          "groups",
          "Location Groups",
          loc.locationGroups,
          groupNames.length
            ? `<div class="mark-pill-row">${groupNames.map((g) => pill("data-loced-group-pill", g, g, loc.locationGroups.includes(g))).join("")}</div>`
            : `<p class="footnote" style="margin:0;text-align:left;">No groups yet — add them on the Settings page.</p>`
        )}
        ${group(
          "tides",
          "Tides",
          [loc.tidal === false ? "Not tidal" : "Tidal", ...(loc.tideOffset != null && loc.tideOffset !== "" ? [`Offset ${loc.tideOffset} min`] : [])],
          `<div class="mark-edit-field" style="margin-top:0;">Affected by tides</div>
           <div class="mark-pill-row">${pill("data-loced-tidal", "yes", "Yes", loc.tidal !== false)}${pill("data-loced-tidal", "no", "No", loc.tidal === false)}</div>
           <label class="mark-edit-field">Tide offset (min)
             <input type="number" step="1" inputmode="numeric" data-loced-tideoffset value="${loc.tideOffset != null ? loc.tideOffset : ""}" placeholder="0"
               title="Positive: this location's tide runs later than the matched station. Negative: earlier." style="${MARK_POPUP_INPUT_STYLE}" /></label>`
        )}
        ${group(
          "types",
          "Usable for",
          loc.types.map((t) => t.type),
          `<div class="mark-pill-row">${ctx.types.map((t) => pill("data-loced-type", t.id, `${t.name}`, activeTypeIds.includes(t.id))).join("")}</div>
           <div class="mark-edit-field">Define a new type</div>
           <div class="loc-editor-newtype">
             <input type="text" data-loced-newtype-name placeholder="Name, e.g. SUP" style="${MARK_POPUP_INPUT_STYLE}" />
             <div class="mark-pill-row">${pill("data-loced-newtype-like", "Kayak", "Scores like Kayak", true)}${pill("data-loced-newtype-like", "Land based", "Scores like Land based", false)}</div>
             <button type="button" class="btn-secondary" data-loced-newtype-add style="padding:4px 10px;font-size:0.8rem;">Add type</button>
           </div>`
        )}
        ${loc.types.map(typeSection).join("")}
      </div>
      <div class="loc-editor-remove">
        <button type="button" class="btn-secondary" data-loced-remove style="color:#dc2626;">Remove location</button>
        <div data-loced-remove-confirm hidden class="loc-editor-remove-confirm">
          <div>Remove ${escapeHtml(loc.displayName || loc.name)} and everyone's timings for it? This can't be undone.</div>
          <button type="button" class="btn-secondary" data-loced-remove-yes style="background:#dc2626;color:#fff;border-color:#dc2626;">Yes, remove</button>
          <button type="button" class="btn-secondary" data-loced-remove-cancel>Cancel</button>
        </div>
      </div>`;
  }
  render();

  /** render(), then put the cursor back in the box that was being typed in (matched by its data attribute). */
  function renderKeepingFocus() {
    const active = document.activeElement;
    const attr = active && bodyEl.contains(active) ? ["data-loced-min", "data-loced-mintide"].find((a) => active.hasAttribute(a)) : null;
    const value = attr && active.getAttribute(attr);
    render();
    if (!attr) return;
    const again = bodyEl.querySelector(`[${attr}="${value}"]`);
    if (again) again.focus();
  }

  // --- interaction ---------------------------------------------------------------------------------------------
  bodyEl.addEventListener("click", async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const toggle = t.closest("[data-loced-toggle]");
    if (toggle) {
      const key = toggle.dataset.locedToggle;
      const open = toggle.getAttribute("aria-expanded") !== "true";
      if (open) locEdOpenGroups.add(key);
      else locEdOpenGroups.delete(key);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.nextElementSibling.hidden = !open;
      return;
    }
    const reset = t.closest("[data-loced-reset]");
    if (reset) {
      const type = loc.types[Number(reset.dataset.locedReset)];
      clearTimeout(timers.get(`type:${reset.dataset.locedReset}`));
      pending.delete(`type:${reset.dataset.locedReset}`);
      if (await saved(send(`/api/tracked-locations/${type._accessId}`, "DELETE"), `your ${type.type} times`)) {
        Object.assign(type, type._ownerValues, { _accessId: null });
        render();
      }
      return;
    }
    if (t.closest("[data-loced-remove]")) {
      bodyEl.querySelector("[data-loced-remove-confirm]").hidden = false;
      return;
    }
    if (t.closest("[data-loced-remove-cancel]")) {
      bodyEl.querySelector("[data-loced-remove-confirm]").hidden = true;
      return;
    }
    if (t.closest("[data-loced-remove-yes]")) {
      for (const key of pending.keys()) clearTimeout(timers.get(key));
      pending.clear(); // nothing left to save to
      setStatus("Removing…");
      const res = await fetch(`${USER_BACKEND_URL}/api/locations/${loc._id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok && res.status !== 404) {
        setStatus(`Couldn't remove it: ${(await res.json().catch(() => ({}))).error || `status ${res.status}`}`, true);
        return;
      }
      overlay.remove();
      if (onRemoved) onRemoved();
      return;
    }
    const ownerPill = t.closest("[data-loced-owner]");
    if (ownerPill) {
      const target = ownerPill.dataset.locedOwner;
      if (target === ctx.ownerId) return; // one is always chosen
      const ok = await saved(
        fetch(`${USER_BACKEND_URL}/api/admin/locations/${loc._id}/owner`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ownerUserId: target }),
        }).then(async (res) => {
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `status ${res.status}`);
        }),
        "the owner"
      );
      if (!ok) return;
      const fresh = await locEdLoad(loc.name);
      if (fresh) {
        Object.assign(ctx, fresh);
        loc = fresh.loc;
        param = fresh.param;
      }
      render();
      setStatus(`Moved to ${locEdOwnerLabel(ctx.ownerId)}.`);
      return;
    }
    const shore = t.closest("[data-loced-shore]");
    if (shore) {
      if (loc.shore === shore.dataset.locedShore) return; // one is always chosen
      loc.shore = shore.dataset.locedShore;
      render();
      savePlace();
      return;
    }
    const groupPill = t.closest("[data-loced-group-pill]");
    if (groupPill) {
      const g = groupPill.dataset.locedGroupPill;
      loc.locationGroups = loc.locationGroups.includes(g) ? loc.locationGroups.filter((x) => x !== g) : [...loc.locationGroups, g];
      render();
      saveGroups();
      return;
    }
    const tidal = t.closest("[data-loced-tidal]");
    if (tidal) {
      const next = tidal.dataset.locedTidal === "yes";
      if ((loc.tidal !== false) === next) return;
      loc.tidal = next;
      render();
      savePlace();
      return;
    }
    const typePill = t.closest("[data-loced-type]");
    if (typePill) {
      const typeId = typePill.dataset.locedType;
      const existing = loc.types.find((x) => String(x._typeId) === typeId);
      if (existing) {
        if (loc.types.length <= 1) {
          setStatus("A location needs at least one type — add another before removing this one.", true);
          return;
        }
        if (await saved(send(`/api/tracked-locations/${existing._accessId}`, "DELETE"), "the type change")) {
          loc.types = loc.types.filter((x) => x !== existing);
          render();
        }
      } else {
        const ok = await saved(
          send("/api/tracked-locations", "POST", { locationId: loc._id, typeId, driveTo: "00:00", driveBack: "00:00", setUp: "00:00", packUp: "00:00", timeToSpot: "00:00", timeFromSpot: "00:00" }),
          "the type change"
        );
        if (ok) {
          await reloadTypes();
          render();
        }
      }
      return;
    }
    const like = t.closest("[data-loced-newtype-like]");
    if (like) {
      bodyEl.querySelectorAll("[data-loced-newtype-like]").forEach((p) => {
        const on = p === like;
        p.classList.toggle("is-on", on);
        p.setAttribute("aria-pressed", String(on));
      });
      return;
    }
    if (t.closest("[data-loced-newtype-add]")) {
      const nameInput = bodyEl.querySelector("[data-loced-newtype-name]");
      const newName = nameInput.value.trim();
      const behaves = (bodyEl.querySelector("[data-loced-newtype-like].is-on") || {}).dataset?.locedNewtypeLike || "Kayak";
      if (!newName) {
        setStatus("Give the new type a name first.", true);
        return;
      }
      const ok = await saved(
        send("/api/tracked-locations", "POST", { locationId: loc._id, newTypeName: newName, newTypeBehavesLike: behaves, driveTo: "00:00", driveBack: "00:00", setUp: "00:00", packUp: "00:00", timeToSpot: "00:00", timeFromSpot: "00:00" }),
        "the new type"
      );
      if (ok) {
        await reloadTypes();
        render();
      }
    }
  });

  bodyEl.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.locedText) {
      loc[t.dataset.locedText] = t.value;
      debounce("place", savePlace);
    } else if (t.hasAttribute("data-loced-tideoffset")) {
      loc.tideOffset = t.value === "" ? null : parseFloat(t.value);
      debounce("place", savePlace);
    } else if (t.dataset.locedMintide !== undefined) {
      const type = loc.types[Number(t.dataset.locedMintide)];
      type.minTideHeight = t.value === "" ? null : parseFloat(t.value);
      debounce(`type:${loc.types.indexOf(type)}`, () => saveType(type));
    } else if (t.dataset.locedMin) {
      const [i, key] = t.dataset.locedMin.split(":");
      const type = loc.types[Number(i)];
      type[key] = locEdMinutesToHm(t.value);
      debounce(`type:${loc.types.indexOf(type)}`, () => saveType(type));
    }
  });
}
