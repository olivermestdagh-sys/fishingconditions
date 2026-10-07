// Guards on .github/workflows/update.yml's recorder change: the conditions the owner set for it must hold in the file itself, since the
// workflow cannot be run locally. (1) a recorder failure falls back to the plain script, (2) the upload can never fail the workflow and
// is skipped without its secrets, (3) recordings (private locations) are never committed or uploaded anywhere but the private bucket.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const yml = fs.readFileSync(new URL("../.github/workflows/update.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const step = (name) => {
  const i = yml.indexOf(`- name: ${name}`);
  assert.ok(i >= 0, `step "${name}" is missing`);
  const rest = yml.slice(i + 1);
  const j = rest.search(/\n {6}- name: /);
  return yml.slice(i, j < 0 ? undefined : i + 1 + j);
};

test("the data step runs the recorder and FALLS BACK to the original script if the recorder exits nonzero", () => {
  const s = step("Fetch latest conditions");
  assert.match(s, /if ! python3 scripts\/record_run\.py; then[\s\S]*python3 scripts\/fetch_conditions\.py[\s\S]*fi/);
  assert.doesNotMatch(s, /continue-on-error/, "the data step itself must fail the workflow when the data run fails");
  for (const env of ["WILLYWEATHER_API_KEY", "PIPELINE_WORKER_URL", "PIPELINE_API_TOKEN", "FORECAST_DAYS", "OBS_PRUNE"]) assert.match(s, new RegExp(env));
});

test("the upload step is continue-on-error, skips cleanly without secrets, and only ever targets the private shadow bucket", () => {
  const s = step("Upload the recording to the private shadow bucket (best effort)");
  assert.match(s, /continue-on-error: true/);
  assert.match(s, /R2 secrets are not set: skipping[\s\S]*exit 0/);
  assert.match(s, /R2_SHADOW_BUCKET: fishingconditions-shadow-private/);
  assert.match(s, /\/recordings\//);
  assert.doesNotMatch(s, /upload-artifact|actions\/cache/, "recordings hold private locations: never an artifact");
});

test("the commit step does not include the recordings, and they are git-ignored", () => {
  const s = step("Commit updated data file");
  assert.match(s, /file_pattern: "data\/conditions\.json data\/graph config\/locations\.json"/);
  assert.doesNotMatch(s, /recordings/);
  assert.match(fs.readFileSync(new URL("../.gitignore", import.meta.url), "utf8"), /^recordings\/\s*$/m);
});

test("no step uploads an artifact or caches the recordings", () => {
  assert.doesNotMatch(yml, /upload-artifact/);
});
