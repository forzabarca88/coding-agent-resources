// End-to-end tests for the scatter's model-colour map: every model shown
// (chips + plot) must get its OWN ink — never a colour already handed to a
// different model — regardless of how many models the data contains, and the
// plot marks must use the same ink as that model's chip. Boots the real
// assets/visualization.js in the shared minimal-DOM harness (viz-harness.mjs)
// against a synthetic results file with 40 models, past the 12-entry curated
// palette whose modulo wrap was the original collision bug. Both themes are
// exercised because each has its own environment palette.
//
// Run with: node --test 'docs/tests/*.test.mjs'

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootVizPage, settle } from './viz-harness.mjs';

// 40 distinct models, one successful local run each. The count is well past
// the curated palette length so the generated inks (and their uniqueness
// guard) are actually exercised.
const MODELS = Array.from({ length: 40 }, (_, i) => 'model-' + String(i).padStart(2, '0'));
const FIXTURE_MD = [
  '# Evaluation Results (Local)',
  '',
  '| Model | Notes | Duration | Total Context Used | Turns | Limit | Exceeded | Exit | Passed Tests | Failed Tests | Date |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...MODELS.map((m, i) =>
    '| ' + m + ' | quant: Q4_K_M, KV quant: Q4_0 | 1m | ' + (1000 + i * 100) + ' | ' + (i + 1) +
    ' | 409600 | no | 0 | 10 | 0 | 2025-01-01 |'),
].join('\n');

// chip model name -> ink from the filter strip.
function chipInks(page) {
  const out = new Map();
  const re = /data-model="([^"]+)"[^>]*--modcol:(#[0-9a-fA-F]{6})/g;
  for (const m of page.chips.innerHTML.matchAll(re)) out.set(m[1], m[2].toLowerCase());
  return out;
}

// model name -> mark fill from the rendered scatter.
function pointInks(page) {
  const out = new Map();
  const re = /<g class="pt"[\s\S]*?aria-label="([^":]+)[\s\S]*?fill="(#[0-9a-fA-F]{6})"/g;
  for (const m of page.el('viz-chart').innerHTML.matchAll(re)) out.set(m[1], m[2].toLowerCase());
  return out;
}

for (const theme of ['dark', 'light']) {
  test('every model gets a distinct ink, and marks match chips (' + theme + ')', async () => {
    const page = bootVizPage(
      { 'data/eval-results-provider.md': '', 'data/eval-results-local.md': FIXTURE_MD },
      { theme }
    );
    await settle(100); // let load() finish

    const inks = chipInks(page);
    assert.equal(inks.size, MODELS.length, 'one chip per model');
    assert.equal(new Set(inks.values()).size, MODELS.length, 'no two models may share an ink');

    const points = pointInks(page);
    assert.equal(points.size, Math.min(25, MODELS.length), 'default top-N slice of scatter points');
    for (const [model, ink] of points) {
      assert.equal(ink, inks.get(model), 'scatter mark and chip must share the model ink');
    }
  });
}
