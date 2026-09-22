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
