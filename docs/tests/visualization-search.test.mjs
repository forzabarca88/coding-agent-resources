// End-to-end tests for the visualization's wildcard model search, exercising
// the real assets/visualization.js against the real data/eval-results.md in a
// minimal DOM stub (shared with the other visualization tests in
// viz-harness.mjs). The page script is loaded via vm, the search input is
// driven through its real event + debounce path, and assertions are made on
// the rendered summary text, search count, and chip strip — against counts
// computed independently from the raw markdown. The page boots with the
// Local source selected by default (state.source = 'Local'), so all
// expectations are scoped to the local rows exactly as the page sees them.
//
// Run with: node --test 'docs/tests/*.test.mjs'

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootVizPage as boot, settle } from './viz-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsMd = fs.readFileSync(path.join(here, '..', 'data', 'eval-results.md'), 'utf8');

/* ---------------- independent expectations from the raw markdown ---------------- */

// Successful runs (exit 0, positive finite context and turns), mirroring the
// success rule but parsed independently of the page's table pipeline.
// The current heading is tracked while scanning so each row is classified
// local/provider exactly like the page: /local/i on the section heading, or
// an lmstudio- model name.
function successfulRows(md) {
  const rows = [];
  const lines = md.split('\n');
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const h = /^(#{1,3})\s+(.*)$/.exec(lines[i]);
    if (h) { section = h[2]; continue; }
    if (!lines[i].trimStart().startsWith('|')) continue;
    const t = [];
    while (i < lines.length && lines[i].trimStart().startsWith('|')) {
      t.push(lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
      i++;
    }
    i--;
    const idx = {};
    t[0].forEach((h, j) => {
      const s = h.toLowerCase();
      if (s.includes('model')) idx.model = j;
      else if (s.includes('notes')) idx.notes = j;
      else if (s.includes('context')) idx.tokens = j;
      else if (s.includes('turn')) idx.turns = j;
      else if (s.includes('exit')) idx.exit = j;
    });
    for (let j = 2; j < t.length; j++) {
      const c = t[j];
      const tokens = parseInt(c[idx.tokens], 10);
      const turns = parseInt(c[idx.turns], 10);
      if (c[idx.exit] === '0' && tokens > 0 && isFinite(turns)) {
        const model = c[idx.model];
        rows.push({ model, notes: c[idx.notes], local: /local/i.test(section) || /^lmstudio/i.test(model) });
      }
    }
  }
  return rows;
}

const rows = successfulRows(resultsMd);
// The page's default source filter (Local) scopes every rendered count —
// the summary, the search count and the chips — so the expectations do too.
const local = rows.filter((r) => r.local);
const modelsOf = (rs) => [...new Set(rs.map((r) => r.model))];
const totalModels = modelsOf(local).length;

async function search(page, q) {
  page.searchInput.value = q;
  page.searchInput.dispatchEvent(new Event('input'));
  await settle();
}

function chipModels(page) {
  return [...page.chips.innerHTML.matchAll(/data-model="([^"]*)"/g)].map((m) => m[1]);
}

// Parse 'Showing N of M successful runs (local runs; X of Y models have runs matching "q").'
function parseSearchSummary(text) {
  const m = /^Showing (\d+) of (\d+) successful runs \(local runs; (\d+) of (\d+) models have runs matching "([^"]*)"\)\.$/.exec(text);
  assert(m, 'summary format, got: ' + text);
  return { shown: +m[1], scopeTotal: +m[2], matchedModels: +m[3], totalModels: +m[4], query: m[5] };
}

/* ---------------- tests ---------------- */

test('loads the data and shows the top-25 slice before any search', async () => {
  const page = boot(resultsMd);
  await settle(100); // let load() finish
  assert.match(page.status.textContent, /Loaded \d+ successful runs? from data\/eval-results\.md\./);
  const m = /^Showing (\d+) of (\d+) successful runs \(local runs; all (\d+) models\)\.( Least context first\.)?$/
    .exec(page.summary.textContent);
  assert(m, 'summary format, got: ' + page.summary.textContent);
  assert.equal(+m[1], Math.min(25, local.length)); // default Top N
  assert.equal(+m[2], local.length);
  assert.equal(+m[3], totalModels);
});

