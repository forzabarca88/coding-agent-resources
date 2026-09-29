// Tests for the results page's machine-section ordering: the generated data
// files (data/eval-results-provider.md, data/eval-results-local.md) list the
// provider machine first once stitched (the order the page fetches them in),
// but the page must show the local results first. Covers both halves of the
// real behaviour from assets/results.js — the pure ordering policy
// (localFirstOrder) and its application to the rendered DOM
// (reorderSections) — against the real data files' headings.
//
// Run with: node --test 'docs/tests/*.test.mjs'

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(here, '..');
const src = fs.readFileSync(path.join(docs, 'assets', 'results.js'), 'utf8');

// Run the real script in a sandbox where the page IIFE stays inert (null
// elements, a never-resolving fetch), leaving the top-level helpers
// reachable without a DOM.
const sandbox = {
  document: { getElementById: () => null },
  fetch: () => new Promise(() => {}),
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

// Minimal element stub: only what reorderSections uses — tagName,
// textContent, children, and an appendChild that moves.
function el(tagName, text) {
  return { tagName, textContent: text || '' };
}
function root(children) {
  return {
    children,
    appendChild(node) {
      const i = children.indexOf(node);
      if (i !== -1) children.splice(i, 1);
      children.push(node);
    },
  };
}

// The section headings of the combined generated data, in stitched order.
function dataHeadings(md) {
  return md.split('\n').filter((l) => l.startsWith('# ')).map((l) => l.slice(2).trim());
}

// The two generated files, stitched in the page's fetch order (provider
// first) — the markdown the results page actually renders from.
const resultsMd = ['eval-results-provider.md', 'eval-results-local.md']
  .map((f) => fs.readFileSync(path.join(docs, 'data', f), 'utf8'))
  .join('\n\n');

test('policy: stitched data headings order local-first, groups keep relative order', () => {
  // ARRANGE — the stitched generated files (provider fetched first)
  const headings = dataHeadings(resultsMd);
  const locals = headings.filter((h) => /\(local\)/i.test(h));
  const others = headings.filter((h) => !/\(local\)/i.test(h));
  assert.ok(locals.length > 0 && others.length > 0, 'the data must have both a local and a non-local section');

  // ACT
  const order = sandbox.localFirstOrder(headings);

  // ASSERT — every local heading before every other heading, stable within groups
  assert.ok(order, 'the real data must trigger a reorder');
  assert.deepEqual(order.map((i) => headings[i]), locals.concat(others));
});

test('policy: no local headings, only local headings, or a passing mention means no reorder', () => {
  // ARRANGE + ACT + ASSERT
  assert.equal(sandbox.localFirstOrder(['Evaluation Results (Provider)']), null, 'no local section');
  assert.equal(
    sandbox.localFirstOrder(['Evaluation Results (Local) A', 'Evaluation Results (Local) B']),
    null,
    'only local sections'
  );
  assert.equal(
    sandbox.localFirstOrder(['Evaluation Results (Provider, local relay)']),
    null,
    'the word local outside the (Local) heading form must not trigger a reorder'
  );
});

test('reorderSections: stitched data renders the local section before the provider one', () => {
  // ARRANGE — the structure marked produces for the stitched data: one h1
  // plus one table per machine section, in stitched order (provider first),
  // with a lead node before the first section (real pages can carry one).
  const lead = el('P', 'intro paragraph');
  const children = [lead];
  dataHeadings(resultsMd).forEach((h) => {
    children.push(el('H1', h));
    children.push(el('TABLE'));
  });
  const content = root(children);

  // ACT
  sandbox.reorderSections(content);

  // ASSERT — lead node keeps its place, then the Local section, then Provider
  const out = content.children;
  assert.equal(out[0], lead, 'nodes before the first section must keep their place');
  assert.match(out[1].textContent, /\(local\)/i, 'first heading must be the local section');
  assert.equal(out[2].tagName, 'TABLE', 'the local table follows its heading');
  assert.match(out[3].textContent, /\(provider\)/i, 'the provider section follows');
  assert.equal(out[4].tagName, 'TABLE');
  assert.equal(out.length, children.length, 'no nodes may be lost or duplicated');
});
