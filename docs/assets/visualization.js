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
  var legendEl = document.getElementById('viz-legend');
  var summaryEl = document.getElementById('viz-summary');
  var retryEl = document.getElementById('viz-retry');
  var sourceBtns = Array.prototype.slice.call(document.querySelectorAll('[data-source]'));
  var topSel = document.getElementById('top-filter');

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
    models: '',           // '' = all, else comma-separated selected model names
    top: 25               // 'all' or a number
  };

  // Every parsed row from the markdown tables, in file order.
  var allRows = [];
  // Distinct successful model names, in order of first appearance.
  var modelOrder = [];
  // Index of the currently pinned (clicked) point, or -1.
  var pinned = -1;
  // Rendering map for tooltip positioning: idx -> {row, left, top}.
  var pointPos = [];

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
      row.local = /^lmstudio/i.test(row.model || '');
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

  function modelSelected(r) {
    if (!state.models) return true;
    return state.models.split(',').indexOf(r.model) !== -1;
  }

  function visibleRows() {
    var rows = allRows.filter(function (r) {
      if (!isSuccessful(r)) return false;
      if (r.local && state.source === 'Provider') return false;
      if (!r.local && state.source === 'Local') return false;
      if (!modelSelected(r)) return false;
      return true;
    });
    rows.sort(function (a, b) { return b.tokensN - a.tokensN; });
    if (state.models === '' && state.top !== 'all') {
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
      html +=
        '<div class="tip__notes">' +
        '<span class="tip__notes-label">Notes</span>' +
        '<p class="tip__notes-text">' + esc(r.notes) + '</p>' +
        '</div>';
    }
    html +=
      '<dl class="tip__grid">' +
      '<dt>Context used</dt><dd>' + fmt(r.tokensN) + ' tokens</dd>' +
      '<dt>Turns</dt><dd>' + fmt(r.turnsN) + '</dd>' +
      '<dt>Duration</dt><dd>' + esc(r.duration || '—') + '</dd>' +
      '<dt>Limit</dt><dd>' + fmt(r.limitN) + '</dd>' +
      '<dt>Exceeded</dt><dd>' + esc(r.exceeded || '—') + '</dd>' +
      '<dt>Exit</dt><dd>' + esc(r.code) + '</dd>' +
      '<dt>Passed</dt><dd>' + fmt(r.passedN) + '</dd>' +
      '<dt>Failed</dt><dd>' + fmt(r.failedN) + '</dd>' +
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
    if (pinned === -1) tooltipEl.classList.add('is-hidden');
  }

  function updatePin() {
    Array.prototype.forEach.call(chartEl.querySelectorAll('.pt'), function (g) {
      g.classList.toggle('pt--pinned', +g.getAttribute('data-idx') === pinned);
    });
    if (pinned !== -1) showTooltip(pinned);
    else hideTooltip();
  }

  /* ------------------------------------------------------------------ *
   * Label placement — deterministic, space permitting
   * ------------------------------------------------------------------ */

  // Works on integer "key" coordinates: round each point to the nearest
  // multiple of STEP and cluster anything in the same cell. Cells that stay
  // alone become direct labels; crowded cells become a shared numeric tag.
  var STEP = 25;

  function makeKey(n) { return Math.round(n / STEP); }

  // key -> { key, modelCounts, minV, maxV, h, v, rows: [] }
  function buildKeyMap(rows, xF, yF) {
    var map = {};
    rows.forEach(function (r) {
      var h = makeKey(xF(r.tokensN));
      var v = makeKey(yF(r.turnsN));
      var k = h + ':' + v;
      if (!map[k]) {
        map[k] = { key: k, h: h, v: v, minV: v, maxV: v, rows: [] };
      }
      map[k].rows.push(r);
      if (v < map[k].minV) map[k].minV = v;
      if (v > map[k].maxV) map[k].maxV = v;
    });
    return map;
  }

  // Deterministic collision resolution: when two candidate labels land too
  // close together, push the range(s) apart instead of dropping either one.
  function resolveRanges(cells) {
    var list = Object.keys(cells).map(function (k) { return cells[k]; });
    list.sort(function (a, b) { return (a.h - b.h) || (a.v - b.v); });
    for (var i = 0; i < list.length; i++) {
      for (var j = i + 1; j < list.length; j++) {
        var a = list[i];
        var b = list[j];
        if (Math.abs(a.h - b.h) > 1) continue;      // different columns
        var aV = a.minV, bV = b.minV;
        if (aV > bV) { var t = a; a = b; b = t; }    // sort by vertical start
        if (bV - aV < 3) {                            // overlap
          var overlap = 3 - (bV - aV);
          var push = Math.ceil(overlap / 2);
          a.maxV = Math.min(a.maxV + push, 9999);
          b.minV = Math.max(b.minV - push, -9999);
        }
      }
    }
  }

  // Cell -> concrete label anchor (coordinates are chart units, scaled later).
  function cellLabel(cell, rows, xF, yF) {
    var minRow = null;
    cell.rows.forEach(function (r) {
      if (!minRow || yF(r.turnsN) < yF(minRow.turnsN)) minRow = r;
    });
    var cx = xF(minRow.tokensN);
    return { cx: cx, cy: yF(minRow.turnsN), label: minRow.model, row: minRow };
  }

  function candidateAnchor(r, xF, yF) {
    return { cx: xF(r.tokensN), cy: yF(r.turnsN), label: r.model, row: r };
  }

  // Tries to shorten where two labelled points sit close; keeps things tidy.
  function shortNames(model) {
    var s = model;
    s = s.replace(/^lmstudio-(jdc-ws|jdcmedia)\//, '');
    s = s.replace(/^openrouter\//, '');
    s = s.replace(/^mistral\//, '');
    return s;
  }

  // Returns [{ row, cx, cy, label, isLabel, count }]
  function placeLabels(rows, xF, yF) {
    if (!rows.length) return [];
    var map = buildKeyMap(rows, xF, yF);
    resolveRanges(map);

    var cells = Object.keys(map).map(function (k) { return map[k]; });
    var anchors = [];
    var NO_LABEL = [];
    var used = {};

    cells.forEach(function (cell) {
      var labelKey = cell.key;
      var count = cell.rows.length;
      if (used[labelKey]) {
        // duplicate key (two cells resolved to the same anchor) — drop the label
        var idx = anchors.indexOf(used[labelKey]);
        if (idx !== -1) { anchors.splice(idx, 1); NO_LABEL.push(used[labelKey]); }
        return;
      }
      var a = cellLabel(cell, rows, xF, yF);
      if (count > 1) {
        // too crowded for a direct label — shared numeric tag at the centroid
        a.isLabel = false;
        a.count = count;
      } else {
        a.isLabel = true;
        a.count = 1;
      }
      a.short = shortNames(a.label);
      anchors.push(a);
      used[labelKey] = a;
    });

    // Dropped duplicate keys: place those rows' own labels if the space allows.
    var point = { ptUsed: {} };
    (function () { /* no-op, kept for parity */ })();

    // Position candidate labels for the multi-row duplicate cells.
    var dupRows = [];
    cells.forEach(function (cell) {
      if (NO_LABEL.indexOf(cell.key) !== -1) {
        cell.rows.forEach(function (r) { dupRows.push(r); });
      }
    });

    // Deterministic check: assign labels to the dropped rows unless they
    // collide with already-placed anchors. Simple greedy in rows order.
    dupRows.forEach(function (r) {
      var a = candidateAnchor(r, xF, yF);
      var collides = anchors.some(function (o) {
        return Math.abs(o.cx - a.cx) < 30 && Math.abs(o.cy - a.cy) < 26;
      });
      if (!collides) {
        a.isLabel = true;
        a.count = 1;
        a.short = shortNames(a.label);
        anchors.push(a);
      }
    });

    return anchors;
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
      if (summaryEl) summaryEl.textContent = '';
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
      '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
      'aria-label="Scatter plot of total context used against turns for successful evaluation runs">'
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

    // --- Labels (behind points so points stay readable) ---------------
    anchors.forEach(function (a) {
      var fill = modelColor(a.label);
      if (a.isLabel) {
        out.push(
          '<text class="pt-label pt-label--name" x="' + (a.cx + 10) + '" y="' + a.cy + '" ' +
          'fill="' + fill + '">' + esc(a.short) + '</text>'
        );
      } else if (a.count > 1) {
        out.push(
          '<g class="pt-tag" data-count="' + a.count + '">' +
          '<rect x="' + (a.cx - 13) + '" y="' + (a.cy - 11) + '" width="26" height="22" rx="11"/>' +
          '<text x="' + a.cx + '" y="' + (a.cy + 4) + '" text-anchor="middle">+' + a.count + '</text>' +
          '</g>'
        );
      }
    });

    // --- Points ---------------------------------------------------------
    rows.forEach(function (r, i) {
      var px = x(r.tokensN);
      var py = y(r.turnsN);
      var c = modelColor(r.model);
      pointPos[i] = {
        row: r,
        left: ((M.left + px) / W) * 100,
        top: ((M.top + py) / H) * 100
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
    drawLegend();
    updatePin();
    renderSummary(rows);
  }

  function renderSummary(rows) {
    if (!summaryEl) return;
    var total = allRows.filter(isSuccessful).length;
    var modelCount = state.models ? state.models.split(',').length : modelOrder.length;
    var scope = state.source === 'all'
      ? 'all sources'
      : (state.source === 'Provider' ? 'provider runs' : 'local runs');
    var text = 'Showing ' + rows.length + ' of ' + total + ' successful runs (' + scope;
    if (state.models) text += ', ' + modelCount + ' of ' + modelOrder.length + ' models selected';
    else text += ', all ' + modelOrder.length + ' models';
    text += ').';
    if (state.models === '' && state.top !== 'all') text += ' Ranked by context used.';
    text += ' Model labels are placed where space allows.';
    summaryEl.textContent = text;
  }

  function drawLegend() {
    if (!legendEl) return;
    var selected = state.models ? state.models.split(',') : [];
    var html =
      '<div class="legend-head">' +
      '<span class="legend-head__label">Models — click to toggle</span>' +
      '<span class="legend-actions">' +
      '<button type="button" class="legend-btn" id="legend-all">All</button>' +
      '<button type="button" class="legend-btn" id="legend-none">None</button>' +
      '</span>' +
      '</div>';

    html += '<div class="legend-items">' +
      modelOrder.map(function (m) {
        var active = !state.models || selected.indexOf(m) !== -1;
        var visible = active; // visibility is derived at draw time
        var cls = 'legend-item' + (active ? ' is-active' : '') + (visible ? '' : ' is-dim');
        return (
          '<button type="button" class="' + cls + '" data-model="' + esc(m) + '" ' +
          'style="--modcol:' + modelColor(m) + '">' +
          '<span class="legend-swatch" style="background:' + modelColor(m) + '"></span>' +
          '<span class="legend-name">' + esc(m) + '</span>' +
          '</button>'
        );
      }).join('') +
      '</div>';

    legendEl.innerHTML = html;

    Array.prototype.forEach.call(legendEl.querySelectorAll('.legend-item'), function (btn) {
      btn.addEventListener('click', function () {
        var m = btn.getAttribute('data-model');
        var selected = state.models ? state.models.split(',') : modelOrder.slice();
        var i = selected.indexOf(m);
        if (i === -1) selected.push(m);
        else selected.splice(i, 1);
        state.models = selected.length === modelOrder.length ? '' : selected.join(',');
        draw();
      });
    });

    var allBtn = legendEl.querySelector('#legend-all');
    var noneBtn = legendEl.querySelector('#legend-none');
    if (allBtn) allBtn.addEventListener('click', function () { state.models = ''; draw(); });
    if (noneBtn) noneBtn.addEventListener('click', function () { state.models = 'NONE'; draw(); });
  }

  /* ------------------------------------------------------------------ *
   * Interactions
   * ------------------------------------------------------------------ */

  function bindPoints() {
    Array.prototype.forEach.call(chartEl.querySelectorAll('.pt'), function (g) {
      var idx = +g.getAttribute('data-idx');
      g.addEventListener('mouseenter', function () { showTooltip(idx); });
      g.addEventListener('mouseleave', function () { hideTooltip(); });
      g.addEventListener('focus', function () { showTooltip(idx); });
      g.addEventListener('blur', function () { hideTooltip(); });
      g.addEventListener('click', function () {
        pinned = pinned === idx ? -1 : idx;
        updatePin();
      });
    });
  }

  function syncControls() {
    sourceBtns.forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-source') === state.source));
      btn.classList.toggle('is-active', btn.getAttribute('data-source') === state.source);
    });
    if (topSel) {
      topSel.disabled = state.models !== '';
      topSel.value = String(state.top);
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
      draw();
    });
  });
  if (topSel) {
    topSel.addEventListener('change', function () {
      state.top = topSel.value === 'all' ? 'all' : parseInt(topSel.value, 10);
      draw();
    });
  }
  if (retryEl) retryEl.addEventListener('click', load);

  load();
})();