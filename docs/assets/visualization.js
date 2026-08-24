(function () {
  'use strict';

  // Loads data/eval-results.md and renders a scatter plot of successful runs:
  // Total Context Used (tokens) on the X axis, Turns on the Y axis, points
  // coloured by Model with direct labels where space allows. Used by
  // visualization.html only. Everything is derived from the markdown at
  // runtime — nothing is hardcoded.
  var RESULTS_PATH = 'data/eval-results.md';

  var statusEl = document.getElementById('viz-status');
  var chartEl = document.getElementById('viz-chart');
  var tooltipEl = document.getElementById('viz-tooltip');
  var summaryEl = document.getElementById('viz-summary');
  var retryEl = document.getElementById('viz-retry');
  var sourceBtns = Array.prototype.slice.call(document.querySelectorAll('[data-source]'));
  var topSel = document.getElementById('top-filter');
  var chipsEl = document.getElementById('model-chips');
  var modelsAllBtn = document.getElementById('models-all');
  var modelsNoneBtn = document.getElementById('models-none');
  var searchInput = document.getElementById('model-search');
  var searchCountEl = document.getElementById('model-search-count');
  var searchClearEl = document.getElementById('model-search-clear');

  // Model-breakdown panel (second chart on the page).
  var brkEl = document.getElementById('brk-chart');
  var brkStatusEl = document.getElementById('brk-status');
  var brkLegendEl = document.getElementById('brk-legend');
  var brkDetailEl = document.getElementById('brk-detail');
  // The run currently pinned in the breakdown, or null. Stores a row ref
  // (validated by identity) so a pin survives re-draws.
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
    source: 'all',        // 'all' | 'Provider' | 'Local'
    models: '',           // '' = all models, else comma-separated selected names
    search: '',           // active wildcard query — while non-empty it derives the model selection
    searchSaved: null,    // the models value before the search began, restored on clear
    top: 25               // 'all' or a number
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

  function niceStep(range, target) {
    if (range <= 0) return 1;
    var raw = range / target;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  }

  function niceCeil(max) {
    if (!isFinite(max) || max <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log(max) / Math.LN10));
    var norm = max / mag;
    var ceil = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return ceil * mag;
  }

  function tickValues(max, step) {
    var out = [];
    for (var v = 0; v <= max + step * 0.0001; v += step) out.push(v);
    return out;
  }

  function formatTick(v) {
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

  // Turns a wildcard pattern into a RegExp against the full (lower-cased)
  // model name or note text. '*' matches any run of characters, '?' exactly
  // one. Patterns are matched as substrings, so 'qwen3.6-27b', 'openrouter/*'
  // and note fragments like 'Q4' all find what the user means.
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

  // Models matching the current query, in source-scoped order; null when no
  // query is active. Used by the summary and the chip strip while a search is
  // active: a model counts as matching when the query matches its name OR the
  // Notes of at least one of its successful runs in the current source (so
  // searching "Q4" finds every model with a run at a Q4 quantisation). The
  // visible rows themselves are filtered individually in visibleRows().
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
      if (re.test(String(m).toLowerCase())) return true;
      return allRows.some(function (r) {
        return r.model === m && isSuccessful(r) && inSource(r) &&
          re.test(String(r.notes || '').toLowerCase());
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
      // only when the pattern matches its own model name or its own Notes.
      // This makes "Q2_K_XL" show just the single run quantised at Q2_K_XL
      // instead of every run of the same model.
      if (searchRe) {
        if (searchRe.test(String(r.model || '').toLowerCase())) return true;
        return searchRe.test(String(r.notes || '').toLowerCase());
      }
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
      var w = text.length * 6.6 + 6;
      var hw = 10; // half-height of the label box
      var x0, x1, anchorEnd = false;

      if (px + 12 + w <= plotRight) {
        x0 = px + 12;
        x1 = px + 12 + w;
      } else if (px - 12 - w >= plotLeft) {
        x0 = px - 12 - w;
        x1 = px - 12;
        anchorEnd = true;
      } else {
        return; // no room horizontally
      }

      var y0 = py - hw;
      var y1 = py + hw;
      if (y0 < plotTop || y1 > plotBottom) return; // out of plot vertically

      // Collision with any other point (halo radius 9 -> use 11 to breathe).
      var clash = rows.some(function (q) {
        if (q === r) return false;
        var qx = xF(q.tokensN);
        var qy = yF(q.turnsN);
        return x0 < qx + 11 && x1 > qx - 11 && y0 < qy + 11 && y1 > qy - 11;
      });
      if (clash) return;

      // Collision with any already-placed label.
      clash = placed.some(function (b) {
        return x0 < b.x1 + 4 && x1 > b.x0 - 4 && y0 < b.y1 && y1 > b.y0;
      });
      if (clash) return;

      placed.push({ x0: x0, x1: x1, y0: y0, y1: y1 });
      out.push({ row: r, cx: px, cy: py, text: text, anchorEnd: anchorEnd });
    });

    return out;
  }

  /* ------------------------------------------------------------------ *
   * Drawing
   * ------------------------------------------------------------------ */

  function draw() {
    drawBreakdown();
    var rows = visibleRows();
    pointPos = [];

    if (!rows.length) {
      chartEl.innerHTML = '';
      tooltipEl.classList.add('is-hidden');
      pinned = null;
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

    var xMax = niceCeil(maxTokens);
    var yMax = niceCeil(maxTurns);
    var stepX = niceStep(xMax, 6);
    var stepY = niceStep(yMax, 5);
    var xs = tickValues(xMax, stepX);
    var ys = tickValues(yMax, stepY);

    function x(v) { return M.left + (v / xMax) * plotW; }
    function y(v) { return M.top + plotH - (v / yMax) * plotH; }

    var anchors = placeLabels(rows, x, y);

    var out = [];

    // --- SVG wrapper -------------------------------------------------
    out.push(
      '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="group" ' +
      'aria-label="Scatter plot of total context used against turns for successful evaluation runs">'
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
      out.push('<text class="axis-label" x="' + px + '" y="' + (M.top + plotH + 24) + '">' + formatTick(v) + '</text>');
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
      var tx = a.anchorEnd ? a.cx - 12 : a.cx + 12;
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
      out.push(
        '<g class="pt" data-idx="' + i + '" tabindex="0" role="button" ' +
        'aria-label="' + esc(r.model) + ': ' + fmt(r.tokensN) + ' tokens, ' + fmt(r.turnsN) + ' turns">' +
        '<circle cx="' + px + '" cy="' + py + '" r="9" class="pt__halo"/>' +
        '<circle cx="' + px + '" cy="' + py + '" r="6" fill="' + c + '"/>' +
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

  // Escape unpins the currently pinned point (scatter or breakdown).
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (brkPinned) { brkPinned = null; setBrkPin(null); setBrkDetail(null); }
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
   * Model breakdown — a second chart on the same page.
   *
   * Every run (passed or failed) grouped by model, one row per model. Each
   * row carries two horizontal range rails (Context Used, Turns) whose length
   * is the model's min—max spread; each of its runs sits as a mark along each
   * rail at its own value. A run is encoded three ways at once — fill colour
   * (status: carbon = success, red = failed), glyph (quant note), and outline
   * (solid = KV quant set, dashed = KV quantity None) — so run points stay
   * distinguishable even when two stress/turn values land close together.
   * Props same source / model / search state as the scatter.
   * ------------------------------------------------------------------ */

  // Status fill colours and the outline ink used to separate runs.
  var BRK_OK = '#2E4A7A';
  var BRK_FAIL = '#B42318';
  var BRK_INK = '#16202E';

  // Row geometry.
  var BRK_LABEL = 208;  // label-column width (model name + pass/fail split)
  var BRK_ROW = 56;     // height of each model row
  var BRK_TOP = 58;     // space for the pane titles

  // Quant notes → glyph, ordered once so a quantisation never changes shape.
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
  function brkGlyph(q) {
    var shapes = ['circle', 'square', 'triangle', 'diamond', 'pentagon'];
    var i = BRK_QUANTS.indexOf(q);
    return shapes[(i < 0 ? 0 : i) % shapes.length];
  }
  function kvSet(r) {
    return !/KV quant:\s*None/i.test(String(r.notes || ''));
  }

  // A run belongs in the breakdown when it passes source + model selection +
  // live search. Unlike the scatter it keeps failed runs.
  function brkRow(r) {
    if (!inSource(r)) return false;
    var sel = effectiveSelection();
    if (sel && sel.indexOf(r.model) === -1) return false;
    var q = state.search.trim();
    if (q) {
      var re = globToRegExp(q);
      return re.test(String(r.model || '').toLowerCase()) ||
        re.test(String(r.notes || '').toLowerCase());
    }
    return true;
  }

  // SVG glyph for one run-mark shape.
  function brkGlyphInner(shape, cx, cy, r2, fill, stroke, sw, dash) {
    var d = dash ? ' stroke-dasharray="2.5 1.1"' : '';
    var s = ' fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + sw + '"' + d;
    if (shape === 'square') {
      return '<rect x="' + (cx - r2) + '" y="' + (cy - r2) + '" width="' + (2 * r2) + '" height="' + (2 * r2) + '"' + s + '/>';
    }
    if (shape === 'triangle') {
      return '<path d="M' + cx + ' ' + (cy - r2) + ' L' + (cx + r2) + ' ' + (cy + r2) + ' L' + (cx - r2) + ' ' + (cy + r2) + ' Z"' + s + '/>';
    }
    if (shape === 'diamond') {
      return '<path d="M' + cx + ' ' + (cy - r2) + ' L' + (cx + r2) + ' ' + cy + ' L' + cx + ' ' + (cy + r2) + ' L' + (cx - r2) + ' ' + cy + ' Z"' + s + '/>';
    }
    if (shape === 'pentagon') {
      var pts = [];
      for (var i5 = 0; i5 < 5; i5++) {
        var a = -Math.PI / 2 + i5 * 2 * Math.PI / 5;
        pts.push((cx + r2 * Math.cos(a)).toFixed(1) + ' ' + (cy + r2 * Math.sin(a)).toFixed(1));
      }
      return '<polygon points="' + pts.join(' ') + '"' + s + '/>';
    }
    return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r2 + '"' + s + '/>';
  }

  function brkTruncate(text, width) {
    var s = String(text || '');
    if (s.length * 6.2 + 2 <= width) return s;
    while (s.length > 2 && s.length * 6.2 + 2 > width - 13) s = s.slice(0, -1);
    return s + '…';
  }

  // Short on-plot name for a model: the fewest trailing path segments that are
  // unambiguous among the models shown (like the scatter's direct labels), so
  // "qwen/qwen3.8-27b" vs "unsloth/qwen3.8-27b@q2_k_xl" stay distinct even
  // when the full identifier would be clipped.
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
    if (label.length * 6.2 + 2 <= width) return label;
    return brkTruncate(label, width);
  }

  function setBrkDetail(r) {
    if (!brkDetailEl) return;
    if (!r) { brkDetailEl.classList.add('is-empty'); brkDetailEl.innerHTML = ''; return; }
    var ok = r.code === '0';
    var color = ok ? BRK_OK : BRK_FAIL;
    var html =
      '<div class="brk-detail__head">' +
      '<span class="bd-status" style="background:' + color + '"></span>' +
      '<span class="brk-detail__src">' + esc(r.model) + '</span>' +
      '<span class="brk-detail__tag">' + (ok ? 'Success' : 'Failed') +
      ' · ' + (r.local ? 'Local' : 'Provider') + ' · ' + esc(r.date || '—') + '</span>' +
      '</div>';
    if (r.notes) {
      var items = String(r.notes).split(',').map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length > 0; });
      if (items.length) {
        html += '<div class="brk-detail__notes">' + items.map(function (it) {
          return '<span class="tip__chip">' + esc(it) + '</span>';
        }).join('') + '</div>';
      }
    }
    html +=
      '<dl class="brk-detail__grid">' +
      '<dt>Context used</dt><dd>' + fmt(r.tokensN) + ' tokens</dd>' +
      '<dt>Turns</dt><dd>' + fmt(r.turnsN) + '</dd>' +
      '<dt>Duration</dt><dd>' + esc(r.duration || '—') + '</dd>' +
      '<dt>Limit</dt><dd>' + fmt(r.limitN) + '</dd>' +
      '<dt>Passed / failed tests</dt><dd>' + fmt(r.passedN) + ' / ' + fmt(r.failedN) + '</dd>' +
      '</dl>';
    brkDetailEl.innerHTML = html;
    brkDetailEl.classList.remove('is-empty');
  }

  function renderBreakdownLegend(rows) {
    if (!brkLegendEl) return;
    var parts = [];
    parts.push('<span class="legend-label">Status</span>');
    parts.push('<span class="legend-key"><span class="lg" style="background:' + BRK_OK + '"></span>success</span>');
    parts.push('<span class="legend-key"><span class="lg" style="background:' + BRK_FAIL + '"></span>failed</span>');
    var used = [];
    rows.forEach(function (r) {
      var q = brkQuant(r);
      if (q && used.indexOf(q) === -1) used.push(q);
    });
    if (used.length) {
      parts.push('<span class="legend-label">Quant (glyph)</span>');
      // Emit in the same sorted order as brkGlyph() assigns shapes, so a
      // legend swatch always matches the marker a run carries.
      BRK_QUANTS.forEach(function (q) {
        if (used.indexOf(q) === -1) return;
        var g = brkGlyph(q);
        parts.push('<span class="legend-key"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
          brkGlyphInner(g, 8, 8, 5.5, BRK_OK, BRK_INK, 1.1, false) + '</svg>' + esc(q) + '</span>');
      });
    }
    parts.push('<span class="legend-label">KV quant (outline)</span>');
    parts.push('<span class="legend-key"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="' + BRK_OK + '" stroke="' + BRK_INK + '" stroke-width="1.1"/></svg>set</span>');
    parts.push('<span class="legend-key"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="' + BRK_OK + '" stroke="' + BRK_INK + '" stroke-width="1.1" stroke-dasharray="2.5 1.1"/></svg>none</span>');
    brkLegendEl.innerHTML = parts.join('');
  }

  function drawBreakdown() {
    if (!brkEl) return;
    brkPinned = null;

    // Derive glyph order from the runs actually present so it stays yoked to
    // the data (a run whose notes lack a quant falls back to the first glyph).
    buildQuantOrder();

    // Group the runs (under current filters, keeping failures) by model, in
    // order of first appearance so rows stay stable.
    var byModel = {};
    var order = [];
    allRows.forEach(function (r) {
      if (!brkRow(r)) return;
      if (!byModel[r.model]) { byModel[r.model] = []; order.push(r.model); }
      byModel[r.model].push(r);
    });

    if (!order.length) {
      brkEl.innerHTML = '';
      if (brkLegendEl) brkLegendEl.innerHTML = '';
      setBrkDetail(null);
      if (brkStatusEl) brkStatusEl.textContent = '';
      return;
    }

    // Flatten every shown run for the legend + shared scales.
    var shown = [];
    var maxTokens = 0, maxTurns = 0;
    order.forEach(function (m) {
      byModel[m].forEach(function (r) {
        shown.push(r);
        if (isFinite(r.tokensN) && r.tokensN > maxTokens) maxTokens = r.tokensN;
        if (isFinite(r.turnsN) && r.turnsN > maxTurns) maxTurns = r.turnsN;
      });
    });
    renderBreakdownLegend(shown);

    var xMax = niceCeil(maxTokens);
    var yMax = niceCeil(maxTurns);
    var xStep = niceStep(xMax, 6);
    var yStep = niceStep(yMax, 5);
    var xs = tickValues(xMax, xStep);
    var ys = tickValues(yMax, yStep);

    var W = 980;
    var H = BRK_TOP + order.length * BRK_ROW + 64;
    var col = BRK_LABEL;
    var cX = col + 18;                 // context pane left
    var tX = 588;                      // turns pane left
    var cW = tX - 24 - cX;             // context pane width
    var tW = W - 12 - tX;              // turns pane width

    function sx(v) { return cX + (v / xMax) * cW; }
    function sx2(v) { return tX + (v / yMax) * tW; }

    var out = [];
    var groupIdx = 0;
    var brkPos = [];

    out.push('<svg class="brk-svg" viewBox="0 0 ' + W + ' ' + H + '" role="group" pointer-events="none" ' +
      'aria-label="Model breakdown: per-model range of context used and turns, with pass/fail marks">');

    // Pane headers.
    out.push('<text class="brk-axis-title" x="' + (cX + cW / 2) + '" y="24" text-anchor="middle" pointer-events="none">Context Used (tokens)</text>');
    out.push('<text class="brk-axis-title" x="' + (tX + tW / 2) + '" y="24" text-anchor="middle" pointer-events="none">Turns</text>');
    out.push('<text class="brk-axis-title" x="12" y="24" pointer-events="none">model</text>');

    var bodyTop = BRK_TOP;
    var bodyBottom = BRK_TOP + order.length * BRK_ROW;

    // Row backgrounds (zebra) + a light frame.
    order.forEach(function (m, i) {
      var top = bodyTop + i * BRK_ROW;
      out.push('<rect class="brk-row-bg" x="0" y="' + top + '" width="' + W + '" height="' + BRK_ROW + '" pointer-events="none"/>');
      if (i === order.length - 1) {
        out.push('<line class="brk-frame" x1="0" y1="' + (top + BRK_ROW) + '" x2="' + W + '" y2="' + (top + BRK_ROW) + '" pointer-events="none"/>');
      }
      if (i === 0) {
        out.push('<line class="brk-frame" x1="0" y1="' + top + '" x2="' + W + '" y2="' + top + '" pointer-events="none"/>');
      }
    });
    out.push('<line class="brk-frame" x1="0" y1="' + bodyTop + '" x2="0" y2="' + bodyBottom + '" pointer-events="none"/>');

    // Vertical grids + tick labels for both metrics, once (below the last row).
    var labelY = bodyBottom + 22;
    xs.forEach(function (v) {
      var px = sx(v);
      out.push('<line class="brk-grid" x1="' + px + '" y1="' + bodyTop + '" x2="' + px + '" y2="' + bodyBottom + '" pointer-events="none"/>');
      out.push('<text class="brk-axis" x="' + px + '" y="' + labelY + '" text-anchor="middle" pointer-events="none">' + formatTick(v) + '</text>');
    });
    ys.forEach(function (v) {
      var px = sx(v);
      out.push('<line class="brk-grid" x1="' + px + '" y1="' + bodyTop + '" x2="' + px + '" y2="' + bodyBottom + '" pointer-events="none"/>');
      out.push('<text class="brk-axis" x="' + px + '" y="' + labelY + '" text-anchor="middle" pointer-events="none">' + formatTick(v) + '</text>');
    });

    // One row per model.
    order.forEach(function (m, i) {
      var runs = byModel[m];
      var top = bodyTop + i * BRK_ROW;
      var mid = top + BRK_ROW / 2;
      var ok = 0, fail = 0;
      runs.forEach(function (r) { if (r.code === '0') ok++; else fail++; });
      var tot = ok + fail;

      // Model label + pass/fail split.
      out.push('<text class="brk-model" x="12" y="' + (mid - 6) + '" pointer-events="none">' + esc(brkLabel(m, BRK_LABEL - 14, order)) + '</text>');
      var splitX0 = 10, splitW = 56;
      var okW = tot ? Math.round((ok / tot) * splitW) : 0;
      var failW = tot ? splitW - okW : 0;
      if (okW) out.push('<rect x="' + splitX0 + '" y="' + (mid + 2) + '" width="' + okW + '" height="6" fill="' + BRK_OK + '" pointer-events="none"/>');
      if (failW) out.push('<rect x="' + (splitX0 + okW) + '" y="' + (mid + 2) + '" width="' + failW + '" height="6" fill="' + BRK_FAIL + '" pointer-events="none"/>');
      out.push('<text class="brk-count" x="' + (splitX0 + splitW + 6) + '" y="' + (mid + 8) + '" pointer-events="none">' + (ok + '/' + tot) + '</text>');

      // Each rail: min—max band for the model's runs, then a mark per run.
      var minC = Infinity, maxC = 0, minT = Infinity, maxT = 0;
      runs.forEach(function (r) {
        if (isFinite(r.tokensN)) { if (r.tokensN < minC) minC = r.tokensN; if (r.tokensN > maxC) maxC = r.tokensN; }
        if (isFinite(r.turnsN)) { if (r.turnsN < minT) minT = r.turnsN; if (r.turnsN > maxT) maxT = r.turnsN; }
      });
      var x0 = isFinite(minC) ? sx(minC) : 0, x1 = isFinite(maxC) ? sx(maxC) : 0;
      out.push('<rect class="brk-rail" x="' + x0 + '" y="' + (mid - 22) + '" width="' + Math.max(2, x1 - x0) + '" height="16" pointer-events="none"/>');
      var y0 = isFinite(minT) ? sx2(minT) : 0, y1 = isFinite(maxT) ? sx2(maxT) : 0;
      out.push('<rect class="brk-rail" x="' + y0 + '" y="' + (mid - 22) + '" width="' + Math.max(2, y1 - y0) + '" height="16" pointer-events="none"/>');

      // Rail end caps mark the min/max of each metric for the model.
      out.push('<rect class="brk-rail-end" x="' + (x0 - 1.5) + '" y="' + (mid - 24) + '" width="3" height="20" pointer-events="none"/>');
      out.push('<rect class="brk-rail-end" x="' + (x1 - 1.5) + '" y="' + (mid - 24) + '" width="3" height="20" pointer-events="none"/>');
      out.push('<rect class="brk-rail-end" x="' + (y0 - 1.5) + '" y="' + (mid - 24) + '" width="3" height="20" pointer-events="none"/>');
      out.push('<rect class="brk-rail-end" x="' + (y1 - 1.5) + '" y="' + (mid - 24) + '" width="3" height="20" pointer-events="none"/>');

      // One interactive group per run — a mark on each rail, paired so hover
      // and pin highlight both ends of the same run at once.
      runs.forEach(function (r) {
        var gid = 'b' + groupIdx;
        var okk = r.code === '0';
        var st = okk ? BRK_OK : BRK_FAIL;
        var glyph = brkGlyph(brkQuant(r));
        var dash = !kvSet(r);
        var my = mid - 14; // the rail's centre-line for marks
        var label = esc(r.model) + ': ' + (okk ? 'success' : 'failed') + ', ' +
          fmt(r.tokensN) + ' tokens, ' + fmt(r.turnsN) + ' turns';
        out.push(
          '<g class="brk-g" data-brk="' + gid + '" tabindex="0" role="button" pointer-events="all" aria-label="' + label + '">' +
          '<title>' + label + (r.notes ? ' — ' + esc(r.notes) : '') + '</title>' +
          brkGlyphInner(glyph, sx(r.tokensN), my, 6.5, st, BRK_INK, 1.4, dash) +
          brkGlyphInner(glyph, sx2(r.turnsN), my, 6.5, st, BRK_INK, 1.4, dash) +
          '</g>'
        );
        brkPos[gid] = { row: r };
        groupIdx++;
      });
    });

    out.push('</svg>');
    brkEl.innerHTML = out.join('');
    bindBrk(brkPos);

    // Status line: how many runs/models, split by outcome.
    var fails = shown.filter(function (r) { return r.code !== '0'; }).length;
    if (brkStatusEl) {
      brkStatusEl.textContent = shown.length + ' run' + (shown.length === 1 ? '' : 's') +
        ' across ' + order.length + ' model' + (order.length === 1 ? '' : 's') +
        ' (' + (shown.length - fails) + ' success, ' + fails + ' failed) — grouped by model.';
    }
  }

  // Hover/focus shows the run's record; click pins it until Escape or a
  // re-draw (a re-draw clears the pin — filters changed, so it is stale).
  function setBrkPin(g) {
    Array.prototype.forEach.call(brkEl.querySelectorAll('.brk-g.brk--pinned'), function (o) {
      o.classList.remove('brk--pinned');
    });
    if (g) g.classList.add('brk--pinned');
  }

  function bindBrk(pos) {
    var suppress = false;
    Array.prototype.forEach.call(brkEl.querySelectorAll('.brk-g'), function (g) {
      var idx = g.getAttribute('data-brk');
      var row = function () { return pos[idx] && pos[idx].row; };
      g.addEventListener('mouseenter', function () { if (brkPinned === null) setBrkDetail(row()); });
      g.addEventListener('mouseleave', function () { if (brkPinned === null) setBrkDetail(null); });
      g.addEventListener('focus', function () { if (brkPinned === null) setBrkDetail(row()); });
      g.addEventListener('blur', function () { if (brkPinned === null) setBrkDetail(null); });
      g.addEventListener('click', function () {
        if (suppress) { suppress = false; return; }
        var r = row();
        if (!r) return;
        brkPinned = brkPinned === r ? null : r;
        setBrkPin(brkPinned ? g : null);
        setBrkDetail(brkPinned);
      });
      g.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        var r = row();
        if (!r) return;
        brkPinned = brkPinned === r ? null : r;
        suppress = true;
        setBrkPin(brkPinned ? g : null);
        setBrkDetail(brkPinned);
      });
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

  load();
})();