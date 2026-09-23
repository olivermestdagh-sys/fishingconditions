// location-editor.js
// The Map page's location editor: the gear after a location's name on its graph opens a dialog, styled like the
// map's filter dialog (collapsible sections, pills), for every field the Settings page's Locations editor
// (locationsadmin.js) can change — display name, WillyWeather search name, shore, groups, tides, tide offset, the
// types it's usable for, and each type's timings / minimum tide height. Edits save straight away through the same
// Worker endpoints Settings uses (typing is debounced), then `onChanged` lets the page re-read the live config.
//
// Admin only: the Map's locations are the Public account's and the Admin's own (see buildLocationList,
// user-backend.js), so the editor looks the location up in both, by its WillyWeather search name, and edits it in
// whichever account holds it (?userId=public for Public's).

// Which sections are open — kept across openings, like the filter dialog's.
const locEdOpenGroups = new Set();

function locEdParseHM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  return m ? { h: Number(m[1]), m: Number(m[2]) } : { h: 0, m: 0 };
}
function locEdFormatHM(h, m) {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Finds the Map location `name` among the Admin's own tracked locations and Public's, and returns it in the
 * Settings page's shape: place fields, groups, and one entry per type with its access-row id and timings. Also the
 * account's type and group vocabularies, for the pickers. Null when it isn't in either account. */
async function locEdLoad(name) {
  for (const param of ["", "?userId=public"]) {
    const res = await fetch(`${USER_BACKEND_URL}/api/tracked-locations${param}`, { credentials: "include" });
    if (!res.ok) throw new Error(`tracked-locations status ${res.status}`);
    const rows = (await res.json()).filter((r) => r.location.name === name);
    if (!rows.length) continue;
    const [typesRes, groupsRes] = await Promise.all([
      fetch(`${USER_BACKEND_URL}/api/types${param}`, { credentials: "include" }),
      fetch(`${USER_BACKEND_URL}/api/groups${param}`, { credentials: "include" }),
    ]);
    if (!typesRes.ok) throw new Error(`types status ${typesRes.status}`);
    if (!groupsRes.ok) throw new Error(`groups status ${groupsRes.status}`);
    const p = rows[0].location;
    return {
      param,
      accountLabel: param ? "Public" : "your account",
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
        types: rows.map((r) => ({
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
        })),
      },
    };
  }
  return null;
}

/**
 * Opens the editor for the Map location whose WillyWeather search name is `name`. `onChanged` runs after every
 * successful save (the Map uses it to re-merge the live location config and redraw the graph).
 */
async function openLocationEditor(name, { onChanged } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "ww-candidate-overlay";
  overlay.innerHTML = `
    <div class="ww-candidate-dialog loc-editor">
      <button type="button" class="ww-candidate-close" aria-label="Close">&times;</button>
      <h3 style="margin:0 0 8px;">Edit location</h3>
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
    bodyEl.innerHTML = `<p class="footnote" style="margin:0;">This location isn't in your account or Public's, so it can't be edited here.</p>`;
    return;
  }
  const { loc, param } = ctx;

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
  const saveType = (t) =>
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
    const summary = fields.map((f) => `${f.label} ${t[f.key] || "00:00"}`);
    if (t.behavesLike === "Kayak" && t.minTideHeight != null) summary.push(`Min tide ${t.minTideHeight} m`);
    const body =
      `<div class="loc-editor-hm-grid">${fields
        .map((f) => {
          const { h, m } = locEdParseHM(t[f.key]);
          return `<label class="mark-edit-field">${escapeHtml(f.label)}
            <span class="hm-pair">
              <input type="number" min="0" max="23" step="1" inputmode="numeric" data-loced-hm="${i}:${f.key}:h" value="${h}" aria-label="${escapeHtml(f.label)} hours" />
              <span class="hm-sep">:</span>
              <input type="number" min="0" max="59" step="1" inputmode="numeric" data-loced-hm="${i}:${f.key}:m" value="${String(m).padStart(2, "0")}" aria-label="${escapeHtml(f.label)} minutes" />
            </span></label>`;
        })
        .join("")}</div>` +
      (t.behavesLike === "Kayak"
        ? `<label class="mark-edit-field">Minimum tide height for access (m) — blank if not applicable
            <input type="number" min="0" step="0.1" inputmode="decimal" data-loced-mintide="${i}" value="${t.minTideHeight != null ? t.minTideHeight : ""}" placeholder="e.g. 1.2" style="${MARK_POPUP_INPUT_STYLE}" /></label>`
        : "");
    return group(`type:${t.type}`, `${t.type} timings`, summary, body);
  }
  function render() {
    const activeTypeIds = loc.types.map((t) => t._typeId);
    const groupNames = ctx.groups.map((g) => g.name);
    bodyEl.innerHTML = `
      <p class="footnote" style="margin:0 0 8px;text-align:left;">Editing ${escapeHtml(ctx.accountLabel)}'s location. Changes save as you make them.</p>
      <label class="mark-edit-field" style="margin-top:0;">Display name
        <input type="text" data-loced-text="displayName" value="${escapeHtml(loc.displayName || "")}" style="${MARK_POPUP_INPUT_STYLE}" /></label>
      <label class="mark-edit-field">WillyWeather search name
        <input type="text" data-loced-text="name" value="${escapeHtml(loc.name || "")}" style="${MARK_POPUP_INPUT_STYLE}" /></label>
      <p class="footnote" style="margin:2px 0 8px;text-align:left;">Changing the search name links the location to a different WillyWeather place from the next data refresh.</p>
      <div class="mark-edit-groups">
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
      </div>`;
  }
  render();

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
      debounce(`type:${type._accessId}`, () => saveType(type));
    } else if (t.dataset.locedHm) {
      const [i, key, part] = t.dataset.locedHm.split(":");
      const type = loc.types[Number(i)];
      const current = locEdParseHM(type[key]);
      const raw = Math.max(0, Math.floor(Number(t.value) || 0));
      if (part === "h") current.h = Math.min(23, raw);
      else current.m = Math.min(59, raw);
      type[key] = locEdFormatHM(current.h, current.m);
      debounce(`type:${type._accessId}`, () => saveType(type));
    }
  });
}
