// End-to-end tests for chart axis scaling: every axis (scatter X/Y, breakdown
// metric) must fit the runs CURRENTLY shown — its start is the largest
// 1/2/5×10^n step multiple at or below the data minimum, not 0 — and must
// re-fit when the visible set changes. Exercises the real
// assets/visualization.js in the shared minimal-DOM harness (viz-harness.mjs)
// against a synthetic results file whose values cluster far from zero, so an
// axis still anchored at 0 fails every assertion. Tick labels are read from
// the rendered SVGs and converted back to values.
//
// Run with: node --test 'docs/tests/*.test.mjs'

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootVizPage, settle } from './viz-harness.mjs';

// Six successful local runs of one model: context 110k..160k, turns 40..90.
// The last two runs (Q8_0) form a tighter, far-from-zero subset for the
// re-fit assertions after a wildcard search narrows the chart to them; the
// fourth run's 'retry pass' note is a unique search key that narrows the
// chart to a single run, driving both axes into the degenerate min==max
// branch of niceAxis().
const ROWS = [
  ['quant: Q4_K_M, KV quant: Q4_0', 110000, 40],
  ['quant: Q4_K_M, KV quant: Q4_0', 120000, 50],
  ['quant: Q4_K_M, KV quant: Q4_0', 130000, 60],
  ['quant: Q4_K_M, KV quant: Q4_0, retry pass', 140000, 70],
  ['quant: Q8_0, KV quant: Q8_0', 150000, 80],
  ['quant: Q8_0, KV quant: Q8_0', 160000, 90],
];
// Six successful local runs of one model (see ROWS), plus a second fixture
// whose context spans 20k..200k: a data minimum small relative to the span
// must still snap down to 0, the documented backward-compatible path.
const SPREAD_MD = [
  '# Evaluation Results (Local)',
  '',
  '| Model | Notes | Duration | Total Context Used | Turns | Limit | Exceeded | Exit | Passed Tests | Failed Tests | Date |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...[20000, 80000, 140000, 200000].map((tokens, i) =>
    '| test-model | quant: Q4_K_M, KV quant: Q4_0 | 1m | ' + tokens + ' | ' + (10 + i * 10) +
    ' | 409600 | no | 0 | 10 | 0 | 2025-01-0' + (i + 1) + ' |'),
].join('\n');

const RESULTS_MD = [
  '# Evaluation Results (Local)',
  '',
  '| Model | Notes | Duration | Total Context Used | Turns | Limit | Exceeded | Exit | Passed Tests | Failed Tests | Date |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...ROWS.map((r, i) =>
    '| test-model | ' + r[0] + ' | 1m | ' + r[1] + ' | ' + r[2] +
    ' | 409600 | no | 0 | 10 | 0 | 2025-01-0' + (i + 1) + ' |'),
].join('\n');

// '110k' -> 110000; plain numbers pass through.
function parseTick(s) {
  const m = /^([\d.]+)k$/.exec(s);
  return m ? Math.round(parseFloat(m[1]) * 1000) : parseFloat(s);
}

// Tick label values: scatter X / Y ticks are class axis-label (middle-anchored
// = X, end-anchored = Y); the breakdown's pinned axis uses brk-tick-label.
function ticks(html, cls, anchor) {
  const re = new RegExp('<text class="' + cls + '"[^>]*text-anchor="' + anchor + '"[^>]*>([^<]+)</text>', 'g');
  return [...html.matchAll(re)].map((m) => parseTick(m[1]));
}

const scatterX = (page) => ticks(page.el('viz-chart').innerHTML, 'axis-label', 'middle');
const scatterY = (page) => ticks(page.el('viz-chart').innerHTML, 'axis-label', 'end');
const breakdownX = (page) => ticks(page.el('brk-chart').innerHTML, 'brk-tick-label', 'middle');

async function search(page, q) {
  page.searchInput.value = q;
  page.searchInput.dispatchEvent(new Event('input'));
  await settle();
}

test('scatter axes start at a step-rounded data minimum, not 0', async () => {
  const page = bootVizPage(RESULTS_MD);
  await settle(100); // let load() finish

  // X: data 110k..160k spans 50k, step 10k -> start snaps to 110k.
  // Y: data 40..90 spans 50, step 10 -> start snaps to 40.
  const xs = scatterX(page);
  const ys = scatterY(page);
  assert.equal(xs[0], 110000);
  assert.equal(ys[0], 40);
  assert.equal(xs[xs.length - 1], 160000);
  assert.equal(ys[ys.length - 1], 90);
  assert.ok(!xs.includes(0) && !ys.includes(0), 'no axis may still anchor at 0');
  // The re-based mapping still renders every run (6 points).
  assert.equal(page.el('viz-chart').innerHTML.split('class="pt"').length - 1, 6);
});

test('breakdown metric axis starts at a step-rounded data minimum, not 0', async () => {
  const page = bootVizPage(RESULTS_MD);
  await settle(100);

  // Data 110k..160k spans 50k, step 20k (4 target ticks) -> the start snaps
  // down to the nearest step multiple below the data min: 100k, not 0.
  const xs = breakdownX(page);
  assert.equal(xs[0], 100000);
  assert.equal(xs[xs.length - 1], 160000);
  assert.ok(!xs.includes(0), 'the axis may not still anchor at 0');
  assert.equal(page.el('brk-chart').innerHTML.split('class="brk-mark"').length - 1, 6);
});

test('axes re-fit when the visible set changes', async () => {
  const page = bootVizPage(RESULTS_MD);
  await settle(100);
  await search(page, 'Q8_0'); // narrows the chart to the two Q8_0 runs

  // X: data 150k..160k spans 10k, step 2k -> start at the data min.
  // Y: data 80..90 spans 10, step 2 -> start at the data min.
  const xs = scatterX(page);
  const ys = scatterY(page);
  assert.equal(xs[0], 150000);
  assert.equal(ys[0], 80);
  assert.equal(xs[xs.length - 1], 160000);
  assert.equal(ys[ys.length - 1], 90);
  assert.ok(!xs.includes(0) && !ys.includes(0), 'no axis may still anchor at 0');
  assert.equal(page.el('viz-chart').innerHTML.split('class="pt"').length - 1, 2);
});

test('a single shown run centres both axes on the shared value (degenerate span)', async () => {
  const page = bootVizPage(RESULTS_MD);
  await settle(100);
  await search(page, 'retry pass'); // matches exactly one run: 140000 tokens, 70 turns

  // Zero span can't size a step, so it is derived from the value and the
  // bounds pad one step either side: X pad 50k -> 90k..190k, Y pad 20 -> 50..90.
  const xs = scatterX(page);
  const ys = scatterY(page);
  assert.deepEqual(xs, [90000, 140000, 190000]);
  assert.deepEqual(ys, [50, 70, 90]);
  assert.equal(page.el('viz-chart').innerHTML.split('class="pt"').length - 1, 1);
});

test('a data minimum close to 0 relative to the span still snaps the axis start to 0', async () => {
  const page = bootVizPage(SPREAD_MD);
  await settle(100);

  // X: data 20k..200k spans 180k, step 50k (6 target ticks) -> the start
  // floors to 0: the min-based scale must not stretch below the data.
  assert.deepEqual(scatterX(page), [0, 50000, 100000, 150000, 200000]);
});
