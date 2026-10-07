// The Python pipeline Worker's own tests (pipeline/tests/*.py, unittest) run from here, so `npm test` and CI cover them with no
// Python test runner of their own. Skipped (not failed) when this machine has no usable Python. The parity gate inside
// (pipeline/tests/test_parity.py) is skipped unless PIPELINE_PARITY_DIR is set: its fixtures hold private locations and are
// never in the repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const pipeline = path.join(root, "pipeline");

function findPython() {
  for (const exe of ["python3", "python"]) {
    const r = spawnSync(exe, ["-c", "import sys, zoneinfo; print(sys.version_info >= (3, 11))"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "True") return exe;
  }
  return null;
}
const python = findPython();

test("pipeline: the script copies in pipeline/src are identical to scripts/", () => {
  for (const f of ["fetch_conditions.py", "observation_archive.py"]) {
    assert.ok(fs.readFileSync(path.join(pipeline, "src", f)).equals(fs.readFileSync(path.join(root, "scripts", f))), `pipeline/src/${f} drifted from scripts/${f}: copy it over`);
  }
});

test("pipeline: every Python file compiles", { skip: !python && "no python available" }, () => {
  const files = ["entry.py", "store.py", "service.py", "plan.py", "publish.py", "runner.py", "net.py", "locking.py", "alerts.py"].map((f) => path.join(pipeline, "src", f));
  const r = spawnSync(python, ["-c", "import sys; [compile(open(f, encoding='utf-8').read(), f, 'exec') for f in sys.argv[1:]]", ...files], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("pipeline: unittest suite (flow, gate, lock, retention, prefetch, retries, watchdog)", { skip: !python && "no python available" }, () => {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
  delete env.PIPELINE_PARITY_DIR; // the parity gate is run by hand, never in CI
  const r = spawnSync(python, ["-W", "ignore", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"], { cwd: pipeline, env, encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-3000));
  assert.match(r.stderr, /\bOK\b/);
});
