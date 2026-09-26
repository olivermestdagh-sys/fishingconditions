// Proves that every page loads all the scripts it needs.
//
// The site has no bundler: each page lists its own <script> files (js/*.js plus a
// page script), which share one global scope. Nothing tells you if a page is
// missing a file until a button breaks in the browser. This check builds, for each
// HTML page, the concatenation of the local scripts exactly in the order the page
// loads them and runs ESLint's `no-undef` over it: any function/constant used but
// not defined by those scripts (or a known browser/library global) is an error.
//
// Run: npm install && npm run check-pages
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Linter } from "eslint";
import globals from "globals";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pages = fs.readdirSync(root).filter((f) => f.endsWith(".html"));
const linter = new Linter({ configType: "flat" });

// Globals provided by libraries loaded from CDNs (not by our own scripts).
const libraryGlobals = { L: "readonly", Chart: "readonly", ChartZoom: "readonly", Hammer: "readonly" };

let failures = 0;
for (const page of pages) {
  const html = fs.readFileSync(path.join(root, page), "utf8");
  const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]).filter((s) => !/^https?:/.test(s));
  // Inline <script> blocks (no src) count as page scripts too, in document order.
  const parts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  for (const m of html.matchAll(re)) {
    const srcMatch = m[1].match(/\ssrc="([^"]+)"/);
    if (srcMatch) {
      if (/^https?:/.test(srcMatch[1])) continue;
      parts.push({ label: srcMatch[1], text: fs.readFileSync(path.join(root, srcMatch[1]), "utf8") });
    } else if (m[2].trim()) {
      parts.push({ label: `${page} (inline script)`, text: m[2] });
    }
  }
  if (parts.length === 0) continue;

  // Concatenate, remembering which file each line came from.
  let text = "";
  const map = [];
  for (const p of parts) {
    const n = p.text.split("\n").length;
    for (let i = 0; i < n; i++) map.push({ file: p.label, line: i + 1 });
    text += p.text + "\n";
    map.push({ file: p.label, line: n });
  }

  const messages = linter.verify(
    text,
    [
      {
        languageOptions: {
          ecmaVersion: 2022,
          sourceType: "script",
          globals: { ...globals.browser, ...libraryGlobals },
        },
        rules: { "no-undef": "error" },
      },
    ],
    { filename: `${page}.js` } // ESLint only applies config to .js names
  );

  const problems = messages.filter((m) => m.ruleId === "no-undef" || m.fatal);
  if (problems.length === 0) {
    console.log(`ok    ${page.padEnd(16)} ${parts.length} script(s)`);
    continue;
  }
  failures += problems.length;
  console.log(`FAIL  ${page.padEnd(16)} ${problems.length} problem(s):`);
  const seen = new Set();
  for (const p of problems) {
    const where = map[p.line - 1] || { file: "?", line: p.line };
    const key = `${p.message}@${where.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`        ${p.message}  (${where.file}:${where.line})`);
  }
}
if (failures) {
  console.error(`\n${failures} undefined reference(s): a page is missing a script it needs.`);
  process.exit(1);
}
console.log("\nAll pages load everything they use.");
