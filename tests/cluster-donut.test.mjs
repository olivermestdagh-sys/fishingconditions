// Cluster donut icons (js/marks-layer.js): slice grouping, size by count, SVG output.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const layer = fs.readFileSync(new URL("../js/marks-layer.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const grab = (re) => {
  const m = re.exec(layer);
  assert.ok(m, `not found: ${re}`);
  return m[0];
};
const code = [
  grab(/function clusterSlices[\s\S]*?\n}\n/),
  grab(/function clusterIconSize[\s\S]*?\n}\n/),
  grab(/function clusterDonutSvg[\s\S]*?\n}\n/),
].join("\n");
const { clusterSlices, clusterIconSize, clusterDonutSvg } = new Function(`${code}\nreturn { clusterSlices, clusterIconSize, clusterDonutSvg };`)();

const items = (spec) => spec.flatMap(([color, n]) => Array.from({ length: n }, () => ({ key: color, color, label: color })));

test("slices are grouped, largest first, with shares summing to 1", () => {
  const s = clusterSlices(items([["red", 6], ["blue", 3], ["green", 1]]), 0);
  assert.deepEqual(s.map((x) => x.key), ["red", "blue", "green"]);
  assert.equal(s[0].share, 0.6);
  assert.ok(Math.abs(s.reduce((n, x) => n + x.share, 0) - 1) < 1e-9);
});

test("several tiny slices fold into one grey Other; a lone tiny slice keeps its colour", () => {
  const many = clusterSlices(items([["red", 90], ["blue", 2], ["green", 2]]), 0.05);
  assert.deepEqual(many.map((x) => x.label), ["red", "Other"]);
  assert.equal(many[1].count, 4);
  const lone = clusterSlices(items([["red", 98], ["blue", 2]]), 0.05);
  assert.deepEqual(lone.map((x) => x.key), ["red", "blue"]);
});

test("icon size grows with count and is clamped", () => {
  assert.equal(clusterIconSize(1), 30);
  assert.ok(clusterIconSize(50) > clusterIconSize(5));
  assert.equal(clusterIconSize(1e9), 64);
});

test("donut svg has one arc per slice and the count in the middle", () => {
  const svg = clusterDonutSvg(clusterSlices(items([["#f00", 3], ["#00f", 1]]), 0), 40, 4);
  assert.equal((svg.match(/stroke-dasharray/g) || []).length, 2);
  assert.match(svg, />4<\/text>/);
});
