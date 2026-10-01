// Species pictures on the Settings page: shrink a chosen file in the browser, upload it, and build the URL to show one.
// fitWithin is pure (tested in tests/species-image.test.mjs); the rest uses the browser (canvas, fetch) and USER_BACKEND_URL
// from js/backend.js. The Worker stores the pictures (see handleMarkListImages in user-backend.js).

const SPECIES_IMAGE_MAX_SIDE = 1024; // px, long side
const SPECIES_IMAGE_MAX_COUNT = 12; // per species (the Worker enforces it too)
const SPECIES_IMAGE_MAX_BYTES = 700 * 1024; // same limit as the Worker

/** The size to draw a width x height picture at so its long side is at most `max`: never enlarged, aspect ratio kept. */
function fitWithin(width, height, max) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Where a species picture is served from. The version is in the URL so a replaced picture is fetched afresh. */
function speciesImageUrl(image) {
  return `${USER_BACKEND_URL}/api/public/species-image/${encodeURIComponent(image.id)}?v=${encodeURIComponent(image.version ?? "")}`;
}

/**
 * REAL BUG, FOUND AND FIXED: a picture fetched moments after being uploaded could come back 404 for a few seconds
 * (confirmed directly against the live Worker: the exact same URL that 404'd went on to return the image fine on a
 * later request, with nothing about the row itself having changed — read-after-write lag on D1's side, not a client
 * bug) — every gallery/thumbnail/viewer <img> on this site showed that as a confusing blank box. Wires an <img> to
 * retry once, a beat later and bypassing any cache, before giving up and swapping in a small "Picture unavailable"
 * label in its place — so a stale read heals itself instead of looking broken. Call this on every species-picture
 * <img> right after it's added to the page (its `src` must already be set).
 */
function wireImagePictureFallback(img, placeholderText = "Picture unavailable") {
  let retried = false;
  img.addEventListener("error", () => {
    if (!retried) {
      retried = true;
      const url = new URL(img.src, location.href);
      setTimeout(() => {
        url.searchParams.set("retry", Date.now());
        img.src = url.href;
      }, 1500);
      return;
    }
    const span = document.createElement("span");
    span.className = "species-image-missing";
    span.textContent = placeholderText;
    img.replaceWith(span);
  });
}

/** Decodes a chosen image file (honouring its rotation). Rejects if the browser can't read it (e.g. HEIC in Chrome). */
async function decodeImageFile(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      /* fall through to an <img> element */
    }
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("unreadable"));
      img.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Turns a chosen file into a JPEG Blob no bigger than SPECIES_IMAGE_MAX_BYTES: long side at most SPECIES_IMAGE_MAX_SIDE,
 * drawn over white (so a transparent PNG doesn't turn black), quality lowered and size reduced if it is still too big.
 * Rejects with Error("unreadable") if the file can't be decoded.
 */
async function fileToJpegBlob(file) {
  let source;
  try {
    source = await decodeImageFile(file);
  } catch {
    throw new Error("unreadable");
  }
  const sourceWidth = source.width || source.naturalWidth;
  const sourceHeight = source.height || source.naturalHeight;
  let max = SPECIES_IMAGE_MAX_SIDE;
  for (const quality of [0.82, 0.7, 0.55, 0.45]) {
    const { width, height } = fitWithin(sourceWidth, sourceHeight, max);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) throw new Error("unreadable");
    if (blob.size <= SPECIES_IMAGE_MAX_BYTES) return blob;
    max = Math.round(max * 0.8); // still too big: try smaller too
  }
  throw new Error("That image is too large even after shrinking it.");
}

/**
 * Sends one picture to the Worker: adds it to the species' list entry, or replaces `imageId`. `userParam` is the
 * "?userId=..." part the Settings page adds when acting as another account ("" otherwise). Resolves to the updated list
 * entry (with its images), or throws Error(message).
 */
async function uploadSpeciesImage(listId, blob, imageId, userParam) {
  const path = imageId ? `${listId}/images/${encodeURIComponent(imageId)}` : `${listId}/images`;
  const res = await fetch(`${USER_BACKEND_URL}/api/marklists/${path}${userParam || ""}`, {
    method: imageId ? "PUT" : "POST",
    credentials: "include",
    headers: { "Content-Type": "image/jpeg" },
    body: blob,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `status ${res.status}`);
  }
  return res.json();
}

