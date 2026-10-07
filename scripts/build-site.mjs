// Builds dist/: a copy of ONLY the files the deployed static site needs.
//
// The file list is discovered, not hard-coded: every top-level .html page is read for the files it references
// (<script src>, <link href>, <img src>, other local hrefs), the web manifest's icons, CSS url()/@import, and the
// images/data/config paths and service worker named inside the scripts those pages load. data/ and
// config/locations.json are always included. Anything a page, manifest or stylesheet references that is not on disk
// fails the build loudly (a missing file named only inside a script is a warning, since scripts may probe optional
// files such as marks.json).
//
// Run: node scripts/build-site.mjs      (exports collectSiteFiles for tests/build-site.test.mjs)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALWAYS_FILES = ["config/locations.json"];
const ALWAYS_DIRS = ["data"];

const isExternal = (ref) => /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref);

// "js/a.js?v=2#x" -> "js/a.js"; null for external / empty / directory-style references.
function cleanRef(ref) {
  ref = ref.trim();
  if (!ref || isExternal(ref)) return null;
  ref = ref.split("#")[0].split("?")[0];
  if (!ref || ref.endsWith("/")) return null;
  return ref;
}

function htmlRefs(html) {
  const refs = [];
  for (const m of html.matchAll(/<(?:script|link|img|source|a|iframe)\b[^>]*>/gi)) {
    for (const a of m[0].matchAll(/\s(?:src|href)\s*=\s*"([^"]*)"/gi)) refs.push(a[1]);
  }
  return refs;
}

function cssRefs(css) {
  const refs = [];
  for (const m of css.matchAll(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/gi)) refs.push(m[1]);
  for (const m of css.matchAll(/@import\s+['"]([^'"]+)['"]/gi)) refs.push(m[1]);
  return refs;
}

function manifestRefs(text) {
  const refs = [];
  try {
    const j = JSON.parse(text);
    for (const i of j.icons || []) if (i.src) refs.push(i.src);
    for (const i of j.screenshots || []) if (i.src) refs.push(i.src);
  } catch {
    /* an unparseable manifest is reported by the caller reading it as missing refs */
  }
  return refs;
}

// Paths a script names as string literals: the site's asset folders and the service worker registration.
function scriptRefs(js) {
  const refs = [];
  for (const m of js.matchAll(/["'`]((?:\.\/)?(?:images|data|config)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)["'`]/g)) refs.push(m[1]);
  for (const m of js.matchAll(/serviceWorker\s*\.\s*register\(\s*["']([^"']+)["']/g)) refs.push(m[1]);
  return refs;
}

function walk(dir, root, out) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir + "/" + e.name;
    if (e.isDirectory()) walk(rel, root, out);
    else out.add(rel);
  }
}

/**
 * @returns {{files: string[], missing: {from: string, ref: string, hard: boolean}[]}}
 *   files: root-relative posix paths to copy; missing: referenced files not on disk (hard = must fail the build).
 */
export function collectSiteFiles(root) {
  const files = new Set();
  const missing = [];
  const queue = [];

  const add = (rel, from, hard) => {
    rel = path.posix.normalize(rel);
    if (rel.startsWith("../") || path.posix.isAbsolute(rel)) {
      missing.push({ from, ref: rel, hard });
      return;
    }
    if (files.has(rel)) return;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      if (!missing.some((m) => m.ref === rel && m.from === from)) missing.push({ from, ref: rel, hard });
      return;
    }
    files.add(rel);
    queue.push(rel);
  };

  const pages = fs.readdirSync(root).filter((f) => f.endsWith(".html"));
  for (const p of pages) add(p, "(top-level page)", true);
  for (const f of ALWAYS_FILES) add(f, "(always included)", true);
  for (const d of ALWAYS_DIRS) {
    const all = new Set();
    if (fs.existsSync(path.join(root, d))) walk(d, root, all);
    for (const f of all) add(f, "(always included)", true);
  }

  while (queue.length) {
    const rel = queue.shift();
    const ext = path.posix.extname(rel).toLowerCase();
    let refs;
    let hard = true;
    if (ext === ".html") refs = htmlRefs(fs.readFileSync(path.join(root, rel), "utf8"));
    else if (ext === ".css") refs = cssRefs(fs.readFileSync(path.join(root, rel), "utf8"));
    else if (ext === ".webmanifest") refs = manifestRefs(fs.readFileSync(path.join(root, rel), "utf8"));
    else if (ext === ".js") {
      refs = scriptRefs(fs.readFileSync(path.join(root, rel), "utf8"));
      hard = false;
    } else continue;
    const dir = path.posix.dirname(rel);
    for (const raw of refs) {
      const ref = cleanRef(raw);
      if (!ref) continue;
      // Site-root-relative ("/x") is not used here; everything is relative to the referencing file. Script-literal
      // paths (images/..., data/...) are relative to the PAGE (the site root), not to the script.
      const target = ext === ".js" ? ref.replace(/^\.\//, "") : path.posix.join(dir, ref);
      add(target, rel, hard);
    }
  }

  return { files: [...files].sort(), missing };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dist = path.join(root, "dist");
  const { files, missing } = collectSiteFiles(root);

  for (const m of missing.filter((x) => !x.hard)) console.warn(`warning: ${m.from} names ${m.ref}, which does not exist (optional?)`);
  const hard = missing.filter((m) => m.hard);
  if (hard.length) {
    for (const m of hard) console.error(`ERROR: ${m.from} references ${m.ref}, which does not exist`);
    console.error(`\nBuild failed: ${hard.length} referenced file(s) missing.`);
    process.exit(1);
  }

  fs.rmSync(dist, { recursive: true, force: true });
  for (const rel of files) {
    const to = path.join(dist, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(root, rel), to);
  }

  // Verify: everything the pages reference is really in dist/ (re-reads dist, not the source tree).
  const again = collectSiteFiles(dist);
  const bad = again.missing.filter((m) => m.hard);
  if (bad.length) {
    for (const m of bad) console.error(`ERROR: dist/ is missing ${m.ref} (referenced by ${m.from})`);
    process.exit(1);
  }
  const outFiles = again.files;
  if (outFiles.length !== files.length) {
    console.error("ERROR: dist/ file list differs from the planned list");
    process.exit(1);
  }
  console.log(`dist/ built: ${files.length} files`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
