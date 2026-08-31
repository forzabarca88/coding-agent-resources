// End-to-end tests for the visualization's wildcard model search, exercising
// the real assets/visualization.js against the real data/eval-results.md in a
// minimal DOM stub. The page script is loaded via vm, the search input is
// driven through its real event + debounce path, and assertions are made on
// the rendered summary text, search count, and chip strip — against counts
// computed independently from the raw markdown.
//
// Run with: node --test 'docs/tests/*.test.mjs'

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const vizSrc = fs.readFileSync(path.join(here, '..', 'assets', 'visualization.js'), 'utf8');
const resultsMd = fs.readFileSync(path.join(here, '..', 'data', 'eval-results.md'), 'utf8');

/* ---------------- stub DOM ---------------- */

function makeEl(id) {
  const attrs = new Map();
  const listeners = new Map();
  return {
    id: id || '',
    tagName: 'DIV',
    textContent: '',
    value: '',
    disabled: false,
    hidden: false,
    style: {},
    selectedOptions: [],
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    appendChild(c) { return c; },
    addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn); },
    dispatchEvent(ev) { (listeners.get(ev.type) || []).forEach((fn) => fn.call(this, ev)); return true; },
    focus() {},
    blur() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelectorAll() { return []; },
  };
}

// The content div used by parseMarkdown(): parses the heading/table structure
// out of the HTML that marked produces for our data file.
function makeContentEl() {
  const el = makeEl('content');
  let nodes = [];
  el.querySelectorAll = function (sel) {
    if (/^h1,\s*h2,\s*h3,\s*table$/.test(sel)) return nodes;
    return [];
  };
  Object.defineProperty(el, 'innerHTML', {
    set(html) { nodes = parseContentHtml(html); },
    get() { return ''; },
  });
  return el;
}

function cellNodes(html) {
  const out = [];
  const re = /<(?:td|th)>([\s\S]*?)<\/(?:td|th)>/g;
  let m;
  while ((m = re.exec(html))) {
    const c = makeEl();
    c.textContent = m[1];
    out.push(c);
  }
  return out;
}

function parseContentHtml(html) {
  const nodes = [];
  const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>|<table>([\s\S]*?)<\/table>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) {
      const h = makeEl();
      h.tagName = 'H' + m[1];
      h.textContent = m[2];
      nodes.push(h);
    } else {
      const blob = m[3];
      const table = makeEl();
      table.tagName = 'TABLE';
      table.querySelectorAll = function (sel) {
        if (sel === 'thead th') {
          const thead = /<thead>([\s\S]*?)<\/thead>/.exec(blob);
          return thead ? cellNodes(thead[1]) : [];
        }
        if (sel === 'tbody tr') {
          const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(blob);
          if (!tbody) return [];
          const rows = [];
          const trRe = /<tr>([\s\S]*?)<\/tr>/g;
          let tr;
          while ((tr = trRe.exec(tbody[1]))) {
            const tds = cellNodes(tr[1]);
            const rowEl = makeEl();
            rowEl.querySelectorAll = function (sel2) {
              return sel2 === 'td' ? tds : [];
            };
            rows.push(rowEl);
          }
          return rows;
        }
        return [];
      };
      nodes.push(table);
    }
  }
  return nodes;
}

/* ---------------- marked stub (GFM headings + tables) ---------------- */

function markedParse(md) {
  const lines = md.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push('<h' + h[1].length + '>' + h[2] + '</h' + h[1].length + '>');
      continue;
    }
    if (line.trimStart().startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) { rows.push(lines[i]); i++; }
      i--;
      const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const th = cells(rows[0]).map((c) => '<th>' + c + '</th>').join('');
      let body = '';
      for (let j = 2; j < rows.length; j++) {
        body += '<tr>' + cells(rows[j]).map((c) => '<td>' + c + '</td>').join('') + '</tr>';
      }
      out.push('<table><thead><tr>' + th + '</tr></thead><tbody>' + body + '</tbody></table>');
    }
  }
  return out.join('\n');
}

/* ---------------- independent expectations from the raw markdown ---------------- */

// Successful runs (exit 0, positive finite context and turns), mirroring the
// success rule but parsed independently of the page's table pipeline.
function successfulRows(md) {
  const rows = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
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
        rows.push({ model: c[idx.model], notes: c[idx.notes] });
      }
    }
  }
  return rows;
}

const rows = successfulRows(resultsMd);
const modelsOf = (rs) => [...new Set(rs.map((r) => r.model))];
const totalModels = modelsOf(rows).length;

/* ---------------- boot the page script ---------------- */

