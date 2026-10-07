// The file-list logic of scripts/build-site.mjs: what a page references is included, server-side files are not, and a
// missing referenced file is reported as a hard error.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectSiteFiles } from "../scripts/build-site.mjs";

function makeSite(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-site-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const BASE = {
  "index.html": `<link rel="manifest" href="manifest.webmanifest"><link rel="stylesheet" href="style.css?v=2">
    <script src="js/a.js"></script><script src="https://cdn.example/x.js"></script><img src="images/logo.png"><a href="other.html#x">o</a>`,
  "other.html": `<script src="page.js"></script>`,
  "manifest.webmanifest": JSON.stringify({ icons: [{ src: "images/icon.png" }] }),
  "style.css": `body{background:url("images/bg.png")}`,
  "js/a.js": `navigator.serviceWorker.register("sw.js"); fetch("config/locations.json"); const x = "images/dyn.svg";`,
  "page.js": "",
  "sw.js": "",
  "images/logo.png": "", "images/icon.png": "", "images/bg.png": "", "images/dyn.svg": "", "images/unused.png": "",
  "config/locations.json": "{}", "config/other.json": "{}",
  "data/conditions.json": "{}", "data/graph/h.json": "{}",
  "user-backend.js": "", "willyweather-search.js": "", "wrangler.toml": "", "README.md": "", "schema.sql": "",
  "tests/t.test.mjs": "", "docs/d.md": "", "scripts/s.mjs": "",
};

test("includes what pages reference (and what those pull in) plus data/ and config/locations.json", () => {
  const { files, missing } = collectSiteFiles(makeSite(BASE));
  assert.deepEqual(missing, []);
  assert.deepEqual(files, [
    "config/locations.json", "data/conditions.json", "data/graph/h.json",
    "images/bg.png", "images/dyn.svg", "images/icon.png", "images/logo.png",
    "index.html", "js/a.js", "manifest.webmanifest", "other.html", "page.js", "style.css", "sw.js",
  ]);
});

test("never includes the Worker, tests, docs, scripts, SQL, config or unreferenced files", () => {
  const { files } = collectSiteFiles(makeSite(BASE));
  for (const bad of ["user-backend.js", "willyweather-search.js", "wrangler.toml", "README.md", "schema.sql", "images/unused.png", "config/other.json"]) {
    assert.ok(!files.includes(bad), bad);
  }
  assert.ok(!files.some((f) => /^(tests|docs|scripts)\//.test(f)));
});

test("a page reference to a missing file is a hard error; a script-only one is a warning", () => {
  const site = makeSite({ ...BASE, "index.html": BASE["index.html"] + `<script src="js/gone.js"></script>`, "js/a.js": `x("images/maybe.png")` });
  const { missing } = collectSiteFiles(site);
  assert.deepEqual(missing.filter((m) => m.hard).map((m) => m.ref), ["js/gone.js"]);
  assert.deepEqual(missing.filter((m) => !m.hard).map((m) => m.ref), ["images/maybe.png"]);
});

test("references to files outside the site root are refused", () => {
  const { missing } = collectSiteFiles(makeSite({ ...BASE, "index.html": `<script src="../secret.js"></script>` }));
  assert.ok(missing.some((m) => m.hard && m.ref === "../secret.js"));
});
