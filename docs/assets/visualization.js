(function () {
  'use strict';

  // Loads data/eval-results.md and renders a scatter plot of successful runs:
  // Total Context Used (tokens) on the X axis, Turns on the Y axis, points
  // coloured by Model — their glyph shapes repeat the range chart's quant
  // marks — with direct labels where space allows. Used by
  // visualization.html only. Everything is derived from the markdown at
  // runtime — nothing is hardcoded.
  var RESULTS_PATH = 'data/eval-results.md';

  var statusEl = document.getElementById('viz-status');
  var chartEl = document.getElementById('viz-chart');
  var tooltipEl = document.getElementById('viz-tooltip');
  var summaryEl = document.getElementById('viz-summary');
  var retryEl = document.getElementById('viz-retry');
  var sourceBtns = Array.prototype.slice.call(document.querySelectorAll('[data-source]'));
  var psizeBtns = Array.prototype.slice.call(document.querySelectorAll('[data-psize]'));
  var topSel = document.getElementById('top-filter');
  var vizLegendEl = document.getElementById('viz-legend');
  var chipsEl = document.getElementById('model-chips');
  var modelsAllBtn = document.getElementById('models-all');
  var modelsNoneBtn = document.getElementById('models-none');
  var searchInput = document.getElementById('model-search');
  var searchCountEl = document.getElementById('model-search-count');
  var searchClearEl = document.getElementById('model-search-clear');

  // Models dropdown popover in the filter bar.
  var modelsPop = document.getElementById('models-pop');
  var modelsToggle = document.getElementById('models-toggle');
  var modelsPanel = document.getElementById('models-panel');
  var modelsSummary = document.getElementById('models-summary');

  // Model-breakdown panel (second chart on the page).
  var brkEl = document.getElementById('brk-chart');
  var brkStatusEl = document.getElementById('brk-status');
  var brkLegendEl = document.getElementById('brk-legend');
  var brkPlotEl = document.getElementById('brk-plot');
  var brkTpt = document.getElementById('brk-tooltip');
  var brkMetricBtns = Array.prototype.slice.call(document.querySelectorAll('[data-metric]'));
  // The run currently pinned in the breakdown (click / Enter), or null. A
  // pin keeps that run's tooltip open until Escape or a re-draw.
  var brkPinned = null;

  // Print-ink hues with strong separation, drawn from the site family (carbon
  // blue anchor, then chroma spread around the wheel). Models receive colours
  // in order of first successful appearance, so colours stay stable.
  var PALETTE = [
    '#B42318', // rust
    '#2E4A7A', // carbon blue
    '#0E7A7B', // teal
    '#A86A2B', // ochre
    '#1F6F8F', // sea
    '#5B7A2E', // leaf
    '#7A4A6B', // plum
    '#8F5B2A', // cinnamon
    '#3B6E5E', // pine
    '#7748A8', // violet
    '#A35D14', // bronze
    '#C2563E'  // vermilion
  ];

  var state = {
    source: 'Local',      // 'all' | 'Provider' | 'Local' — Local selected by default
    models: '',           // '' = all models, else comma-separated selected names
    search: '',           // active wildcard query — while non-empty it derives the model selection
    searchSaved: null,    // the models value before the search began, restored on clear
    top: 25,              // 'all' or a number — scatter only
    psize: 'l',           // shared point-size setting: 's' | 'm' | 'l' — 'l' is the default
    metric: 'tokens'      // breakdown metric: 'tokens' (Context Used) | 'turns'
  };

  // Every parsed row from the markdown tables, in file order.
  var allRows = [];
  // Distinct successful model names, in order of first appearance.
  var modelOrder = [];
  // The row object currently pinned (clicked), or null. Stored as a row
  // reference (not an index) so it survives re-draws and is re-validated by
  // identity against the current point list.
  var pinned = null;
  // Rendering map for tooltip positioning: idx -> {row, left, top}.
  var pointPos = [];
  // Signature of the last chips render (models + selection) — used to avoid
  // re-rendering chips when nothing about them changed (preserves focus).
  var chipsSig = '';

  // Chart geometry (viewBox units; the SVG scales responsively).
  var M = { left: 84, right: 28, top: 44, bottom: 66 };
  var W = 920;
  var H = 560;
  var plotW = W - M.left - M.right;
  var plotH = H - M.top - M.bottom;

  // Shared point-size presets: glyph radius in viewBox units, used by BOTH
  // charts and their legends, so a mark means the same size everywhere. 'l'
  // (the default) doubles the original 6u circle — that is why marks stray
  // from Small: Large is the new default at twice the size; 's' restores the
  // original look, 'm' sits between. The scatter halo ring tracks the glyph
  // at 1.5x, as it always has (9 at the old 6).
  var P_SIZE = { s: 6, m: 9, l: 12 };
  function pointRadius() { return P_SIZE[state.psize] || P_SIZE.l; }

  // Dashed ring for KV quant "None": dashes scale with the glyph radius
  // (baseline 3.6 / 1.4 at the original 7u), so the None signal keeps its
  // proportions at any size in either chart. Trailing zeros are trimmed so a
  // whole-number dash still reads clean (5.1 2, not 5.1 2.0).
  function brkDash(r2) {
    var k = r2 / 7;
    function step(v) { return (k * v).toFixed(1).replace(/\.0$/, ''); }
    return step(3.6) + ' ' + step(1.4);
  }

  /* ------------------------------------------------------------------ *
   * Small utilities
   * ------------------------------------------------------------------ */

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('results-status--error', !!isError);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toInt(s) {
    var n = parseInt(String(s).replace(/[^\d]/g, ''), 10);
    return isFinite(n) ? n : NaN;
  }

  function fmt(n) {
    if (!isFinite(n)) return '—';
    return n.toLocaleString('en-US');
  }

  // Axis scale fitted to the data: pick a 1/2/5×10^n tick step for about
  // `target` ticks across the data max, then set the axis end to the next
  // multiple of that step. The last tick therefore always lands exactly on
  // the axis boundary, and the scale sits as tight to the data as the step
  // allows (e.g. data max 257, 4 target ticks -> step 100, end 300 — not
  // end 500 with the last tick stranded at 400).
  function niceAxis(max, target) {
    if (!isFinite(max) || max <= 0) return { max: 1, step: 1 };
    var raw = max / target;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    // 1e-9 guard: absorb float error when max is already an exact multiple
    // of step, so the end doesn't creep up one step past the data.
    var top = Math.ceil(max / step - 1e-9) * step;
    return { max: top, step: step };
  }

  function tickValues(max, step) {
    var out = [];
    for (var v = 0; v <= max + step * 0.0001; v += step) out.push(v);
    return out;
  }

  function formatTick(v) {
    // Round off float-accumulation artifacts from sub-unit tick steps
    // (e.g. 0.4 + 0.2 -> 0.6000000000000001) before rendering.
    v = Math.round(v * 1e6) / 1e6;
    if (v >= 1000) {
      var k = v / 1000;
      return (k % 1 === 0 ? String(k) : k.toFixed(1)) + 'k';
    }
    return String(v);
  }

  /* ------------------------------------------------------------------ *
   * Parsing — mirrors the structure of data/eval-results.md
   * ------------------------------------------------------------------ */

  function headerKey(h) {
    var s = h.toLowerCase();
    if (s.indexOf('model') !== -1) return 'model';
    if (s.indexOf('notes') !== -1) return 'notes';
    if (s.indexOf('duration') !== -1) return 'duration';
    if (s.indexOf('context') !== -1) return 'tokens';
    if (s.indexOf('turn') !== -1) return 'turns';
    if (s.indexOf('limit') !== -1) return 'limit';
    if (s.indexOf('exceeded') !== -1) return 'exceeded';
    if (s.indexOf('exit') !== -1) return 'code';
    if (s.indexOf('passed') !== -1) return 'passed';
    if (s.indexOf('failed') !== -1) return 'failed';
    if (s.indexOf('date') !== -1) return 'date';
    return '';
  }

  function parseTable(table, section) {
    var headers = Array.prototype.map.call(
      table.querySelectorAll('thead th'),
      function (th) { return th.textContent.trim(); }
    );
    Array.prototype.forEach.call(table.querySelectorAll('tbody tr'), function (tr) {
      var cells = Array.prototype.map.call(
        tr.querySelectorAll('td'),
        function (td) { return td.textContent.trim(); }
      );
      var row = { section: section };
      headers.forEach(function (h, i) {
        var k = headerKey(h);
        if (k) row[k] = cells[i] || '';
      });
      row.local = /local/i.test(section) || /^lmstudio/i.test(row.model || '');
      row.tokensN = toInt(row.tokens);
      row.turnsN = toInt(row.turns);
      row.limitN = toInt(row.limit);
      row.passedN = toInt(row.passed);
      row.failedN = toInt(row.failed);
      allRows.push(row);
    });
  }

  function parseMarkdown(md) {
    var content = document.createElement('div');
    content.innerHTML = marked.parse(md);
    var nodes = content.querySelectorAll('h1, h2, h3, table');
    var section = '';
    Array.prototype.forEach.call(nodes, function (node) {
      if (node.tagName === 'TABLE') {
        parseTable(node, section);
      } else {
        section = node.textContent.trim();
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Filtering
   * ------------------------------------------------------------------ */

  function isSuccessful(r) {
    return r.code === '0' && isFinite(r.tokensN) && isFinite(r.turnsN) && r.tokensN > 0;
  }

  // True when a row passes the current source filter ('all' includes both).
  function inSource(r) {
    if (!r.local && state.source === 'Local') return false;
    if (r.local && state.source === 'Provider') return false;
    return true;
  }

  // Distinct successful model names visible under the current source filter,
  // in order of first appearance — exactly the models offered as filter
  // chips, so the chip strip tracks the source (and vice versa).
  function sourceModels() {
    var out = [];
    allRows.forEach(function (r) {
      if (!isSuccessful(r) || !inSource(r)) return;
      if (out.indexOf(r.model) === -1) out.push(r.model);
    });
    return out;
  }

  // Drop model names from the current explicit selection (state.models) that
  // are not in the given model set, then collapse the list to its shortest
  // form: '' when the pruned selection spans every source model (or none),
  // otherwise the comma-joined subset. Explicit 'NONE' is left untouched.
  // Used on source changes so a stale selection from another source can't
  // silently hide runs or conflate counts.
  function pruneSelection(models) {
    if (state.models === 'NONE' || state.models === '') return;
    var pruned = state.models.split(',').filter(function (m) {
      return models.indexOf(m) !== -1;
    });
    if (pruned.length === 0 || pruned.length === models.length) state.models = '';
    else state.models = pruned.join(',');
  }

  /* ------------------------------------------------------------------ *
   * Model selection — wildcard search derives the selection while a
   * query is active; clearing the query restores the previous one.
   * ------------------------------------------------------------------ */

  // Turns a wildcard pattern into a RegExp against the search haystack.
  // '*' matches any run of characters, '?' exactly one. Patterns are matched
  // as substrings, so 'qwen3.6-27b', 'openrouter/*' and note fragments like
  // 'Q4' all find what the user means.
  function globToRegExp(pattern) {
    var p = String(pattern).toLowerCase();
    var re = '';
    for (var i = 0; i < p.length; i++) {
      var ch = p.charAt(i);
      if (ch === '*') re += '.*';
      else if (ch === '?') re += '.';
      else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^.*' + re + '.*$');
  }

  // The text a search pattern is tested against for one run: the model name
  // and the Notes joined by a NUL. The separator keeps literal (no-wildcard)
  // patterns inside a single field, while '*' and '?' can bridge the join —
  // so 'qwen3.8-27b*Q4' matches runs of a qwen3.8-27b model whose Notes
  // mention Q4, and 'Q2_K_XL' still only finds runs quantised at Q2_K_XL.
  function searchHaystack(r) {
    return String(r.model || '').toLowerCase() + '\u0000' +
      String(r.notes || '').toLowerCase();
  }

  // Models matching the current query, in source-scoped order; null when no
  // query is active. Used by the summary and the chip strip while a search is
  // active: a model counts as matching when the query matches its name, the
  // Notes of one of its successful runs in the current source, or a pattern
  // bridging name and Notes (so searching "Q4" finds every model with a run
  // at a Q4 quantisation, and "qwen3.8-27b*Q4" narrows that to qwen3.8-27b).
  // sourceModels() only returns models with at least one successful run in
  // the source, so testing the combined haystack of those runs also covers
  // name-only queries. The visible rows themselves are filtered individually
  // in visibleRows().
  // Memoized on (query, source) — searchMatches is consulted once per draw by
  // the summary and chips, so this avoids recomputing the same O(models×runs)
  // scan on every redraw.
  var searchMemoKey = null;
  var searchMemoVal = null;
  function searchMatches() {
    var q = state.search.trim();
    if (!q) return null;
    var key = q + '\u0000' + state.source;
    if (key === searchMemoKey) return searchMemoVal;
    var re = globToRegExp(q);
    var res = sourceModels().filter(function (m) {
      return allRows.some(function (r) {
        return r.model === m && isSuccessful(r) && inSource(r) &&
          re.test(searchHaystack(r));
      });
    });
    searchMemoKey = key;
    searchMemoVal = res;
    return res;
  }

  // The effective model selection: null = all models, array = explicit list.
  // A non-empty wildcard query overrides the manual selection.
  function effectiveSelection() {
    var matches = searchMatches();
    if (matches) return matches;
    if (state.models === 'NONE') return [];
    if (state.models === '') return null;
    return state.models.split(',');
  }

  function modelSelected(r) {
    var sel = effectiveSelection();
    if (sel === null) return true;
    return sel.indexOf(r.model) !== -1;
  }

  function visibleRows() {
    var searchQ = state.search.trim();
    var searchRe = searchQ ? globToRegExp(searchQ) : null;
    var rows = allRows.filter(function (r) {
      if (!isSuccessful(r) || !inSource(r)) return false;
      // A live wildcard search filters the rows themselves: a run is kept
      // only when the pattern matches its model name and/or Notes (see
      // searchHaystack). This makes "Q2_K_XL" show just the single run
      // quantised at Q2_K_XL instead of every run of the same model.
      if (searchRe) return searchRe.test(searchHaystack(r));
      if (!modelSelected(r)) return false;
      return true;
    });
    // "Top N" means best: the runs that used the LEAST context (less context
    // is better), so the top-N slice takes the ascending order; the slice is
    // applied only when every model is selected. (The ascending order also
    // gives label placement / hover priority to the least-context runs.)
    rows.sort(function (a, b) { return a.tokensN - b.tokensN; });
    if (effectiveSelection() === null && state.top !== 'all') {
      rows = rows.slice(0, state.top);
    }
    return rows;
  }

  function modelColor(model) {
    var i = modelOrder.indexOf(model);
    if (i === -1) return PALETTE[0];
    return PALETTE[i % PALETTE.length];
  }

  /* ------------------------------------------------------------------ *
   * Tooltip — notes first, then the numeric record
   * ------------------------------------------------------------------ */

  function tooltipHTML(r) {
    var color = modelColor(r.model);
    var html =
      '<div class="tip__head">' +
      '<span class="tip__dot" style="background:' + color + '"></span>' +
      '<span class="tip__model">' + esc(r.model) + '</span>' +
      '</div>' +
      '<div class="tip__tag">' + (r.local ? 'Local' : 'Provider') + ' · ' + esc(r.date || '—') + '</div>';
    if (r.notes) {
      var items = String(r.notes)
        .split(',')
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length > 0; });
      if (items.length) {
        html +=
          '<div class="tip__notes">' +
          '<span class="tip__notes-label">Notes</span>' +
          '<div class="tip__notes-list">' +
          items.map(function (item) {
            return '<span class="tip__chip">' + esc(item) + '</span>';
          }).join('') +
          '</div>' +
          '</div>';
      }
    }
    html +=
      '<dl class="tip__grid">' +
      '<dt>Context used</dt><dd>' + fmt(r.tokensN) + ' tokens</dd>' +
      '<dt>Turns</dt><dd>' + fmt(r.turnsN) + '</dd>' +
      '<dt>Duration</dt><dd>' + esc(r.duration || '—') + '</dd>' +
      '<dt>Limit</dt><dd>' + fmt(r.limitN) + '</dd>' +
      '</dl>';
    return html;
  }

  function showTooltip(idx) {
    var p = pointPos[idx];
    if (!p) return;
    tooltipEl.innerHTML = tooltipHTML(p.row);
    tooltipEl.classList.remove('is-hidden');
    var margin = 16;
    var flipLeft = p.left > 62;
    var below = p.top < 34;
    tooltipEl.classList.toggle('tip--flip', flipLeft);
    tooltipEl.classList.toggle('tip--down', below);
    tooltipEl.style.left = (flipLeft ? p.left - margin : p.left + margin) + '%';
    tooltipEl.style.top = (below ? p.top + margin : p.top - margin) + '%';
  }

  function hideTooltip() {
    if (pinned === null) tooltipEl.classList.add('is-hidden');
  }

  // Finds the current index of the pinned row (or -1 if it was filtered out)
  // and reflects the pin in the DOM + tooltip. Identity-based, so a pin never
  // jumps to a different run after a re-draw; a pin whose row disappears is
  // dropped entirely (no ghost tooltip).
  function updatePin() {
    var pinnedIdx = -1;
    if (pinned) {
      for (var i = 0; i < pointPos.length; i++) {
        if (pointPos[i].row === pinned) { pinnedIdx = i; break; }
      }
      if (pinnedIdx === -1) pinned = null; // row no longer visible — drop the pin
    }
    Array.prototype.forEach.call(chartEl.querySelectorAll('.pt'), function (g) {
      g.classList.toggle('pt--pinned', +g.getAttribute('data-idx') === pinnedIdx);
    });
    if (pinnedIdx !== -1) showTooltip(pinnedIdx);
    else hideTooltip();
  }

  /* ------------------------------------------------------------------ *
   * Label placement — deterministic per-row placement in plot coordinates.
   * A label is drawn only when its bounding box fits inside the plot and
   * does not touch any other point or already-placed label; otherwise the
   * point stays unlabelled (cleaner than a cluttered chart).
   * ------------------------------------------------------------------ */

  // Short on-plot name: last path segment when unambiguous among the visible
  // models, otherwise last two segments, otherwise the machine-qualified name.
  function labelTextFor(model, visible) {
    var clean = model.replace(/^lmstudio-/, '').replace(/^openrouter\//, '').replace(/^mistral\//, '');
    var parts = clean.split('/');
    var base = parts[parts.length - 1];
    var dup = visible.some(function (m) {
      return m !== model && m.split('/')[m.split('/').length - 1] === base;
    });
    if (!dup) return base;
    if (parts.length >= 2) {
      var two = parts.slice(parts.length - 2).join('/');
      var dup2 = visible.some(function (m) {
        return m !== model && m.replace(/^lmstudio-/, '').replace(/^openrouter\//, '').replace(/^mistral\//, '').split('/').slice(-2).join('/') === two;
      });
      if (!dup2) return two;
    }
    return clean;
  }

  function placeLabels(rows, xF, yF) {
    var plotLeft = M.left + 4;
    var plotRight = M.left + plotW - 4;
    var plotTop = M.top + 4;
    var plotBottom = M.top + plotH - 4;

    var visible = [];
    rows.forEach(function (r) {
      if (visible.indexOf(r.model) === -1) visible.push(r.model);
    });
    var labelText = {};
    visible.forEach(function (m) { labelText[m] = labelTextFor(m, visible); });

    var placed = [];
    var out = [];

    rows.forEach(function (r) {
      var px = xF(r.tokensN);
      var py = yF(r.turnsN);
      var text = labelText[r.model];
      // Label offset and point clearance scale with the point radius (the
      // halo ring sits at 1.5x the glyph), so labels keep breathing at any
      // size selection: off-center pad = halo + 3, point clash = halo + 2.
      var pad = pointRadius() * 1.5 + 3;
      var clashPad = pointRadius() * 1.5 + 2;
      var w = text.length * 6.6 + 6;
      var hw = 10; // half-height of the label box
      var x0, x1, anchorEnd = false;

      if (px + pad + w <= plotRight) {
        x0 = px + pad;
        x1 = px + pad + w;
      } else if (px - pad - w >= plotLeft) {
        x0 = px - pad - w;
        x1 = px - pad;
        anchorEnd = true;
      } else {
        return; // no room horizontally
      }

      var y0 = py - hw;
      var y1 = py + hw;
      if (y0 < plotTop || y1 > plotBottom) return; // out of plot vertically

      // Collision with any other point (halo radius -> +2 to breathe).
      var clash = rows.some(function (q) {
        if (q === r) return false;
        var qx = xF(q.tokensN);
        var qy = yF(q.turnsN);
        return x0 < qx + clashPad && x1 > qx - clashPad && y0 < qy + clashPad && y1 > qy - clashPad;
      });
      if (clash) return;

      // Collision with any already-placed label.
      clash = placed.some(function (b) {
        return x0 < b.x1 + 4 && x1 > b.x0 - 4 && y0 < b.y1 && y1 > b.y0;
      });
      if (clash) return;

      placed.push({ x0: x0, x1: x1, y0: y0, y1: y1 });
      out.push({ row: r, cx: px, cy: py, text: text, anchorEnd: anchorEnd, pad: pad });
    });

    return out;
  }

  /* ------------------------------------------------------------------ *
   * Drawing
   * ------------------------------------------------------------------ */

  function draw() {
    // Build the quant->glyph order up front: the scatter's glyphs depend on
    // it too, so that must not rely on the breakdown element existing.
    buildQuantOrder();
    drawBreakdown();
    var rows = visibleRows();
    pointPos = [];

    if (!rows.length) {
      chartEl.innerHTML = '';
      tooltipEl.classList.add('is-hidden');
      pinned = null;
      if (vizLegendEl) vizLegendEl.innerHTML = '';
      lastVizShown = [];   // don't let a resize resurrect a legend for an empty chart
      if (summaryEl) {
        var q = state.search.trim();
        var matches = searchMatches();
        if (q && matches && matches.length === 0) {
          summaryEl.textContent = 'No runs match search "' + q + '".';
        } else if (state.models === 'NONE') {
          summaryEl.textContent = 'No models selected.';
        } else if (state.models && state.models.split(',').filter(function (m) {
          return sourceModels().indexOf(m) === -1;
        }).length > 0) {
          summaryEl.textContent = 'Selected models are not present in this source.';
        } else {
          summaryEl.textContent = 'No runs match the current filters.';
        }
      }
      syncControls();
      renderChips();
      return;
    }

    var maxTokens = 0;
    var maxTurns = 0;
    rows.forEach(function (r) {
      if (r.tokensN > maxTokens) maxTokens = r.tokensN;
      if (r.turnsN > maxTurns) maxTurns = r.turnsN;
    });

    var xAxis = niceAxis(maxTokens, 6);
    var yAxis = niceAxis(maxTurns, 5);
    var xMax = xAxis.max;
    var stepX = xAxis.step;
    var yMax = yAxis.max;
    var stepY = yAxis.step;
    var xs = tickValues(xMax, stepX);
    var ys = tickValues(yMax, stepY);

    function x(v) { return M.left + (v / xMax) * plotW; }
    function y(v) { return M.top + plotH - (v / yMax) * plotH; }

    var anchors = placeLabels(rows, x, y);

    var out = [];

    // --- SVG wrapper -------------------------------------------------
    out.push(
      '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="group" ' +
      'aria-label="Scatter plot of total context used against turns for successful evaluation runs; ' +
      'point shape marks weight quant, outline KV quant, fill model colour">'
    );

    // --- Best-quadrant tint: the plot splits into four quadrants at the
    // midpoints of both axes. The bottom-left quadrant (least context AND
    // fewest turns) is shaded strongest; the two adjacent quadrants step down;
    // the top-right (most context, most turns) is faintest. Hard, crisp edges
    // at each dashed quadrant boundary replace the old diagonal fade, so the
    // best region reads unambiguously. Drawn before the grid. ---
    var best = '#5D6B82';
    var midX = M.left + plotW / 2;
    var midY = M.top + plotH / 2;
    // [x, y, w, h, opacity]
    var quadrants = [
      [M.left, midY,  plotW / 2, plotH / 2, 0.14], // bottom-left:  least context, fewest turns (BEST)
      [midX,   midY,  plotW / 2, plotH / 2, 0.07], // bottom-right: least context, many turns
      [M.left, M.top, plotW / 2, plotH / 2, 0.07], // top-left:     much context, fewest turns
      [midX,   M.top, plotW / 2, plotH / 2, 0.03]  // top-right:    much context, many turns (worst)
    ];
    quadrants.forEach(function (q) {
      out.push(
        '<rect x="' + q[0] + '" y="' + q[1] + '" width="' + q[2] + '" height="' + q[3] + '" ' +
        'fill="' + best + '" fill-opacity="' + q[4] + '" ' +
        'pointer-events="none" aria-hidden="true" focusable="false"/>'
      );
    });
    // Dashed quadrant boundary lines (distinct from the solid grid lines) so
    // the best-region edges are explicit.
    out.push('<line class="quad-bound" x1="' + midX + '" y1="' + M.top + '" x2="' + midX + '" y2="' + (M.top + plotH) + '"/>');
    out.push('<line class="quad-bound" x1="' + M.left + '" y1="' + midY + '" x2="' + (M.left + plotW) + '" y2="' + midY + '"/>');

    // --- Vertical grid + X labels ------------------------------------
    xs.forEach(function (v) {
      var px = x(v);
      out.push('<line class="grid-v" x1="' + px + '" y1="' + M.top + '" x2="' + px + '" y2="' + (M.top + plotH) + '"/>');
      // Middle-anchored (like the breakdown axis) so the last tick — which
      // always sits on the right plot edge — can't overrun the viewBox.
      out.push('<text class="axis-label" x="' + px + '" y="' + (M.top + plotH + 24) + '" text-anchor="middle">' + formatTick(v) + '</text>');
    });
    // --- Horizontal grid + Y labels ----------------------------------
    ys.forEach(function (v) {
      var py = y(v);
      out.push('<line class="grid-h" x1="' + M.left + '" y1="' + py + '" x2="' + (M.left + plotW) + '" y2="' + py + '"/>');
      out.push('<text class="axis-label" x="' + (M.left - 12) + '" y="' + (py + 4) + '" text-anchor="end">' + formatTick(v) + '</text>');
    });

    // --- Frame --------------------------------------------------------
    out.push('<line class="grid-frame" x1="' + M.left + '" y1="' + M.top + '" x2="' + (M.left + plotW) + '" y2="' + M.top + '"/>');
    out.push('<line class="grid-frame" x1="' + M.left + '" y1="' + (M.top + plotH) + '" x2="' + (M.left + plotW) + '" y2="' + (M.top + plotH) + '"/>');
    out.push('<line class="grid-frame" x1="' + M.left + '" y1="' + M.top + '" x2="' + M.left + '" y2="' + (M.top + plotH) + '"/>');

    // --- Axis titles ---------------------------------------------------
    out.push(
      '<text class="axis-title" x="' + (M.left + plotW / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' +
      'Total Context Used (tokens)</text>'
    );
    out.push(
      '<text class="axis-title axis-title--y" x="26" y="' + (M.top + plotH / 2) + '" ' +
      'transform="rotate(-90 26 ' + (M.top + plotH / 2) + ')" text-anchor="middle">Turns</text>'
    );

    // --- Labels (drawn before points so points stay readable) ---------
    anchors.forEach(function (a) {
      var fill = modelColor(a.row.model);
      var tx = a.anchorEnd ? a.cx - a.pad : a.cx + a.pad;
      out.push(
        '<text class="pt-label" x="' + tx + '" y="' + a.cy + '" fill="' + fill + '" ' +
        (a.anchorEnd ? 'text-anchor="end"' : '') + '>' + esc(a.text) + '</text>'
      );
    });

    // --- Points ---------------------------------------------------------
    rows.forEach(function (r, i) {
      var px = x(r.tokensN);
      var py = y(r.turnsN);
      var c = modelColor(r.model);
      pointPos[i] = {
        row: r,
        left: (px / W) * 100,
        top: (py / H) * 100
      };
      // Glyph marks mirror the range chart below: shape carries the weight
      // quant and the outline the KV quant, so a run reads the same in both
      // charts; only the fill changes meaning, to the model colour. brkMark /
      // brkShape / brkQuant / brkKV live in the breakdown section further
      // down, and drawBreakdown() (called at the top of draw) has already
      // built BRK_QUANTS by the time we get here.
      var rpt = pointRadius();
      var kv = brkKV(r);
      var q = brkQuant(r);
      out.push(
        '<g class="pt" data-idx="' + i + '" tabindex="0" role="button" ' +
        'aria-label="' + esc(r.model) + ': ' + fmt(r.tokensN) + ' tokens, ' + fmt(r.turnsN) + ' turns' +
        (q ? ', quant ' + esc(q) : '') + (kv ? ', KV quant ' + esc(kv) : '') + '">' +
        '<circle cx="' + px + '" cy="' + py + '" r="' + (rpt * 1.5) + '" class="pt__halo"/>' +
        brkMark(brkShape(q), px, py, rpt, c, brkKVColor(kv),
          kv === 'None' ? brkDash(rpt) : null) +
        '</g>'
      );
    });

    // --- Best-region marker: drawn after the points but non-interactive, so
    // it stays legible without ever blocking hover/click on a data point.
    out.push(
      '<text class="best-label" x="' + (M.left + 12) + '" y="' + (M.top + plotH - 12) + '" ' +
      'pointer-events="none" aria-hidden="true" focusable="false">best region</text>'
    );

    out.push('</svg>');

    chartEl.innerHTML = out.join('');
    bindPoints();
    renderChips();
    renderVizLegend(rows);
    updatePin();
    renderSummary(rows);
  }

  function renderSummary(rows) {
    if (!summaryEl) return;
    var scope = state.source === 'all'
      ? 'all sources'
      : (state.source === 'Provider' ? 'provider runs' : 'local runs');
    // Total successful runs within the current source scope (before the
    // model selection and top-N limit) — so "of N" is not misleading.
    var scopeTotal = allRows.filter(function (r) {
      return isSuccessful(r) && inSource(r);
    }).length;
    var models = sourceModels();
    var sel = effectiveSelection();
    // Count selections among the models visible in this source, so a manual
    // selection left over from another source doesn't inflate "of N".
    var selectedCount = sel === null ? models.length : sel.filter(function (m) {
      return models.indexOf(m) !== -1;
    }).length;
    var q = state.search.trim();
    var text = 'Showing ' + rows.length + ' of ' + scopeTotal + ' successful runs (' + scope;
    if (q) text += '; ' + selectedCount + ' of ' + models.length + ' models have runs matching "' + q + '"';
    else if (state.models === 'NONE') text += '; no models selected';
    else if (state.models) text += '; ' + selectedCount + ' of ' + models.length + ' models';
    else text += '; all ' + models.length + ' models';
    text += ').';
    if (effectiveSelection() === null && state.top !== 'all') text += ' Least context first.';
    summaryEl.textContent = text;
  }

  // Model chips — one per model, rendered into the filter bar. Active chips
  // keep their colour; clicking toggles a model in/out of the selection.
  // While a wildcard search is active the strip narrows to the matching
  // models (all selected by the search) and shows a match count. Re-renders
  // only when the set of models, the selection, or the query changes, so
  // keyboard focus on the chips survives unrelated re-draws.
  function renderChips() {
    if (!chipsEl) return;
    var models = sourceModels();
    var sel = effectiveSelection();
    var selKey = sel === null ? '*' : sel.join(',');
    var sig = state.search + '|' + selKey + '|' + models.join(',');
    if (sig === chipsSig) return;
    chipsSig = sig;

    var matches = searchMatches();
    var bySearch = !!matches;
    var list = bySearch ? matches : models.slice();
    var isActive = function (m) { return sel === null || sel.indexOf(m) !== -1; };

    var html = list.map(function (m) {
      var active = isActive(m);
      return (
        '<button type="button" class="model-chip' + (active ? ' is-active' : '') + '" ' +
        'data-model="' + esc(m) + '" style="--modcol:' + modelColor(m) + '" ' +
        'aria-pressed="' + String(active) + '">' +
        '<span class="chip-dot" style="background:' + modelColor(m) + '"></span>' +
        '<span class="chip-name">' + esc(m) + '</span>' +
        '</button>'
      );
    }).join('');
    chipsEl.innerHTML = html;

    if (searchCountEl) {
      var q = state.search.trim();
      searchCountEl.textContent = bySearch
        ? list.length + ' of ' + models.length + ' models have matching runs' + (q ? ' "' + q + '"' : '')
        : '';
    }
    if (searchClearEl) searchClearEl.hidden = !bySearch;
    updateModelsSummary();

    Array.prototype.forEach.call(chipsEl.querySelectorAll('.model-chip'), function (btn) {
      btn.addEventListener('click', function () {
        var m = btn.getAttribute('data-model');
        var wasSearch = state.search !== '';
        // Clicking a chip exits search mode and switches to an explicit model
        // selection. Unconditionally cancel any pending debounce and clear
        // leftover search text (state or un-applied), so a stale timer can't
        // re-enter search mode and the input can't keep showing a query that
        // no longer drives the chart.
        clearTimeout(searchTimer);
        state.search = '';
        state.searchSaved = null;
        if (searchInput) searchInput.value = '';
        var base = sourceModels();
        var sel;
        if (wasSearch) {
          // Every chip shown during a search is a match and renders pressed,
          // but a notes-only match (e.g. "Q2_K_XL") shows only some of the
          // model's runs. Toggling from that pressed state would invert the
          // selection to "everything except this model" — the opposite of
          // what the pressed chip implies — so pin the clicked model exactly;
          // further clicks then work in normal toggle mode.
          sel = [m];
        } else {
          // From "all": start from the source's models; from "none": start
          // from nothing; otherwise start from the current explicit
          // selection, pruned to models that still exist in this source (a
          // selection built in one source can stale-out once the source
          // changes).
          sel = state.models === '' ? base.slice()
            : (state.models === 'NONE' ? []
              : state.models.split(',').filter(function (x) { return base.indexOf(x) !== -1; }));
          var i = sel.indexOf(m);
          if (i === -1) sel.push(m);
          else sel.splice(i, 1);
        }
        state.models = sel.length === base.length ? ''
          : (sel.length === 0 ? 'NONE' : sel.join(','));
        syncControls();
        draw();
        // draw() re-renders the chip strip; restore keyboard focus to the
        // chip just toggled so tabbing through models keeps working. The
        // lookup compares attribute values rather than building a CSS
        // selector, so model names with special characters can't break it.
        var el = Array.prototype.find.call(chipsEl.querySelectorAll('.model-chip'), function (b) {
          return b.getAttribute('data-model') === m;
        });
        if (el) el.focus();
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Interactions
   * ------------------------------------------------------------------ */

  // Guard against a keydown-triggered pin being immediately un-pinned by a
  // browser/AT-synthesised click on the same element (role="button").
  var suppressNextClick = false;

  function bindPoints() {
    Array.prototype.forEach.call(chartEl.querySelectorAll('.pt'), function (g) {
      var idx = +g.getAttribute('data-idx');
      var row = function () { return pointPos[idx] && pointPos[idx].row; };
      g.addEventListener('mouseenter', function () { showTooltip(idx); });
      g.addEventListener('mouseleave', function () { hideTooltip(); });
      g.addEventListener('focus', function () { showTooltip(idx); });
      g.addEventListener('blur', function () { hideTooltip(); });
      g.addEventListener('click', function () {
        if (suppressNextClick) { suppressNextClick = false; return; }
        if (!row()) return;
        pinned = pinned === row() ? null : row();
        updatePin();
      });
      g.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (!row()) return;
        pinned = pinned === row() ? null : row();
        suppressNextClick = true;
        updatePin();
      });
    });
  }

  // Escape clears both pinned marks (scatter and breakdown) in one pass, so
  // a single keypress never leaves one chart's tooltip flashing.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (brkPinned) { brkPinned = null; markPinned(null); hideBrkTpt(); }
    if (pinned) { pinned = null; updatePin(); }
  });

  // Original option labels for the runs-to-show select, restored when the
  // control is re-enabled. When models are selected the chart shows all runs
  // of those models, so a stale "25 with least context" label would mislead.
  var topOptionTexts = {};
  if (topSel) {
    Array.prototype.forEach.call(topSel.querySelectorAll('option'), function (o) {
      topOptionTexts[o.value] = o.textContent;
    });
  }

  function syncControls() {
    sourceBtns.forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-source') === state.source));
      btn.classList.toggle('is-active', btn.getAttribute('data-source') === state.source);
    });
    psizeBtns.forEach(function (btn) {
      var on = btn.getAttribute('data-psize') === state.psize;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
    });
    if (topSel) {
      // All models (no search, no explicit selection) is the only mode where
      // the top-N limit applies.
      var allMode = effectiveSelection() === null;
      topSel.disabled = !allMode;
      topSel.value = String(state.top);
      var opt = topSel.selectedOptions[0];
      if (opt && topOptionTexts[String(state.top)]) {
        opt.textContent = allMode ? topOptionTexts[String(state.top)] : 'All runs (model filter active)';
      }
    }
  }

  /* ------------------------------------------------------------------ *
/* ------------------------------------------------------------------ *
   * Model breakdown — a second chart on the same page.
   *
   * One row per model, one metric at a time (Context Used or Turns, toggled
   * by the metric control). Each row spans the model's smallest to largest
   * value on a shared metric axis; every mark sits at its own run. A run is
   * encoded three ways at once: fill is its status (carbon = success, red =
   * failed), outline colour is its actual KV quant value (Q4_0, Q8_0, None…),
   * and glyph shape is its weight quant (Q4_K_XL, Q8_0…). The metric axis is
   * pinned above the rows so it never scrolls out of sight, and every mark
   * opens the same tooltip as the scatter on hover or focus. Props shared
   * with the scatter (source / model / search).
   * ------------------------------------------------------------------ */

  var BRK_OK = '#2E4A7A';      // success fill
  var BRK_FAIL = '#B42318';    // failed fill
  var BRK_INK = '#16202E';
  var outMarks = {};           // data-brk id -> row, for tooltip binding
  var BRK_LABEL = 258;         // model-name column width
  var BRK_ROW = 34;            // height of each model row
  var BRK_AXH = 34;            // height of the pinned metric axis

  // Glyph shapes for weight-quant values. Every distinct quant value gets a
  // distinct, stable symbol: distribution steps through this ordered pool
  // (never wrapping), so two quants can't share a mark - IQ3_XXS and Q8_0 no
  // longer collide as they did for the old six-shape pool that wrapped via
  // modulo. The pool is ordered by visual distinction: compact polygons
  // first, then pointed polygons and spiked stars. brkShape() falls back past
  // the pool to generated higher-order polygons, so a quant value new in a
  // future results file still takes an unused symbol.
  var BRK_SHAPES = [
    'circle', 'square', 'diamond',
    'tri-up', 'tri-down', 'tri-left', 'tri-right',
    'gon5', 'gon6', 'gon7', 'gon8', 'gon9', 'gon10',
    'star4', 'star5', 'star6', 'star8', 'star10'
  ];
  var BRK_QUANTS = [];
  function brkQuant(r) {
    var m = String(r.notes || '').match(/quant:\s*([^,\s]+)/);
    return m ? m[1].trim() : '';
  }
  function buildQuantOrder() {
    BRK_QUANTS = [];
    allRows.forEach(function (r) {
      var q = brkQuant(r);
      if (q && BRK_QUANTS.indexOf(q) === -1) BRK_QUANTS.push(q);
    });
    BRK_QUANTS.sort();
  }
  function brkShape(q) {
    var i = BRK_QUANTS.indexOf(q);
    if (i < 0) i = 0;
    if (i < BRK_SHAPES.length) return BRK_SHAPES[i];
    // Beyond the hand-picked pool: generating distinct high-vertex polygons
    // keeps a jam of new quants from ever reusing a symbol in use.
    return 'gon' + (11 + (i - BRK_SHAPES.length));
  }

  // Actual KV cache value → stroke ("ring") colour, so the axis legend and the
  // marks tell Q4_0 from Q8_0 from None apart instead of only "set" vs "none".
  var BRK_KVCOL = {
    'Q4_0': '#0E7A7B',
    'Q8_0': '#A86A2B',
    'None': '#7A4A6B',
    '':     '#9AA7B5'
  };
  function brkKV(r) {
    var m = String(r.notes || '').match(/KV quant:\s*([^,\s]+)/);
    return m ? m[1].trim() : '';
  }
  function brkKVColor(kv) {
    return BRK_KVCOL[kv] !== undefined ? BRK_KVCOL[kv] : '#1F6F8F';
  }

  function brkRow(r) {
    if (!inSource(r)) return false;
    var sel = effectiveSelection();
    if (sel && sel.indexOf(r.model) === -1) return false;
    var q = state.search.trim();
    if (q) {
      return globToRegExp(q).test(searchHaystack(r));
    }
    return true;
  }

  // Vertex lists for the regular-polygon and spiked-star glyphs.
  function polyPts(cx, cy, r, n, rot) {
    var pts = [];
    for (var i = 0; i < n; i++) {
      var a = (rot + i * 360 / n) * Math.PI / 180;
      pts.push((cx + r * Math.cos(a)).toFixed(1) + ' ' + (cy + r * Math.sin(a)).toFixed(1));
    }
    return pts;
  }
  // Spiked star: 2n vertices alternating between an outer and inner radius.
  function starPts(cx, cy, rO, rI, n, rot) {
    var pts = [];
    for (var i = 0; i < 2 * n; i++) {
      var a = (rot + i * 180 / n) * Math.PI / 180;
      var rr = i % 2 === 0 ? rO : rI;
      pts.push((cx + rr * Math.cos(a)).toFixed(1) + ' ' + (cy + rr * Math.sin(a)).toFixed(1));
    }
    return pts;
  }

  // One SVG run-mark for the breakdown: fill carries status, stroke carries KV
  // value, shape carries quant weight. Any BRK_SHAPES entry (or a generated
  // gon-N fallback) renders here. `dash` is a full stroke-dasharray value or
  // null: both charts pass a brkDash() value so the None ring keeps its
  // proportions at any glyph radius.
  function brkMark(shape, cx, cy, r2, fill, kv, dash) {
    var s = 'fill="' + fill + '" stroke="' + kv + '" stroke-width="2.5"' +
      (dash ? ' stroke-dasharray="' + dash + '"' : '');
    var pts, n = 0, rot = 0;
    var star = shape.match(/^star(\d+)$/);
    if (star) {
      pts = starPts(cx, cy, r2, r2 * 0.45, +star[1], -90);
      return '<polygon points="' + pts.join(' ') + '" ' + s + '/>';
    }
    var gon = shape.match(/^gon(\d+)$/);
    if (gon) {
      pts = polyPts(cx, cy, r2, +gon[1], -90);
      return '<polygon points="' + pts.join(' ') + '" ' + s + '/>';
    }
    if (shape === 'square' || shape === 'diamond') { n = 4; rot = shape === 'diamond' ? 0 : 45; }
    else if (shape === 'tri-up') { n = 3; rot = -90; }
    else if (shape === 'tri-down') { n = 3; rot = 90; }
    else if (shape === 'tri-left') { n = 3; rot = 180; }
    else if (shape === 'tri-right') { n = 3; rot = 0; }
    if (n) {
      pts = polyPts(cx, cy, r2, n, rot);
      return '<polygon points="' + pts.join(' ') + '" ' + s + '/>';
    }
    return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r2 + '" ' + s + '/>';
  }

  function brkTruncate(text, width) {
    var s = String(text || '');
    if (s.length * 6.1 + 2 <= width) return s;
    while (s.length > 2 && s.length * 6.1 + 2 > width - 13) s = s.slice(0, -1);
    return s + '\u2026';
  }

  function brkLabel(m, width, models) {
    var clean = String(m).replace(/^lmstudio-/, '').replace(/^openrouter\//, '').replace(/^mistral\//, '');
    var parts = clean.split('/');
    var n = 1;
    while (n < parts.length) {
      var seg = parts.slice(parts.length - n).join('/');
      var dup = models.some(function (o) {
        return o !== m && String(o).replace(/^lmstudio-/, '').replace(/^openrouter\//, '').replace(/^mistral\//, '')
          .split('/').slice(-n).join('/') === seg;
      });
      if (!dup) break;
      n++;
    }
    var label = parts.slice(parts.length - n).join('/');
    return label.length * 6.1 + 2 <= width ? label : brkTruncate(label, width);
  }

  function brkLegendLabel(kv) {
    if (kv === '') return 'unrecorded';
    if (kv === 'None') return 'None';
    return kv;
  }

  // px per viewBox unit at the current layout. Both charts use a 920-unit
  // viewBox rendered at the content-column width, so this single number is
  // the exact on-screen size of one chart unit. The legend swatches are
  // drawn at this scale, making a legend glyph EXACTLY the on-chart glyph
  // size at any viewport. Falls back to 1 (stub DOMs / not yet laid out)
  // until a real chart width is measurable.
  var legendPxUnit = 1;
  function refreshLegendScale() {
    var e = chartEl && chartEl.querySelector ? chartEl.querySelector('.chart-svg') : null;
    if (!e) e = chartEl;
    if (!e) return;
    var w = e.getBoundingClientRect().width;
    if (w > 0) legendPxUnit = w / 920;
  }

  // Legend swatch: the glyph drawn at the ACTIVE point radius inside a
  // viewBox that fits it, rendered at legendPxUnit CSS px per viewBox unit —
  // so the swatch diameter equals the on-chart glyph diameter at the current
  // point-size setting AND viewport, and the whole legend grows/shrinks with
  // the control.
  function legendSwatch(markHtml, r2) {
    var side = r2 * 2 + 8;
    var px = Math.round(side * legendPxUnit * 100) / 100;
    return '<svg viewBox="0 0 ' + side + ' ' + side + '" width="' + px + '" height="' + px +
      '" aria-hidden="true">' + markHtml + '</svg>';
  }

  // Legend dot diameter in CSS px (status fill in the breakdown, model fill
  // in the scatter): matches the swatch glyph diameter so all legend marks
  // agree with each other and with the plot.
  function legendDotPx() { return Math.max(2, Math.round(pointRadius() * 2 * legendPxUnit)); }

  // Live row sets for the two legends, so a window resize can re-render them
  // at the corrected scale without touching the charts.
  var lastVizShown = [];
  var lastBrkShown = [];

  // Legend sections shared by both charts: the Quant shape keys and the KV
  // quant ring keys, each built from the runs actually shown (so the legend
  // always matches the plot) and each drawn at the active point radius (so
  // the legend matches the plot's size too). Empty when no run in the group.
  function legendQuantPart(shown) {
    var quants = [];
    shown.forEach(function (r) {
      var q = brkQuant(r);
      if (q && quants.indexOf(q) === -1 && BRK_QUANTS.indexOf(q) !== -1) quants.push(q);
    });
    if (!quants.length) return '';
    var parts = ['<span class="legend-label">Quant</span>'];
    var rc = pointRadius();
    var cc = rc + 4;
    BRK_QUANTS.forEach(function (q) {
      if (quants.indexOf(q) === -1) return;
      var sh = brkShape(q);
      parts.push('<span class="legend-key">' +
        legendSwatch(brkMark(sh, cc, cc, rc, BRK_OK, BRK_INK, null), rc) + esc(q) + '</span>');
    });
    return parts.join('');
  }

  function legendKVPart(shown) {
    var kvs = [];
    shown.forEach(function (r) {
      var kv = brkKV(r);
      if (kvs.indexOf(kv) === -1) kvs.push(kv);
    });
    if (!kvs.length) return '';
    // stable order: recorded values (sorted), then None, then unrecorded.
    kvs.sort(function (a, b) {
      function rank(x) { return x === '' ? 2 : x === 'None' ? 1 : 0; }
      return (rank(a) - rank(b)) || String(a).localeCompare(String(b));
    });
    var parts = ['<span class="legend-label">KV quant</span>'];
    var rc = pointRadius();
    var cc = rc + 4;
    // Same 2.5u stroke as the plot rings (brkMark), so a legend ring matches
    // the on-chart rings exactly at any scale.
    kvs.forEach(function (kv) {
      var c = kv === '' ? BRK_KVCOL[''] : kv === 'None' ? BRK_KVCOL['None'] : brkKVColor(kv);
      parts.push('<span class="legend-key">' +
        legendSwatch('<circle cx="' + cc + '" cy="' + cc + '" r="' + rc + '" fill="' + BRK_OK +
          '" stroke="' + c + '" stroke-width="2.5"' +
          (kv === 'None' ? ' stroke-dasharray="' + brkDash(rc) + '"' : '') + '/>', rc) +
        esc(brkLegendLabel(kv)) + '</span>');
    });
    return parts.join('');
  }

  function renderBreakdownLegend(shown) {
    if (!brkLegendEl) return;
    refreshLegendScale();
    lastBrkShown = shown.slice();
    var dot = legendDotPx();
    var parts = [];
    parts.push('<span class="legend-label">Status</span>');
    parts.push('<span class="legend-key"><span class="lg" style="background:' + BRK_OK + ';width:' + dot + 'px;height:' + dot + 'px"></span>success</span>');
    parts.push('<span class="legend-key"><span class="lg" style="background:' + BRK_FAIL + ';width:' + dot + 'px;height:' + dot + 'px"></span>failed</span>');
    parts.push(legendQuantPart(shown));
    parts.push(legendKVPart(shown));
    brkLegendEl.innerHTML = parts.join('');
  }

  // Scatter legend — same Quant/KV decoding as the range chart, plus the
  // Model fill colour (the one channel the scatter's glyphs add). Rebuilt on
  // every scatter draw from the rows actually shown, so it tracks the
  // filters, the top-N limit and the wildcard search exactly as the plot does.
  function renderVizLegend(shown) {
    if (!vizLegendEl) return;
    refreshLegendScale();
    lastVizShown = shown.slice();
    var parts = [];
    var models = [];
    shown.forEach(function (r) {
      if (models.indexOf(r.model) === -1) models.push(r.model);
    });
    if (models.length) {
      parts.push('<span class="legend-label">Model</span>');
      var dot = legendDotPx();
      models.forEach(function (m) {
        parts.push('<span class="legend-key"><span class="lg" style="background:' + modelColor(m) +
          ';border-radius:50%;width:' + dot + 'px;height:' + dot + 'px"></span>' + esc(m) + '</span>');
      });
    }
    parts.push(legendQuantPart(shown));
    parts.push(legendKVPart(shown));
    vizLegendEl.innerHTML = parts.join('');
  }

  function showBrkTpt(g, r) {
    if (!brkTpt || !brkPlotEl) return;
    brkTpt.innerHTML = tooltipHTML(r);
    var pr = brkPlotEl.getBoundingClientRect();
    var gr = g.getBoundingClientRect();
    if (!pr.width || !pr.height) return;
    var cx = ((gr.left + gr.right) / 2 - pr.left) / pr.width * 100;
    var cy = (gr.top - pr.top) / pr.height * 100;
    if (cy < 0) cy = 0;
    if (cx < 8) cx = 8;
    if (cx > 92) cx = 92;
    var below = cy < 18;
    var flip = cx > 72;   // card would spill past the right edge — align right
    brkTpt.classList.toggle('tip--flip', flip);
    brkTpt.classList.toggle('tip--down', below);
    brkTpt.style.left = cx + '%';
    brkTpt.style.top = (below ? cy + 9 : cy) + '%';
    brkTpt.classList.remove('is-hidden');
  }
  function hideBrkTpt() {
    if (!brkTpt) return;
    if (brkPinned) return;   // a pinned mark keeps its card open
    brkTpt.classList.add('is-hidden');
  }

  function drawBreakdown() {
    if (!brkEl) return;
    buildQuantOrder();
    outMarks = {};
    hideBrkTpt();

    var metric = state.metric === 'turns' ? 'turns' : 'tokens';
    var mKey = metric === 'turns' ? 'turnsN' : 'tokensN';
    var mLabel = metric === 'turns' ? 'Turns' : 'Context Used (tokens)';

    var byModel = {}, order = [];
    allRows.forEach(function (r) {
      if (!brkRow(r)) return;
      if (!byModel[r.model]) { byModel[r.model] = []; order.push(r.model); }
      byModel[r.model].push(r);
    });

    if (!order.length) {
      brkEl.innerHTML = '';
      if (brkLegendEl) brkLegendEl.innerHTML = '';
      lastBrkShown = [];   // don't let a resize resurrect a legend for an empty chart
      hideBrkTpt();
      if (brkStatusEl) brkStatusEl.textContent = '';
      return;
    }

    var shown = [], maxv = 0;
    order.forEach(function (m) {
      byModel[m].forEach(function (r) {
        shown.push(r);
        if (isFinite(r[mKey]) && r[mKey] > maxv) maxv = r[mKey];
      });
    });
    renderBreakdownLegend(shown);

    var xAxis = niceAxis(maxv, 4);
    var xMax = xAxis.max;
    var xStep = xAxis.step;
    var xs = tickValues(xMax, xStep);

    var W = 920;   // same viewBox width as the scatter — one unit renders at
                    // the same pixel size in both charts, so marks match
    var valRight = W - 32;   // right margin sized for the widest tick label
    function sx(v) { return BRK_LABEL + (v / xMax) * (valRight - BRK_LABEL); }

    // Pinned scale (axis + ticks) — sticks to the top of the rolling rows.
    var axis = [];
    axis.push('<svg class="brk-axis" viewBox="0 0 ' + W + ' ' + BRK_AXH + '" role="img" ' +
      'aria-label="' + esc(mLabel + ' scale — 0 to ' + formatTick(xMax)) + '" pointer-events="none">');
    axis.push('<rect class="brk-axis-col" x="0" y="0" width="' + BRK_LABEL + '" height="' + BRK_AXH + '" pointer-events="none"/>');
    axis.push('<text class="brk-axis-title" x="10" y="20" pointer-events="none">' + esc(mLabel) + '</text>');
    xs.forEach(function (v) {
      var px = sx(v);
      axis.push('<line class="brk-tick" x1="' + px + '" y1="' + (BRK_AXH - 6) + '" x2="' + px + '" y2="' + BRK_AXH + '" pointer-events="none"/>');
      axis.push('<text class="brk-tick-label" x="' + px + '" y="' + (BRK_AXH - 10) + '" text-anchor="middle" pointer-events="none">' + formatTick(v) + '</text>');
    });
    axis.push('</svg>');

    var body = [];
    order.forEach(function (m, i) {
      var runs = byModel[m];
      var ok = 0, fail = 0;
      runs.forEach(function (r) { if (r.code === '0') ok++; else fail++; });
      var tot = ok + fail;
      var mid = BRK_ROW / 2;

      body.push('<svg class="brk-row" viewBox="0 0 ' + W + ' ' + BRK_ROW + '">');

      // model label
      body.push('<text class="brk-model" x="8" y="' + (mid - 7) + '" pointer-events="none">' +
        esc(brkLabel(m, BRK_LABEL - 20, order)) + '</text>');

      // pass/fail split bar + reserved ok/total lane in the same trailing
      // label column. The bar is capped at 118px (BRK_LABEL-140) from x=90,
      // and the count is right-aligned at BRK_LABEL-8, so a bar can never
      // overprint its number: these three positions are a fixed-width layout
      // — if BRK_LABEL changes, keep the 32px+ guard between bar end and text.
      var bw = BRK_LABEL - 140;          // bar lane width
      var okw = Math.round((ok / (tot || 1)) * bw);
      var fw = bw - okw;
      var barY = BRK_ROW - 12;              // bar sits low in the 34px row
      if (okw) body.push('<rect class="brk-split" x="90" y="' + (barY - 2.5) + '" width="' + okw + '" height="5" fill="' + BRK_OK + '" pointer-events="none"/>');
      body.push('<text class="brk-count" x="' + (BRK_LABEL - 8) + '" y="' + (barY + 3) + '" text-anchor="end" pointer-events="none">' + ok + ' / ' + tot + '</text>');
      if (fw) body.push('<rect class="brk-fail" x="' + (90 + okw) + '" y="' + (barY - 2.5) + '" width="' + fw + '" height="5" fill="' + BRK_FAIL + '" pointer-events="none"/>');

      // rail spanning this model's value range on the active metric
      var min = Infinity, max = 0;
      runs.forEach(function (r) { if (isFinite(r[mKey])) { if (r[mKey] < min) min = r[mKey]; if (r[mKey] > max) max = r[mKey]; } });
      var x0 = isFinite(min) ? sx(min) : valRight, x1 = isFinite(max) ? sx(max) : valRight;
      body.push('<rect class="brk-rail" x="' + x0 + '" y="' + (mid - 1) + '" width="' + Math.max(2, x1 - x0) + '" height="2" pointer-events="none"/>');

      // one interactive mark per run — same glyph radius as the scatter, so
      // a size setting reads identically in both charts. The mark is nudged
      // right when a low value would push its edge under the model label
      // column (only possible for a value sitting at the axis origin).
      runs.forEach(function (r, j) {
        var okk = r.code === '0';
        var fill = okk ? BRK_OK : BRK_FAIL;
        var kv = brkKV(r);
        var shape = brkShape(brkQuant(r));
        var label = r.model + ': ' + (okk ? 'success' : 'failed') + ', ' + metricText(r) + '.';
        var gid = i + '_' + j;
        outMarks[gid] = r;
        var rc = pointRadius();
        var mx = Math.max(sx(r[mKey]), BRK_LABEL + rc + 4);
        body.push('<g class="brk-mark" data-brk="' + gid + '" tabindex="0" role="button" pointer-events="bounding-box" aria-label="' + esc(label) + '">' +
          brkMark(shape, mx, mid, rc, fill, brkKVColor(kv), kv === 'None' ? brkDash(rc) : null) + '</g>');
      });
      body.push('</svg>');
    });

    // put the pinned axis above the rolling rows inside the scrollable chart
    brkEl.innerHTML =
      '<div class="brk-axis-stick">' + axis.join('') + '</div>' + body.join('');
    syncMetricButtons();
    bindBrkMarks();
    brkPinned = null;

    var fails = shown.filter(function (r) { return r.code !== '0'; }).length;
    if (brkStatusEl) {
      brkStatusEl.textContent = shown.length + ' run' + (shown.length === 1 ? '' : 's') +
        ' across ' + order.length + ' model' + (order.length === 1 ? '' : 's') +
        ' (' + (shown.length - fails) + ' success, ' + fails + ' failed) — ' + mLabel.toLowerCase() + '.';
    }
  }

  function metricText(r) {
    if (state.metric === 'turns') return fmt(r.turnsN) + ' turns';
    return fmt(r.tokensN) + ' tokens';
  }

  function bindBrkMarks() {
    Array.prototype.forEach.call(brkEl.querySelectorAll('.brk-mark'), function (g) {
      var idx = g.getAttribute('data-brk');
      var row = function () { return outMarks[idx]; };
      g.addEventListener('mouseenter', function () { var r = row(); if (r) showBrkTpt(g, r); });
      g.addEventListener('focus', function () { var r = row(); if (r) showBrkTpt(g, r); });
      g.addEventListener('mouseleave', hideBrkTpt);
      g.addEventListener('blur', hideBrkTpt);
      g.addEventListener('click', function () {
        var r = row();
        if (!r) return;
        brkPinned = brkPinned === r ? null : r;
        markPinned(brkPinned);
        if (brkPinned) showBrkTpt(g, brkPinned);
        else hideBrkTpt();
      });
      g.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        var r = row();
        if (!r) return;
        brkPinned = brkPinned === r ? null : r;
        markPinned(brkPinned);
        if (brkPinned) showBrkTpt(g, brkPinned);
        else hideBrkTpt();
      });
    });
    // A pinned mark keeps its card open even as the list scrolls; scrolling
    // after a pin is the user's signal they are done with it.
  }

  // Highlights the pinned mark; clears the previous one.
  function markPinned(pinnedRow) {
    Array.prototype.forEach.call(brkEl.querySelectorAll('.brk-mark'), function (g) {
      var on = pinnedRow && outMarks[g.getAttribute('data-brk')] === pinnedRow;
      g.classList.toggle('brk--pinned', on);
    });
  }

  function syncMetricButtons() {
    brkMetricBtns.forEach(function (b) {
      var on = b.getAttribute('data-metric') === state.metric;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }
  function load() {
    setStatus('Loading data/eval-results.md…');
    if (retryEl) retryEl.hidden = true;
    fetch(RESULTS_PATH, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (md) {
        if (typeof marked === 'undefined') throw new Error('marked unavailable');
        allRows = [];
        modelOrder = [];
        parseMarkdown(md);
        // Fresh data — drop any memoised search results computed against the
        // previous file.
        searchMemoKey = null;
        searchMemoVal = null;
        // Model list: distinct names, in order of first successful appearance.
        allRows.forEach(function (r) {
          if (isSuccessful(r) && modelOrder.indexOf(r.model) === -1) modelOrder.push(r.model);
        });
        var successful = allRows.filter(isSuccessful).length;
        if (!successful) {
          setStatus('No successful runs (exit 0) found in data/eval-results.md.', true);
          return;
        }
        syncControls();
        draw();
        setStatus('Loaded ' + successful + ' successful run' + (successful === 1 ? '' : 's') +
          ' from data/eval-results.md.');
      })
      .catch(function () {
        setStatus(
          'Couldn\u2019t load the results file (data/eval-results.md). ' +
          'It is generated by agent-evaluation/run-eval.sh — run an evaluation first, then reload.',
          true
        );
        if (retryEl) retryEl.hidden = false;
      });
  }

  // --- Control wiring -------------------------------------------------
  sourceBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.source = btn.getAttribute('data-source');
      // Drop any explicit selection that doesn't exist in the new source, so
      // a stale pick from another source can't leave the chart blank or skew
      // counts. (A live wildcard search overrides selection anyway.)
      if (!state.search) pruneSelection(sourceModels());
      syncControls();
      draw();
    });
  });
  if (topSel) {
    topSel.addEventListener('change', function () {
      state.top = topSel.value === 'all' ? 'all' : parseInt(topSel.value, 10);
      draw();
    });
  }
  // Point-size toggle — shared by both charts: the scatter re-places its
  // glyphs and labels, the breakdown re-renders its marks through
  // pointRadius(), and both legends rescale. One draw() updates everything.
  psizeBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var p = btn.getAttribute('data-psize');
      if (p === state.psize) return;
      state.psize = p;
      syncControls();
      draw();
    });
  });
  if (modelsAllBtn) {
    modelsAllBtn.addEventListener('click', function () {
      // Activating Select all/Clear supersedes search mode and applies to
      // the manual selection. Cancel a pending debounce first and drop any
      // leftover query text so neither can override this click.
      clearTimeout(searchTimer);
      state.search = '';
      state.searchSaved = null;
      if (searchInput) searchInput.value = '';
      state.models = '';
      syncControls();
      draw();
    });
  }
  if (modelsNoneBtn) {
    modelsNoneBtn.addEventListener('click', function () {
      clearTimeout(searchTimer);
      state.search = '';
      state.searchSaved = null;
      if (searchInput) searchInput.value = '';
      state.models = 'NONE';
      syncControls();
      draw();
    });
  }

  // Wildcard search — live derivation: while a query is non-empty it selects
  // every matching model; clearing the query restores the manual selection
  // that was active when the search started.
  var searchTimer = null;
  if (searchInput) {
    searchInput.addEventListener('input', function () {
      var q = searchInput.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        var before = state.search.trim();
        var now = q.trim();
        if (!before && now && state.searchSaved === null) state.searchSaved = state.models;
        if (before && !now && state.searchSaved !== null) {
          state.models = state.searchSaved;
          state.searchSaved = null;
        }
        state.search = now;
        syncControls();
        draw();
      }, 120);
    });
    // Safari fires only 'search' (not 'input') when its native clear button
    // is used; re-run the same handling. Both firing is harmless — the
    // transition logic above is idempotent.
    searchInput.addEventListener('search', function () {
      searchInput.dispatchEvent(new Event('input'));
    });
    searchInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      e.stopPropagation(); // don't also unpin a chart point
      if (searchInput.value) {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input'));
      } else {
        searchInput.blur();
      }
      // Escape in the search field also dismisses the Models popover — the
      // user is done filtering, not just done typing.
      if (modelsPanel && !modelsPanel.hidden) {
        modelsToggle.setAttribute('aria-expanded', 'false');
        modelsPanel.hidden = true;
      }
    });
  }
  if (searchClearEl) {
    searchClearEl.addEventListener('click', function () {
      if (!searchInput) return;
      clearTimeout(searchTimer);
      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input'));
      searchInput.focus();
    });
  }
  if (retryEl) retryEl.addEventListener('click', load);

  // Breakdown metric toggle — redraws only the breakdown, not the scatter.
  brkMetricBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      var m = b.getAttribute('data-metric');
      if (m === state.metric) return;
      state.metric = m;
      syncMetricButtons();
      drawBreakdown();
    });
  });

  // Models popover: open on click, close on outside click / Escape+
  modelsToggle.addEventListener('click', function (e) {
    e.stopPropagation();
    var open = modelsToggle.getAttribute('aria-expanded') === 'true';
    modelsToggle.setAttribute('aria-expanded', String(!open));
    modelsPanel.hidden = open;
  });
  // close on outside click
  document.addEventListener('click', function (e) {
    if (modelsPanel.hidden) return;
    if (modelsPanel.contains(e.target) || modelsToggle.contains(e.target)) return;
    modelsToggle.setAttribute('aria-expanded', 'false');
    modelsPanel.hidden = true;
  });
  // Escape closes the panel too
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (modelsPanel.hidden) return;
    modelsToggle.setAttribute('aria-expanded', 'false');
    modelsPanel.hidden = true;
    modelsToggle.focus();
  });

  // Summary in the popover toggle: all successful models / N models / no
  // models — kept fresh. (The chip list only ever contains models with at
  // least one successful run, so the unfiltered state means "all successful
  // models", not literally every model in the data file.)
  function updateModelsSummary() {

    if (!modelsSummary) return;
    var sel = effectiveSelection();
    if (sel === null) modelsSummary.textContent = 'all successful models';
    else if (!sel.length) modelsSummary.textContent = 'no models';
    else modelsSummary.textContent = sel.length + ' model' + (sel.length === 1 ? '' : 's');
  }

  // Keep the legends exactly matched to the charts when the window resizes
  // (the charts rescale responsively; the legends re-derive the same
  // px-per-unit). Rendering the legends is cheap, so no debounce is needed.
  // Charts that are empty (no rows shown) have empty legends and empty
  // snapshots, so a resize can never repopulate a ghost legend.
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', function () {
      if (chartEl && chartEl.innerHTML) renderVizLegend(lastVizShown);
      if (brkEl && brkEl.innerHTML) renderBreakdownLegend(lastBrkShown);
    });
  }

  load();
})();