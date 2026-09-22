// The Map page's owner tooltip/Owner-field pieces (js/marks-core.js): markTooltipText's " · <owner>" suffix
// (Admin only) and markOwnerOptionsHtml's <option> list for the Owner picker in buildMarkPopupEditHtml.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSharedScripts } from "./helpers.mjs";

const src = readSharedScripts();
const fn = (name) => {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\r?\\n}\\r?\\n`));
  assert.ok(m, `${name} not found in js/*.js`);
  return m[0];
};
const constDecl = (name) => {
  const m = src.match(new RegExp(`const ${name} = [^\\n]*\\r?\\n`));
  assert.ok(m, `${name} not found in js/*.js`);
  return m[0];
};

// cachedIsAdmin/cachedAdminUsers are read as free variables inside markTooltipText/markOwnerOptionsHtml — passing
// them in as this factory's own parameters shadows what would otherwise be undefined globals, same trick
// visible-marks.test.mjs uses for PERSONAL_MARK_TYPES.
const factory = new Function(
  "cachedIsAdmin",
  "cachedAdminUsers",
  [fn("escapeHtml"), constDecl("CLIENT_PUBLIC_USER_ID"), fn("markOwnerOptionsHtml"), fn("markTooltipText"), "return { markTooltipText, markOwnerOptionsHtml };"].join("\n")
);

const mark = (extra = {}) => ({ name: "Jetty spot", dateTime: "2026-01-02 08:00:00", type: "Catch", ...extra });

test("tooltip appends the owner for Admin only, and only once one is actually known", () => {
  const { markTooltipText } = factory(true, []);
  assert.equal(markTooltipText(mark({ ownerName: "Alice" })), "Jetty spot (2026-01-02) Catch · Alice");
  assert.equal(markTooltipText(mark()), "Jetty spot (2026-01-02) Catch"); // no ownerName yet — no suffix
});

test("tooltip never appends the owner for a non-admin viewer, even if the field is present", () => {
  const { markTooltipText } = factory(false, []);
  assert.equal(markTooltipText(mark({ ownerName: "Alice" })), "Jetty spot (2026-01-02) Catch");
});

test("tooltip escapes the owner name", () => {
  const { markTooltipText } = factory(true, []);
  assert.equal(markTooltipText(mark({ ownerName: "<b>Bob</b> & co" })), "Jetty spot (2026-01-02) Catch · &lt;b&gt;Bob&lt;/b&gt; &amp; co");
});

test("owner picker always offers Public first, then every real user, with the mark's current owner selected", () => {
  const { markOwnerOptionsHtml } = factory(true, [
    { id: "u1", name: "Alice" },
    { id: "u2", name: "", email: "bob@example.com" },
  ]);
  const html = markOwnerOptionsHtml("u2");
  assert.match(html, /^<option value="public" >Public \(shared\)<\/option>/);
  assert.match(html, /<option value="u1" >Alice<\/option>/);
  assert.match(html, /<option value="u2" selected>bob@example\.com<\/option>/); // no name on file — falls back to email
});

test("a mark whose current owner isn't in the user list still gets a selected fallback option, not nothing selected", () => {
  const { markOwnerOptionsHtml } = factory(true, [{ id: "u1", name: "Alice" }]);
  const html = markOwnerOptionsHtml("ghost-id");
  assert.match(html, /<option value="ghost-id" selected>\(unknown account\)<\/option>/);
});
