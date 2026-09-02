// Tests for the shared "Overall findings" block: each data page must embed
// exactly one initially-collapsed <details class="findings"> whose slot points
// at the single shared markdown file, and that file must exist — so both pages
// always render the same content from one editable source.
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
