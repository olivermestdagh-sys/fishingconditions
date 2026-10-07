// Our own confirm / alert dialogs. The browser's native confirm() and alert() title themselves with the web address, and a page
// can't change that, so every "are you sure?" on the site uses these instead (never confirm() / alert()).
//   await confirmDialog("Delete this line?", { title: "Delete line", confirmLabel: "Delete", danger: true })  -> true / false
//   await alertDialog("Couldn't save: ...", { title: "Not saved" })
// No dependencies; the look is the `.dlg-*` classes in style.css. Escape or a tap outside the box = Cancel.

function dialogShow(message, { title, confirmLabel, cancelLabel, danger }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dlg-backdrop";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-modal", "true");
    const box = document.createElement("div");
    box.className = "dlg-box";
    const heading = document.createElement("h2");
    heading.className = "dlg-title";
    heading.textContent = title;
    const body = document.createElement("p");
    body.className = "dlg-message";
    body.textContent = message; // textContent: the message may hold names typed by the user
    const buttons = document.createElement("div");
    buttons.className = "dlg-buttons";
    const finish = (answer) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        finish(false);
      }
    };
    if (cancelLabel) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "dlg-btn";
      cancel.textContent = cancelLabel;
      cancel.addEventListener("click", () => finish(false));
      buttons.appendChild(cancel);
    }
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "dlg-btn dlg-btn-ok" + (danger ? " dlg-btn-danger" : "");
    ok.textContent = confirmLabel;
    ok.addEventListener("click", () => finish(true));
    buttons.appendChild(ok);
    box.append(heading, body, buttons);
    overlay.appendChild(box);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(false);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    (cancelLabel ? buttons.firstChild : ok).focus(); // the safe choice has the focus
  });
}

/** Resolves to true when the person presses the confirm button, false for Cancel / Escape / a tap outside. */
function confirmDialog(message, { title = "Please confirm", confirmLabel = "OK", cancelLabel = "Cancel", danger = false } = {}) {
  return dialogShow(message, { title, confirmLabel, cancelLabel, danger });
}

/** A message with one OK button. */
function alertDialog(message, { title = "Notice" } = {}) {
  return dialogShow(message, { title, confirmLabel: "OK", cancelLabel: "", danger: false }).then(() => undefined);
}
