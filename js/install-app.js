// install-app.js
// The header's "Install app" button. Chrome, Edge and Samsung Internet offer a real install dialog through the `beforeinstallprompt` event, which this holds on to until the button is tapped. iPhone/iPad have no such dialog, so the button there shows the Share -> Add to Home Screen steps instead. Never shown once the site is running as an installed app.
// Loaded in each page's <head> (before the page has finished loading) because the browser can fire `beforeinstallprompt` early; the button itself is looked up once the page is ready. The decisions are plain functions (tested in tests/install-app.test.mjs).

/** True when the page is running as an installed app (standalone/fullscreen window, or iOS's own flag). `matches` is a function like window.matchMedia. */
function installIsStandalone(matches, navigatorStandalone) {
  return navigatorStandalone === true || matches("(display-mode: standalone)").matches || matches("(display-mode: fullscreen)").matches;
}

/** iPhone/iPad (including iPadOS, which reports itself as a Mac with a touch screen). */
function installIsIos(userAgent, platform, maxTouchPoints) {
  return /iphone|ipad|ipod/i.test(userAgent || "") || (platform === "MacIntel" && maxTouchPoints > 1);
}

/** Whether the button should show: never when already installed; otherwise when the browser has handed us an install prompt, or on iOS where we can only give instructions. */
function installShouldOffer({ standalone, hasPrompt, ios }) {
  return !standalone && (hasPrompt || ios);
}

(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  let deferredPrompt = null;
  let installed = false;

  const standalone = () => installIsStandalone((q) => window.matchMedia(q), window.navigator.standalone);
  const ios = () => installIsIos(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);

  function button() {
    return document.getElementById("installAppBtn");
  }

  function refresh() {
    const btn = button();
    if (!btn) return;
    btn.hidden = installed || !installShouldOffer({ standalone: standalone(), hasPrompt: !!deferredPrompt, ios: ios() });
  }

  function toggleIosNote(btn) {
    let note = document.getElementById("installAppNote");
    if (note) {
      note.remove();
      btn.setAttribute("aria-expanded", "false");
      return;
    }
    note = document.createElement("div");
    note.id = "installAppNote";
    note.className = "install-note";
    note.setAttribute("role", "status");
    note.innerHTML = "To install: tap the <strong>Share</strong> button in your browser, then <strong>Add to Home Screen</strong>.";
    document.body.appendChild(note);
    btn.setAttribute("aria-expanded", "true");
    note.addEventListener("click", () => {
      note.remove();
      btn.setAttribute("aria-expanded", "false");
    });
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // hold it so our own button can open the dialog
    deferredPrompt = e;
    refresh();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferredPrompt = null;
    refresh();
  });

  document.addEventListener("DOMContentLoaded", () => {
    const btn = button();
    if (!btn) return;
    btn.addEventListener("click", async () => {
      if (deferredPrompt) {
        const prompt = deferredPrompt;
        deferredPrompt = null; // a prompt can only be used once
        prompt.prompt();
        try {
          await prompt.userChoice;
        } catch (err) {
          /* dismissed or unsupported — nothing to do */
        }
        refresh();
      } else if (ios()) {
        toggleIosNote(btn);
      }
    });
    refresh();
  });
})();
