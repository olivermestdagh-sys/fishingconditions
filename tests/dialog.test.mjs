// js/dialog.js: confirmDialog / alertDialog against a tiny DOM stub.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../js/dialog.js", import.meta.url), "utf8");

function makeEnv() {
  const listeners = {};
  const body = { children: [], appendChild(el) { this.children.push(el); el.parent = this; } };
  const mk = () => {
    const el = { children: [], classList: [], handlers: {}, textContent: "", className: "", attrs: {}, focused: false };
    el.setAttribute = (k, v) => { el.attrs[k] = v; };
    el.appendChild = (c) => { el.children.push(c); c.parent = el; return c; };
    el.append = (...cs) => cs.forEach((c) => el.appendChild(c));
    el.addEventListener = (t, fn) => { el.handlers[t] = fn; };
    el.remove = () => { if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el); };
    el.focus = () => { el.focused = true; };
    Object.defineProperty(el, "firstChild", { get: () => el.children[0] });
    return el;
  };
  const document = {
    body,
    createElement: mk,
    addEventListener: (t, fn) => { listeners[t] = fn; },
    removeEventListener: (t) => { delete listeners[t]; },
  };
  const lib = new Function("document", `${src}; return { confirmDialog, alertDialog };`)(document);
  const buttons = () => body.children[0].children[0].children[2].children; // overlay > box > buttons
  return { lib, body, listeners, buttons, overlay: () => body.children[0] };
}

test("OK resolves true and the dialog goes away", async () => {
  const env = makeEnv();
  const p = env.lib.confirmDialog("Sure?", { title: "End trip", confirmLabel: "End" });
  assert.equal(env.overlay().children[0].children[0].textContent, "End trip");
  const [cancel, ok] = env.buttons();
  assert.equal(cancel.textContent, "Cancel");
  assert.equal(ok.textContent, "End");
  assert.equal(cancel.focused, true); // the safe choice has the focus
  ok.handlers.click();
  assert.equal(await p, true);
  assert.equal(env.body.children.length, 0);
});

test("Cancel, Escape and a tap outside resolve false", async () => {
  for (const how of ["cancel", "escape", "outside"]) {
    const env = makeEnv();
    const p = env.lib.confirmDialog("Sure?");
    if (how === "cancel") env.buttons()[0].handlers.click();
    else if (how === "escape") env.listeners.keydown({ key: "Escape", stopPropagation() {} });
    else { const o = env.overlay(); o.handlers.click({ target: o }); }
    assert.equal(await p, false, how);
    assert.equal(env.body.children.length, 0);
  }
});

test("alertDialog has one OK button", async () => {
  const env = makeEnv();
  const p = env.lib.alertDialog("Oops", { title: "Not saved" });
  const b = env.buttons();
  assert.equal(b.length, 1);
  b[0].handlers.click();
  assert.equal(await p, undefined);
});
