// The Help dialog (js/help.js): every tab has help, every tab loads it, and every screenshot it names exists.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const src = fs.readFileSync(path.join(root, "js/help.js"), "utf8");
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src + "\nthis.HELP_PAGES = HELP_PAGES; this.HELP_TABS = HELP_TABS;", ctx);
const pages = ctx.HELP_PAGES;
const tabs = ctx.HELP_TABS;

test("every tab in the nav has help with a title, intro and sections", () => {
  for (const t of tabs) {
    const p = pages[t.page];
    assert.ok(p, `help for ${t.page}`);
    assert.ok(p.title && p.intro && p.sections.length > 0, t.page);
    const ids = p.sections.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `${t.page}: duplicate section ids`);
    for (const s of p.sections) assert.ok(s.title && s.html, `${t.page}/${s.id}`);
  }
});

test("each tab's page loads js/help.js and its HELP_PAGES key is that page's file name", () => {
  for (const t of tabs) {
    const html = fs.readFileSync(path.join(root, `${t.page}.html`), "utf8");
    assert.match(html, /<script src="js\/help\.js"><\/script>/, `${t.page}.html`);
    assert.match(html, /class="topbar"/, `${t.page}.html has the header bar the ? button goes in`);
  }
});

test("every screenshot the help names exists", () => {
  const names = [...src.matchAll(/helpFig\("([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 0);
  for (const n of names) assert.ok(fs.existsSync(path.join(root, "images/help", n)), n);
});