function boot() {
  const els = new Map();
  const document = {
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
    createElement(tag) { return tag === 'div' ? makeContentEl() : makeEl(); },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  globalThis.document = document;
  globalThis.marked = { parse: markedParse };
  globalThis.fetch = () => Promise.resolve({ ok: true, text: () => Promise.resolve(resultsMd) });
  vm.runInThisContext(vizSrc, { filename: 'visualization.js' });
  return {
    searchInput: document.getElementById('model-search'),
    summary: document.getElementById('viz-summary'),
    chips: document.getElementById('model-chips'),
    searchCount: document.getElementById('model-search-count'),
    status: document.getElementById('viz-status'),
  };
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms)); // > the 120ms debounce

async function search(page, q) {
  page.searchInput.value = q;
  page.searchInput.dispatchEvent(new Event('input'));
  await settle();
}

function chipModels(page) {
  return [...page.chips.innerHTML.matchAll(/data-model="([^"]*)"/g)].map((m) => m[1]);
}

// Parse 'Showing N of M successful runs (all sources; X of Y models have runs matching "q").'
function parseSearchSummary(text) {
  const m = /^Showing (\d+) of (\d+) successful runs \(all sources; (\d+) of (\d+) models have runs matching "([^"]*)"\)\.$/.exec(text);
  assert(m, 'summary format, got: ' + text);
  return { shown: +m[1], scopeTotal: +m[2], matchedModels: +m[3], totalModels: +m[4], query: m[5] };
}

/* ---------------- tests ---------------- */

test('loads the data and shows the top-25 slice before any search', async () => {
  const page = boot();
  await settle(100); // let load() finish
  assert.match(page.status.textContent, /Loaded \d+ successful runs? from data\/eval-results\.md\./);
  const m = /^Showing (\d+) of (\d+) successful runs \(all sources; all (\d+) models\)\.( Least context first\.)?$/
    .exec(page.summary.textContent);
  assert(m, 'summary format, got: ' + page.summary.textContent);
  assert.equal(+m[1], Math.min(25, rows.length)); // default Top N
  assert.equal(+m[2], rows.length);
  assert.equal(+m[3], totalModels);
});

test('wildcard spans model name and notes: qwen3.8-27b*Q4', async () => {
  const page = boot();
  await settle(100);
  await search(page, 'qwen3.8-27b*Q4');

  const expected = rows.filter((r) =>
    r.model.toLowerCase().includes('qwen3.8-27b') && r.notes.toLowerCase().includes('q4'));
  const expectedModels = modelsOf(expected);
  const allQwen = rows.filter((r) => r.model.toLowerCase().includes('qwen3.8-27b'));
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
  const page = boot();
  await settle(100);
  await search(page, 'Q2_K_XL');

  const expected = rows.filter((r) => r.notes.toLowerCase().includes('q2_k_xl'));
  const expectedModels = modelsOf(expected);
  assert(expected.length > 0, 'precondition: matching rows exist');
  // Not every run of the same model: rows shown == runs with the note.
  const allModelRuns = rows.filter((r) => expectedModels.includes(r.model));
  assert(expected.length < allModelRuns.length, 'precondition: matches only some runs of those models');

  const s = parseSearchSummary(page.summary.textContent);
  assert.equal(s.shown, expected.length);
  assert.equal(s.matchedModels, expectedModels.length);
  assert.deepEqual(chipModels(page).sort(), expectedModels.slice().sort());
});

test('model-name prefix still works: openrouter/', async () => {
  const page = boot();
  await settle(100);
  await search(page, 'openrouter/');

  const expected = rows.filter((r) => r.model.toLowerCase().startsWith('openrouter/'));
  const expectedModels = modelsOf(expected);
  assert(expected.length > 0, 'precondition: matching rows exist');

  const s = parseSearchSummary(page.summary.textContent);
  assert.equal(s.shown, expected.length);
  assert.equal(s.matchedModels, expectedModels.length);
  assert.deepEqual(chipModels(page).sort(), expectedModels.slice().sort());
});

test('literal text cannot bridge name and notes without a wildcard', async () => {
  const page = boot();
  await settle(100);
  await search(page, 'qwen3.8-27b Q4'); // literal space, no '*'

  assert.match(page.summary.textContent, /^No runs match search "qwen3\.8-27b Q4"\.$/);
  assert.equal(page.searchCount.textContent, '0 of ' + totalModels + ' models have matching runs "qwen3.8-27b Q4"');
});

test('clearing the search restores the previous selection', async () => {
  const page = boot();
  await settle(100);
  await search(page, 'qwen3.8-27b*Q4');
  await search(page, '');

  const m = /^Showing \d+ of (\d+) successful runs \(all sources; all (\d+) models\)\.( Least context first\.)?$/
    .exec(page.summary.textContent);
  assert(m, 'summary restored to all models, got: ' + page.summary.textContent);
  assert.equal(+m[1], rows.length);
  assert.equal(+m[2], totalModels);
  assert.equal(page.searchCount.textContent, '');
});
