// Tests for the shared "Overall findings" block: each data page must embed
// exactly one initially-collapsed <details class="findings"> whose slot points
// at the single shared markdown file, and that file must exist — so both pages
// always render the same content from one editable source. Also covers the
// file's top-of-file Contents list: every anchor must resolve to a heading in
// the same file (assets/content.js gives rendered headings these slug ids).
//
// Run with: node --test 'docs/tests/*.test.mjs'

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(here, '..');
const pages = ['evaluation-results.html', 'visualization.html'];
const sharedMd = 'content/overall-findings.md';

for (const page of pages) {
  test(`${page} embeds the shared Overall findings block, collapsed`, () => {
    // ARRANGE
    const html = fs.readFileSync(path.join(docs, page), 'utf8');

    // ACT — extract the findings details element(s)
    const blocks = html.match(/<details class="findings"[^>]*>[\s\S]*?<\/details>/g) || [];

    // ASSERT — exactly one block, collapsed on load, labelled and slotted to the shared file
    assert.equal(blocks.length, 1, 'expected exactly one Overall findings block');
    const openTag = blocks[0].slice(0, blocks[0].indexOf('>'));
    assert.match(openTag, /^<details class="findings"($|\s)/, 'the block must open with <details class="findings">');
    assert.doesNotMatch(openTag, /(^|\s)open(\s|=|$)/, 'the block must be collapsed on load (no open attribute)');
    assert.match(blocks[0], /Overall findings/, 'the summary must be labelled Overall findings');
    assert.ok(blocks[0].includes(`data-content="${sharedMd}"`), 'the slot must point at the shared markdown file');
  });
}

test('the shared findings markdown file exists', () => {
  // ARRANGE / ACT
  const exists = fs.existsSync(path.join(docs, sharedMd));

  // ASSERT
  assert.equal(exists, true, `${sharedMd} is the single shared source for both pages`);
});

test('the Contents list sits at the top and its anchors resolve to headings', () => {
  // ARRANGE — the shared markdown, and the slug algorithm assets/content.js
  // uses to give rendered headings their ids (lowercase, apostrophes dropped,
  // other non-alphanumerics collapsed to "-").
  const md = fs.readFileSync(path.join(docs, sharedMd), 'utf8');
  const slugify = (text) => text
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // ACT — slugs of every heading in the file, and the anchor hrefs used by
  // the "## Contents" block (which runs to the first top-level heading).
  const slugs = new Set();
  for (const line of md.split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) slugs.add(slugify(heading[1]));
  }
  const contentsAt = md.search(/^## Contents\s*$/m);
  const firstH1At = md.search(/^# \S/m);
  const contents = contentsAt === -1 ? '' : md.slice(contentsAt, firstH1At);
  const anchors = [...contents.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);

  // ASSERT — Contents sits above the first heading, lists links, and each
  // link points at a heading that exists in the same file.
  assert.notEqual(contentsAt, -1, 'expected a "## Contents" section');
  assert.notEqual(firstH1At, -1, 'expected at least one top-level heading');
  assert.ok(contentsAt < firstH1At, 'the Contents block must sit at the top of the file');
  assert.ok(anchors.length > 0, 'the Contents block must list links');
  for (const anchor of anchors) {
    assert.ok(slugs.has(anchor), `Contents link #${anchor} has no matching heading`);
  }
});