test('wildcard spans model name and notes: qwen3.8-27b*Q4', async () => {
  const page = boot(resultsMd);
  await settle(100);
  await search(page, 'qwen3.8-27b*Q4');

  const expected = local.filter((r) =>
    r.model.toLowerCase().includes('qwen3.8-27b') && r.notes.toLowerCase().includes('q4'));
  const expectedModels = modelsOf(expected);
  const allQwen = local.filter((r) => r.model.toLowerCase().includes('qwen3.8-27b'));
  assert(expected.length > 0, 'precondition: matching rows exist');
  assert(expected.length < allQwen.length, 'precondition: the notes part narrows within the model');
  assert(expectedModels.length < totalModels, 'precondition: the model part narrows the model set');

  const s = parseSearchSummary(page.summary.textContent);
  assert.equal(s.shown, expected.length);
  assert.equal(s.matchedModels, expectedModels.length);
  assert.equal(s.query, 'qwen3.8-27b*Q4');
  assert.equal(page.searchCount.textContent,
    expectedModels.length + ' of ' + totalModels + ' models have matching runs "qwen3.8-27b*Q4"');
  assert.deepEqual(chipModels(page).sort(), expectedModels.slice().sort());
});

test('field-local literal still matches only runs with the note: Q2_K_XL', async () => {
  const page = boot(resultsMd);
  await settle(100);
  await search(page, 'Q2_K_XL');

  const expected = local.filter((r) => r.notes.toLowerCase().includes('q2_k_xl'));
  const expectedModels = modelsOf(expected);
  assert(expected.length > 0, 'precondition: matching rows exist');
  // Not every run of the same model: rows shown == runs with the note.
  const allModelRuns = local.filter((r) => expectedModels.includes(r.model));
  assert(expected.length < allModelRuns.length, 'precondition: matches only some runs of those models');

  const s = parseSearchSummary(page.summary.textContent);
  assert.equal(s.shown, expected.length);
  assert.equal(s.matchedModels, expectedModels.length);
  assert.deepEqual(chipModels(page).sort(), expectedModels.slice().sort());
});

test('model-name literal still works: lmstudio-jdc-ws/unsloth/', async () => {
  const page = boot(resultsMd);
  await settle(100);
  await search(page, 'lmstudio-jdc-ws/unsloth/');

  const expected = local.filter((r) => r.model.toLowerCase().includes('lmstudio-jdc-ws/unsloth/'));
  const expectedModels = modelsOf(expected);
  assert(expected.length > 0, 'precondition: matching rows exist');

  const s = parseSearchSummary(page.summary.textContent);
  assert.equal(s.shown, expected.length);
  assert.equal(s.matchedModels, expectedModels.length);
  assert.deepEqual(chipModels(page).sort(), expectedModels.slice().sort());
});

test('literal text cannot bridge name and notes without a wildcard', async () => {
  const page = boot(resultsMd);
  await settle(100);
  await search(page, 'qwen3.8-27b Q4'); // literal space, no '*'

  assert.match(page.summary.textContent, /^No runs match search "qwen3\.8-27b Q4"\.$/);
  assert.equal(page.searchCount.textContent, '0 of ' + totalModels + ' models have matching runs "qwen3.8-27b Q4"');
});

test('clearing the search restores the previous selection', async () => {
  const page = boot(resultsMd);
  await settle(100);
  await search(page, 'qwen3.8-27b*Q4');
  await search(page, '');

  const m = /^Showing \d+ of (\d+) successful runs \(local runs; all (\d+) models\)\.( Least context first\.)?$/
    .exec(page.summary.textContent);
  assert(m, 'summary restored to all models, got: ' + page.summary.textContent);
  assert.equal(+m[1], local.length);
  assert.equal(+m[2], totalModels);
  assert.equal(page.searchCount.textContent, '');
});
