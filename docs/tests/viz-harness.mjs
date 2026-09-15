// Shared harness for tests that boot the real assets/visualization.js in a
// minimal DOM stub: element factory, a GFM marked stub (headings + tables)
// for the data-file parser, and bootVizPage(), which runs the page script via
// its real fetch path against a given results markdown and returns handles.
// Not a test file — the docs/tests/*.test.mjs glob never picks it up.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const vizSrc = fs.readFileSync(path.join(here, '..', 'assets', 'visualization.js'), 'utf8');

/* ---------------- stub DOM ---------------- */

export function makeEl(id) {
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
export function makeContentEl() {
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

export function markedParse(md) {
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

/* ---------------- boot the page script ---------------- */

// Sets up the stub globals, then runs the real visualization.js. `resultsMd`
// is what the page's fetch of data/eval-results.md resolves to. Returns
// handles for the elements the tests drive or read.
export function bootVizPage(resultsMd) {
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
    el(id) { return document.getElementById(id); },
    searchInput: document.getElementById('model-search'),
    summary: document.getElementById('viz-summary'),
    chips: document.getElementById('model-chips'),
    searchCount: document.getElementById('model-search-count'),
    status: document.getElementById('viz-status'),
  };
}

export const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms)); // > the 120ms debounce
