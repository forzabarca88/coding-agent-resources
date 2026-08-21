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

  /* ------------------------------------------------------------------ *
   * Model selection — wildcard search derives the selection while a
   * query is active; clearing the query restores the previous one.
   * ------------------------------------------------------------------ */

  // Turns a wildcard pattern into a RegExp against the full (lower-cased)
  // model name. '*' matches any run of characters, '?' exactly one. Patterns
  // are matched as substrings of the name, so both 'qwen3.6-27b' and
  // 'openrouter/*' style patterns find what the user means.
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

  // Models matching the current query, in modelOrder order; null when no
  // query is active.
  function searchMatches() {
    var q = state.search.trim();
    if (!q) return null;
    var re = globToRegExp(q);
    return modelOrder.filter(function (m) {
      return re.test(String(m).toLowerCase());
    });
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
    var rows = allRows.filter(function (r) {
      if (!isSuccessful(r)) return false;
      if (r.local && state.source === 'Provider') return false;
      if (!r.local && state.source === 'Local') return false;
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
    var rows = visibleRows();
    pointPos = [];

    if (!rows.length) {
      chartEl.innerHTML = '';
      tooltipEl.classList.add('is-hidden');
      pinned = null;
      if (summaryEl) {
        var q = state.search.trim();
        var noneMatch = q && searchMatches() && searchMatches().length === 0;
        summaryEl.textContent = noneMatch
          ? 'No model matches search "' + q + '".'
          : 'No runs match the current filters.';
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

    // --- Best-area tint: soft diagonal fade emphasising the bottom-left
    // (least context, fewest turns) without hard edges. Drawn before the
    // grid so the ruled lines stay visible on top. Purely decorative. ---
    out.push(
      '<defs>' +
      '<linearGradient id="viz-best" x1="0" y1="1" x2="0.55" y2="0.45">' +
      '<stop offset="0" stop-color="#5D6B82" stop-opacity="0.15"/>' +
      '<stop offset="1" stop-color="#5D6B82" stop-opacity="0"/>' +
      '</linearGradient>' +
      '</defs>'
    );
    out.push(
      '<rect class="best-area" x="' + M.left + '" y="' + M.top + '" width="' + plotW + '" height="' + plotH + '" ' +
      'fill="url(#viz-best)" pointer-events="none" aria-hidden="true" focusable="false"/>'
    );

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
      if (!isSuccessful(r)) return false;
      if (r.local && state.source === 'Provider') return false;
      if (!r.local && state.source === 'Local') return false;
      return true;
    }).length;
    var sel = effectiveSelection();
    var selectedCount = sel === null ? modelOrder.length : sel.length;
    var q = state.search.trim();
    var text = 'Showing ' + rows.length + ' of ' + scopeTotal + ' successful runs (' + scope;
    if (q) text += '; ' + selectedCount + ' of ' + modelOrder.length + ' models match search "' + q + '"';
    else if (state.models === 'NONE') text += '; no models selected';
    else if (state.models) text += '; ' + selectedCount + ' of ' + modelOrder.length + ' models';
    else text += '; all ' + modelOrder.length + ' models';
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
    var sel = effectiveSelection();
    var selKey = sel === null ? '*' : sel.join(',');
    var sig = state.search + '|' + selKey + '|' + modelOrder.join(',');
    if (sig === chipsSig) return;
    chipsSig = sig;

    var matches = searchMatches();
    var bySearch = !!matches;
    var list = bySearch ? matches : modelOrder.slice();
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
        ? list.length + ' of ' + modelOrder.length + ' models match' + (q ? ' "' + q + '"' : '')
        : '';
    }
    if (searchClearEl) searchClearEl.hidden = !bySearch;

    Array.prototype.forEach.call(chipsEl.querySelectorAll('.model-chip'), function (btn) {
      btn.addEventListener('click', function () {
        var m = btn.getAttribute('data-model');
        // Clicking a chip exits search mode entirely and switches to an
        // explicit pick of that model. Unconditionally cancel any pending
        // debounce and clear leftover search text (state or un-applied), so
        // a stale timer can't re-enter search mode and the input can't keep
        // showing a query that no longer drives the chart.
        clearTimeout(searchTimer);
        state.search = '';
        state.searchSaved = null;
        if (searchInput) searchInput.value = '';
        // From "all": start from everything; from "none": start from nothing;
        // otherwise start from the current explicit selection.
        var sel = state.models === '' ? modelOrder.slice()
          : (state.models === 'NONE' ? [] : state.models.split(','));
        var i = sel.indexOf(m);
        if (i === -1) sel.push(m);
        else sel.splice(i, 1);
        state.models = sel.length === modelOrder.length ? ''
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

  // Escape unpins the currently pinned point.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && pinned) {
      pinned = null;
      updatePin();
    }
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
   * Load
   * ------------------------------------------------------------------ */

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