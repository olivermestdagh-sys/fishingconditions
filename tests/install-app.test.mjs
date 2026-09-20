// The header "Install app" button's decisions (js/install-app.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSharedScripts } from "./helpers.mjs";

const src = readSharedScripts();
const fn = (name) => {
  const m = src.match(new RegExp(`function ${name}\\b[\\s\\S]*?\\r?\\n}\\r?\\n`));
  if (!m) throw new Error("could not find " + name);
  return m[0];
};
const f = new Function([fn("installIsStandalone"), fn("installIsIos"), fn("installShouldOffer"), "return { installIsStandalone, installIsIos, installShouldOffer };"].join("\n"))();

const media = (matching) => (q) => ({ matches: matching.includes(q) });

test("running as an installed app is detected from display-mode or the iOS flag", () => {
  assert.equal(f.installIsStandalone(media(["(display-mode: standalone)"]), undefined), true);
  assert.equal(f.installIsStandalone(media(["(display-mode: fullscreen)"]), undefined), true);
  assert.equal(f.installIsStandalone(media([]), true), true);
  assert.equal(f.installIsStandalone(media([]), undefined), false);
  assert.equal(f.installIsStandalone(media([]), false), false);
});

test("iPhone, iPad and iPadOS are recognised as iOS; Android and desktop are not", () => {
  assert.equal(f.installIsIos("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", "iPhone", 5), true);
  assert.equal(f.installIsIos("Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)", "iPad", 5), true);
  assert.equal(f.installIsIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 5), true); // iPadOS posing as a Mac
  assert.equal(f.installIsIos("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel", 0), false); // a real Mac
  assert.equal(f.installIsIos("Mozilla/5.0 (Linux; Android 13; SM-G991B)", "Linux armv8l", 5), false);
});

test("the button shows only when not installed and there is something to offer", () => {
  assert.equal(f.installShouldOffer({ standalone: false, hasPrompt: true, ios: false }), true); // Chrome/Edge/Samsung with a held prompt
  assert.equal(f.installShouldOffer({ standalone: false, hasPrompt: false, ios: true }), true); // iOS: instructions only
  assert.equal(f.installShouldOffer({ standalone: false, hasPrompt: false, ios: false }), false); // nothing to offer
  assert.equal(f.installShouldOffer({ standalone: true, hasPrompt: true, ios: false }), false); // already installed
  assert.equal(f.installShouldOffer({ standalone: true, hasPrompt: false, ios: true }), false);
});