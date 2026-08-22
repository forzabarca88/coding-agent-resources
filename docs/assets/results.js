(function () {
  'use strict';

  // Loads data/eval-results.md and renders it as HTML. Also adds a filter
  // bar (search, status filter, sort) so the growing results stay easy to
  // search. Used by evaluation-results.html only.
  var RESULTS_PATH = 'data/eval-results.md';

  var statusEl = document.getElementById('results-status');
  var contentEl = document.getElementById('results-content');
  var retryEl = document.getElementById('results-retry');
  var controlsEl = document.getElementById('results-controls');

  // Filter/sort state, rebuilt fresh on every load.
  var state = {
    query: '',
    filter: 'all', // all | passed | failed | over
    sort: 'ranked' // ranked | newest | oldest | context-desc | ...
  };

  // One entry per rendered table: { el, heads:[], rows:[{tr,data,text}] }
  var sets = [];

  // Normalized column keys (lowercase, punctuation/space stripped).
  var C = {
    model: 'model',
    notes: 'notes',
    date: 'date',
    duration: 'duration',
    context: 'totalcontextused',
    turns: 'turns',
    limit: 'limit',
    exceeded: 'exceeded',
    exit: 'exit',
    passed: 'passedtests',
    failed: 'failedtests'
  };

  function normKey(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function setStatus(text) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.remove('results-status--error');
  }

  function showError(msg) {
    if (!statusEl) return;
    statusEl.classList.add('results-status--error');
    statusEl.textContent = msg;
    if (retryEl) retryEl.hidden = false;
  }

  // Presentational polish for the rendered table, derived from the table
  // itself so it can never drift from the source: right-align numeric
  // columns, flag failures, and color the exit code.
  function polishTable(table) {
    var numeric = /duration|context|turns|limit|exit|passed|failed/i;
    var heads = Array.prototype.slice.call(table.querySelectorAll('thead th'));
    heads.forEach(function (th) {
      if (numeric.test(th.textContent)) th.classList.add('num');
    });
    Array.prototype.forEach.call(table.querySelectorAll('tbody tr'), function (tr) {
      Array.prototype.forEach.call(tr.querySelectorAll('td'), function (td, i) {
        var th = heads[i];
        if (!th) return;
        if (numeric.test(th.textContent)) td.classList.add('num');
        if (/exceeded/i.test(th.textContent) && td.textContent.trim().toLowerCase() === 'yes') {
          td.classList.add('over');
        }
        if (/^exit/i.test(th.textContent) && td.textContent.trim() !== '') {
          td.classList.add(td.textContent.trim() === '0' ? 'exit-ok' : 'exit-fail');
        }
        if (/passed/i.test(th.textContent) && /^\d+$/.test(td.textContent.trim())) {
          td.classList.add('pass-count');
        }
        if (/failed/i.test(th.textContent) && /^\d+$/.test(td.textContent.trim()) && td.textContent.trim() !== '0') {
          td.classList.add('fail-count');
        }
      });
    });
  }

  // Parse each rendered table into structured rows for filtering/sorting.
  function buildSets() {
    sets = [];
    Array.prototype.forEach.call(contentEl.querySelectorAll('table'), function (table) {
      var heads = Array.prototype.map.call(table.querySelectorAll('thead th'), function (th) {
        return th.textContent.trim();
      });
      var rows = [];
      Array.prototype.forEach.call(table.querySelectorAll('tbody tr'), function (tr) {
        var data = {};
        var text = '';
        Array.prototype.forEach.call(tr.querySelectorAll('td'), function (td, i) {
          var name = heads[i];
          if (!name) return;
          var key = normKey(name);
          data[key] = td.textContent.trim();
          text += ' ' + td.textContent.trim();
        });
        rows.push({ tr: tr, data: data, text: text.toLowerCase() });
      });
      sets.push({ heads: heads, rows: rows });
    });
  }

  // --- Sorting ---------------------------------------------------------
  function toDate(s) {
    var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!m) return 0;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  }
  function toMs(s) {
    var mt = String(s || '').match(/(\d+)m/);
    var st = String(s || '').match(/(\d+)s/);
    return (+(mt ? mt[1] : 0)) * 60000 + (+(st ? st[1] : 0)) * 1000;
  }
  function toNum(s) {
    var v = parseInt(s, 10);
    return isNaN(v) ? null : v; // null = missing/unknown, handled as "worst"
  }

  // Unknown values (non-numeric, e.g. '?') should sort to the bottom rather
  // than claim the best slot, for every ranking key. For ascending keys the
  // worst slot is the largest (least favourable), for descending keys it is
  // the smallest, so each direction uses its own sentinel.
  function numAsc(a, b, key) {
    var av = toNum(a.data[key]);
    var bv = toNum(b.data[key]);
    return (av === null ? Number.POSITIVE_INFINITY : av) - (bv === null ? Number.POSITIVE_INFINITY : bv);
  }
  function numDesc(a, b, key) {
    var av = toNum(a.data[key]);
    var bv = toNum(b.data[key]);
    return (bv === null ? Number.NEGATIVE_INFINITY : bv) - (av === null ? Number.NEGATIVE_INFINITY : av);
  }

  function sortCompare(a, b) {
    switch (state.sort) {
      case 'oldest': return toDate(a.data[C.date]) - toDate(b.data[C.date]);
      case 'context-desc': return numDesc(a, b, C.context);
      case 'context-asc': return numAsc(a, b, C.context);
      case 'duration-desc': return toMs(b.data[C.duration]) - toMs(a.data[C.duration]);
      case 'duration-asc': return toMs(a.data[C.duration]) - toMs(b.data[C.duration]);
      case 'turns-desc': return numDesc(a, b, C.turns);
      case 'turns-asc': return numAsc(a, b, C.turns);
      case 'newest': return toDate(b.data[C.date]) - toDate(a.data[C.date]);
      default:
        // ranked (approximates the source ranking): most tests passed first,
        // then least context used, then fewest turns.
        var byPassed = numDesc(a, b, C.passed);
        if (byPassed) return byPassed;
        var byContext = numAsc(a, b, C.context);
        if (byContext) return byContext;
        return numAsc(a, b, C.turns);
    }
  }

  function applySort() {
    sets.forEach(function (set) {
      if (!set.rows.length) return;
      var tbody = set.rows[0].tr.parentNode;
      var order = set.rows.map(function (_, i) { return i; });
      order.sort(function (i, j) {
        var diff = sortCompare(set.rows[i], set.rows[j]);
        return diff !== 0 ? diff : i - j; // stable for equal keys
      });
      order.forEach(function (i) { tbody.appendChild(set.rows[i].tr); });
    });
  }

  // --- Filtering ---------------------------------------------------------
  function rowVisible(row) {
    if (state.query && row.text.indexOf(state.query) === -1) return false;
    var passed = row.data[C.exit] === '0' && row.data[C.failed] === '0';
    switch (state.filter) {
      case 'passed': return passed;
      case 'failed': return !passed;
      case 'over': return /yes/i.test(row.data[C.exceeded] || '');
      default: return true;
    }
  }

  function apply() {
    var total = 0, shown = 0;
    sets.forEach(function (set) {
      set.rows.forEach(function (row) {
        total++;
        var on = rowVisible(row);
        row.tr.style.display = on ? '' : 'none';
        if (on) shown++;
      });
    });
    if (shown === 0 && total > 0) {
      setStatus('No runs match your filters \u2014 clear or adjust them to see all ' + total + '.');
    } else {
      setStatus(shown + ' of ' + total + ' runs shown');
    }
  }

  // --- Controls ---------------------------------------------------------
  var searchInput, sortSelect, clearBtn, segBtns = [];

  function buildControls(el) {
    // Search
    var searchWrap = document.createElement('label');
    searchWrap.className = 'results-field';
    var searchLabel = document.createElement('span');
    searchLabel.className = 'results-field__label';
    searchLabel.textContent = 'Search';
    searchLabel.setAttribute('aria-hidden', 'true');
    searchWrap.appendChild(searchLabel);
    searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'results-search';
    searchInput.placeholder = 'Model, notes, date\u2026';
    searchInput.setAttribute('aria-label', 'Search evaluation runs');
    searchWrap.appendChild(searchInput);
    el.appendChild(searchWrap);

    // Status filter (segmented)
    var filterWrap = document.createElement('div');
    filterWrap.className = 'results-field';
    var filterLabel = document.createElement('span');
    filterLabel.className = 'results-field__label';
    filterLabel.textContent = 'Status';
    filterLabel.setAttribute('aria-hidden', 'true');
    filterWrap.appendChild(filterLabel);
    var seg = document.createElement('div');
    seg.className = 'seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Filter by run status');
    [
      ['all', 'All'],
      ['passed', 'Passed'],
      ['failed', 'Failed'],
      ['over', 'Over limit']
    ].forEach(function (opt) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn';
      b.textContent = opt[1];
      b.setAttribute('aria-pressed', opt[0] === state.filter ? 'true' : 'false');
      if (opt[0] === state.filter) b.classList.add('is-active');
      b.addEventListener('click', function () {
        state.filter = opt[0];
        segBtns.forEach(function (sb) {
          sb.btn.setAttribute('aria-pressed', String(sb.id === state.filter));
          sb.btn.classList.toggle('is-active', sb.id === state.filter);
        });
        apply();
      });
      segBtns.push({ id: opt[0], btn: b });
      seg.appendChild(b);
    });
    filterWrap.appendChild(seg);
    el.appendChild(filterWrap);

    // Sort
    var sortWrap = document.createElement('label');
    sortWrap.className = 'results-field';
    var sortLabel = document.createElement('span');
    sortLabel.className = 'results-field__label';
    sortLabel.textContent = 'Sort';
    sortLabel.setAttribute('aria-hidden', 'true');
    sortWrap.appendChild(sortLabel);
    sortSelect = document.createElement('select');
    sortSelect.className = 'results-select';
    sortSelect.setAttribute('aria-label', 'Sort evaluation runs');
    [
      ['ranked', 'Default (passed, context, turns)'],
      ['newest', 'Newest first'],
      ['oldest', 'Oldest first'],
      ['context-desc', 'Context: high to low'],
      ['context-asc', 'Context: low to high'],
      ['duration-desc', 'Duration: long to short'],
      ['duration-asc', 'Duration: short to long'],
      ['turns-desc', 'Turns: high to low'],
      ['turns-asc', 'Turns: low to high']
    ].forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o[0];
      opt.textContent = o[1];
      sortSelect.appendChild(opt);
    });
    sortSelect.value = state.sort;
    sortSelect.addEventListener('change', function () {
      state.sort = sortSelect.value;
      applySort();
      apply();
    });
    sortWrap.appendChild(sortSelect);
    el.appendChild(sortWrap);

    // Clear
    clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'results-clear';
    clearBtn.textContent = 'Clear filters';
    clearBtn.addEventListener('click', function () {
      state.query = '';
      state.filter = 'all';
      state.sort = 'ranked';
      if (searchInput) searchInput.value = '';
      if (sortSelect) sortSelect.value = state.sort;
      segBtns.forEach(function (sb) {
        sb.btn.setAttribute('aria-pressed', String(sb.id === 'all'));
        sb.btn.classList.toggle('is-active', sb.id === 'all');
      });
      applySort();
      apply();
    });
    el.appendChild(clearBtn);

    searchInput.addEventListener('input', function () {
      state.query = searchInput.value.trim().toLowerCase();
      apply();
    });
  }

  function render(md) {
    if (typeof marked === 'undefined') {
      showError('The markdown renderer failed to load. Check your connection and reload the page.');
      return;
    }
    contentEl.innerHTML = marked.parse(md);
    Array.prototype.forEach.call(contentEl.querySelectorAll('table'), polishTable);
    buildSets();
    if (controlsEl) {
      controlsEl.innerHTML = '';
      buildControls(controlsEl);
      controlsEl.hidden = false;
    }
    applySort();
    apply();
  }

  function load() {
    setStatus('Loading data/eval-results.md\u2026');
    if (retryEl) retryEl.hidden = true;
    if (controlsEl) controlsEl.hidden = true;
    fetch(RESULTS_PATH, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(render)
      .catch(function () {
        showError(
          'Couldn\u2019t load the results file (data/eval-results.md). ' +
          'It is generated by agent-evaluation/run-eval.sh \u2014 run an evaluation first, then reload.'
        );
      });
  }

  if (retryEl) retryEl.addEventListener('click', load);
  load();
})();