/** Removes one picture. Resolves to the updated list entry, or throws Error(message). */
async function deleteSpeciesImage(listId, imageId, userParam) {
  const res = await fetch(`${USER_BACKEND_URL}/api/marklists/${listId}/images/${encodeURIComponent(imageId)}${userParam || ""}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `status ${res.status}`);
  }
  return res.json();
}

/** The URL of a Rig option's pictures (`imageId` for one picture). `scope` "private" = your own override of a Public rig; otherwise `userParam` ("?userId=..." or "") picks whose rig. */
function rigOptionImageUrl(rigId, option, imageId, userParam, scope) {
  const path = `${USER_BACKEND_URL}/api/marklists/${rigId}/options/${encodeURIComponent(option)}/images${imageId ? `/${encodeURIComponent(imageId)}` : ""}`;
  return scope === "private" ? `${path}?scope=private` : `${path}${userParam || ""}`;
}

/** Adds (or, with `imageId`, replaces) a picture of one option of a Rig's sub list. Resolves to the updated rig row, or for scope "private" to {rigId, subList, optionImages}. */
async function uploadRigOptionImage(rigId, option, blob, imageId, userParam, scope) {
  const res = await fetch(rigOptionImageUrl(rigId, option, imageId, userParam, scope), {
    method: imageId ? "PUT" : "POST",
    credentials: "include",
    headers: { "Content-Type": "image/jpeg" },
    body: blob,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `status ${res.status}`);
  }
  return res.json();
}

/** Removes one picture of a Rig option. Same results as uploadRigOptionImage. */
async function deleteRigOptionImage(rigId, option, imageId, userParam, scope) {
  const res = await fetch(rigOptionImageUrl(rigId, option, imageId, userParam, scope), { method: "DELETE", credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `status ${res.status}`);
  }
  return res.json();
}

let hoverImagePreviewEl = null; // the large picture shown while the pointer is over a choice's thumbnail

function hideHoverImagePreview() {
  if (hoverImagePreviewEl) hoverImagePreviewEl.remove();
  hoverImagePreviewEl = null;
}

/** Puts the large preview beside the pointer (right of it, or left when there's no room), kept inside the window. */
function positionHoverImagePreview(e) {
  const el = hoverImagePreviewEl;
  if (!el) return;
  const gap = 18;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let x = e.clientX + gap;
  if (x + w > window.innerWidth - 8) x = Math.max(8, e.clientX - gap - w);
  const y = Math.min(Math.max(8, e.clientY - h / 2), Math.max(8, window.innerHeight - h - 8));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

/** True on a touch screen (no hover): there a choice's thumbnail opens a larger picture on tap instead of on hover. */
function isTouchOnlyDevice() {
  return typeof window.matchMedia === "function" && window.matchMedia("(hover: none)").matches;
}

/** Full-screen larger picture (same dark look as the Settings viewer); tapping anywhere or the × closes it. */
function showImageLightbox(src, caption) {
  const overlay = document.createElement("div");
  overlay.className = "species-image-viewer";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  const top = document.createElement("div");
  top.className = "species-image-viewer-top";
  const title = document.createElement("span");
  title.textContent = caption || "";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.innerHTML = "&times;";
  top.append(title, closeBtn);
  const stage = document.createElement("div");
  stage.className = "species-image-viewer-stage";
  const big = document.createElement("img");
  big.alt = caption || "";
  big.src = src;
  stage.appendChild(big);
  overlay.append(top, stage);
  overlay.addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);
}

/**
 * A choice's thumbnail (img.live-card-choice-thumb inside `root`) can be seen larger: with a mouse, hovering shows the same picture beside
 * the pointer; on a touch screen, tapping the small picture opens it full screen (and does NOT pick the choice — tap the name for that).
 */
function wireHoverImagePreview(root) {
  root.querySelectorAll("img.live-card-choice-thumb").forEach((img) => {
    img.addEventListener("click", (e) => {
      if (!isTouchOnlyDevice()) return;
      e.preventDefault();
      e.stopPropagation();
      showImageLightbox(img.src, img.dataset.caption || "");
    });
    img.addEventListener("mouseenter", (e) => {
      if (isTouchOnlyDevice()) return; // a tap also fires mouseenter; touch screens use the tap preview above
      hideHoverImagePreview();
      const big = document.createElement("img");
      big.className = "hover-image-preview";
      big.alt = "";
      big.addEventListener("load", () => positionHoverImagePreview(e)); // its size is only known once loaded
      big.src = img.src;
      document.body.appendChild(big);
      hoverImagePreviewEl = big;
      positionHoverImagePreview(e);
    });
    img.addEventListener("mousemove", positionHoverImagePreview);
    img.addEventListener("mouseleave", hideHoverImagePreview);
  });
}

/** Opens the file picker and resolves to the chosen File, or null if it was cancelled. */
function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    document.body.appendChild(input);
    const done = (file) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => done(input.files && input.files[0] ? input.files[0] : null));
    input.addEventListener("cancel", () => done(null));
    input.click();
  });
}
