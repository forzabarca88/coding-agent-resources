(function () {
  'use strict';

  // Loads data/eval-results.md and renders a scatter plot of successful runs:
  // Total Context Used (tokens) on the X axis, Turns on the Y axis, points
  // coloured by Model. Used by visualization.html only. Always derives
  // everything from the markdown file at runtime — nothing is hardcoded.
  var RESULTS_PATH = 'data/eval-results.md';

  var statusEl = document.getElementById('viz-status');
  var chartEl = document.getElementById('viz-chart');
  var tooltipEl = document.getElementById('viz-tooltip');
  var legendEl = document.getElementById('viz-legend');
  var summaryEl = document.getElementById('viz-summary');
  var retryEl = document.getElementById('viz-retry');
  var sourceBtns = Array.prototype.slice.call(document.querySelectorAll('[data-source]'));
  var modelSel = document.getElementById('model-filter');
  var topSel = document.getElementById('top-filter');

  // Muted print-ink hues, in the same family as the site palette, assigned to
  // models in order of appearance. Fixed order keeps colours stable across
  // reloads regardless of how the markdown changes.
  var PALETTE = [
    '#2E4A7A', // carbon blue
    '#1F6F8F', // sea
    '#0E7A7B', // teal
    '#5B7A2E', // leaf
    '#A86A2B', // ochre
    '#B42318', // rust
    '#7A4A6B', // plum
    '#4A5A78'  // slate
  ];

  var state = { source: 'all', model: 'all', top: 10 };

  // Every parsed row from the markdown tables, in file order.
  var allRows = [];
  // Distinct model names that produced a successful run, in file order.
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

  function visibleRows() {
    var rows = allRows.filter(function (r) {
      if (!isSuccessful(r)) return false;
      if (state.source === 'Provider' && r.local) return false;
      if (state.source === 'Local' && !r.local) return false;
      if (state.model !== 'all' && r.model !== state.model) return false;
      return true;
    });
    rows.sort(function (a, b) { return b.tokensN - a.tokensN; });
    if (state.model === 'all' && state.top !== 'all') {
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
   * Tooltip
   * ------------------------------------------------------------------ */

  function tooltipHTML(r) {
    return (
      '<div class="tip__model">' + esc(r.model) + '</div>' +
      '<div class="tip__tag">' + (r.local ? 'Local' : 'Provider') + ' · ' + esc(r.date || '—') + '</div>' +
      '<dl class="tip__grid">' +
      '<dt>Context used</dt><dd>' + fmt(r.tokensN) + ' tokens</dd>' +
      '<dt>Turns</dt><dd>' + fmt(r.turnsN) + '</dd>' +
      '<dt>Duration</dt><dd>' + esc(r.duration || '—') + '</dd>' +
      '<dt>Limit</dt><dd>' + fmt(r.limitN) + '</dd>' +
      '<dt>Exceeded</dt><dd>' + esc(r.exceeded || '—') + '</dd>' +
      '<dt>Exit</dt><dd>' + esc(r.code) + '</dd>' +
      '<dt>Passed</dt><dd>' + fmt(r.passedN) + '</dd>' +
      '<dt>Failed</dt><dd>' + fmt(r.failedN) + '</dd>' +
      '</dl>' +
      (r.notes ? '<p class="tip__notes">' + esc(r.notes) + '</p>' : '')
    );
  }

  function showTooltip(idx) {
    var p = pointPos[idx];
    if (!p) return;
    tooltipEl.innerHTML = tooltipHTML(p.row);
    tooltipEl.classList.remove('is-hidden');
    var margin = 16; // gap from the point
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
   * Drawing
   * ------------------------------------------------------------------ */

  function draw() {
    var rows = visibleRows();
    pointPos = [];

    if (!rows.length) {
      chartEl.innerHTML = '';
      tooltipEl.classList.add('is-hidden');
      if (summaryEl) summaryEl.textContent = '';
      if (legendEl) legendEl.innerHTML = '';
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
    drawLegend(rows);
    bindPoints();
    updatePin();
    renderSummary(rows);
  }

  function renderSummary(rows) {
    if (!summaryEl) return;
    var total = allRows.filter(isSuccessful).length;
    var scope = state.source === 'all' ? 'all sources' : (state.source === 'Provider' ? 'provider (cloud) runs' : 'local runs');
    summaryEl.textContent =
      'Showing ' + rows.length + ' of ' + total + ' successful runs (' + scope + '), ' +
      'ranked by context used. Each point is one row of data/eval-results.md.';
  }

  function drawLegend(rows) {
    if (!legendEl) return;
    var shown = {};
    rows.forEach(function (r) { shown[r.model] = true; });
    var models = modelOrder.filter(function (m) { return shown[m]; });

    var html = models.map(function (m) {
      var active = state.model === m ? ' is-active' : '';
      return (
        '<button type="button" class="legend-item' + active + '" data-model="' + esc(m) + '">' +
        '<span class="legend-swatch" style="background:' + modelColor(m) + '"></span>' +
        '<span class="legend-name">' + esc(m) + '</span>' +
        '</button>'
      );
    }).join('');

    legendEl.innerHTML = html || '<p class="legend-empty">No models match the current filters.</p>';

    Array.prototype.forEach.call(legendEl.querySelectorAll('.legend-item'), function (btn) {
      btn.addEventListener('click', function () {
        var m = btn.getAttribute('data-model');
        modelSel.value = m;
        state.model = m;
        syncControls();
        draw();
      });
    });
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
    if (modelSel) modelSel.value = state.model;
    if (topSel) {
      topSel.disabled = state.model !== 'all';
      topSel.value = String(state.top);
    }
  }

  function populateSelects() {
    if (!modelSel) return;
    modelSel.innerHTML = '<option value="all">All models</option>' +
      modelOrder.map(function (m) {
        return '<option value="' + esc(m) + '">' + esc(m) + '</option>';
      }).join('');
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
        populateSelects();
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
  if (modelSel) {
    modelSel.addEventListener('change', function () {
      state.model = modelSel.value;
      syncControls();
      draw();
    });
  }
  if (topSel) {
    topSel.addEventListener('change', function () {
      state.top = topSel.value === 'all' ? 'all' : parseInt(topSel.value, 10);
      draw();
    });
  }
  if (retryEl) retryEl.addEventListener('click', load);

  load();
})();
