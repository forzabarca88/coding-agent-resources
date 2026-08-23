(function () {
  'use strict';

  // Renders human-edited markdown content into the page. Every element with a
  // [data-content] attribute is a content slot: the attribute value is the
  // path (relative to the page) of a markdown file whose rendered HTML fills
  // the element (see docs/AGENTS.md).
  //
  // Rendering modes, chosen with data-content-mode:
  //   - default: the markdown fills the slot as-is (marked.parse);
  //   - "page-index": the markdown is a list of `## [Title](href)` entries,
  //     each followed by one description paragraph, and is rebuilt into the
  //     ledger-style <li> items used by index.html (see content/pages.md).
  // The markdown files are the single source of all written content; the
  // HTML slots must stay free of prose.

  function renderPageIndex(el, md) {
    var holder = document.createElement('div');
    holder.innerHTML = marked.parse(md);

    function warn(msg) {
      if (window.console && console.warn) console.warn('[content.js] ' + msg);
    }

    var items = [];
    Array.prototype.forEach.call(holder.querySelectorAll('h2'), function (h2) {
      var a = h2.querySelector('a');
      if (!a) {
        warn('page-index entry has no link and was skipped: "' + h2.textContent.trim() + '"');
        return;
      }
      var href = a.getAttribute('href');
      var title = a.textContent.trim();
      var p = h2.nextElementSibling;
      var desc = '';
      if (!p || p.tagName !== 'P') {
        warn('page-index entry "' + title + '" has no description paragraph; it will render without one.');
      } else {
        desc = p.innerHTML;
        // Only the first paragraph is used per entry; flag anything that
        // would otherwise be silently dropped.
        var extra = p.nextElementSibling;
        while (extra && extra.tagName !== 'H2') {
          warn('page-index entry "' + title + '" has content after its description that was ignored.');
          extra = extra.nextElementSibling;
        }
      }
      items.push({ href: href, title: title, desc: desc });
    });

    el.innerHTML = items.map(function (item) {
      return (
        '<li>' +
        '<a class="page-index__item" href="' + item.href + '">' +
        '<span class="page-index__path">' + item.href + '</span>' +
        '<span class="page-index__body">' +
        '<span class="page-index__title">' + item.title + '</span>' +
        '<span class="page-index__desc">' + item.desc + '</span>' +
        '</span>' +
        '<span class="page-index__meta">' +
        '<span class="tag">Live</span>' +
        '<span class="page-index__arrow" aria-hidden="true">\u2192</span>' +
        '</span>' +
        '</a>' +
        '</li>'
      );
    }).join('');
  }

  function renderSlot(el) {
    var src = el.getAttribute('data-content');
    if (!src) return;
    fetch(src, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (md) {
        if (typeof marked === 'undefined') throw new Error('marked unavailable');
        if (el.getAttribute('data-content-mode') === 'page-index') {
          renderPageIndex(el, md);
        } else {
          el.innerHTML = marked.parse(md);
        }
      })
      .catch(function () {
        var msg = 'Couldn\u2019t load ' + src + '.';
        // Keep the failure markup valid for the slot: a <p> inside the
        // page-index <ul> would be invalid HTML, so use an <li> there.
        el.innerHTML = el.getAttribute('data-content-mode') === 'page-index'
          ? '<li class="content-error">' + msg + '</li>'
          : '<p class="content-error">' + msg + '</p>';
      });
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-content]'), renderSlot);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();