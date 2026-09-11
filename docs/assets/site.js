(function () {
  'use strict';

  // Shared site behaviour.

  // Mark the current page in the site nav using the body[data-page]
  // attribute, so links stay in sync as pages are added — no per-page edits
  // needed beyond setting the attribute in the HTML.
  var page = document.body.getAttribute('data-page');
  if (page) {
    Array.prototype.forEach.call(
      document.querySelectorAll('.site-nav__link[data-page-link]'),
      function (link) {
        if (link.getAttribute('data-page-link') === page) {
          link.setAttribute('aria-current', 'page');
        }
      }
    );
  }

  // Theme toggle (top-right of the header). Dark is the CSS default — :root
  // carries the dark tokens and [data-theme="light"] overrides them — so the
  // only state to persist is an explicit choice. An inline head script in
  // each page applies the saved choice before first paint; this keeps the
  // button's label in sync and re-syncs it on each click, then dispatches
  // "site:themechange" so page scripts can re-render (the chart page re-inks
  // its SVG data colours, which are inline hex values and cannot track CSS
  // variables).
  var THEME_KEY = 'car.theme';
  var themeBtn = document.querySelector('[data-theme-toggle]');

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light'
      ? 'light'
      : 'dark';
  }

  function updateToggleLabel(theme) {
    if (!themeBtn) return;
    var label = 'Switch to ' + (theme === 'light' ? 'dark' : 'light') + ' theme';
    themeBtn.setAttribute('aria-label', label);
    themeBtn.setAttribute('title', label);
  }

  function setTheme(theme) {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      // Remove the attribute: dark is the :root default.
      document.documentElement.removeAttribute('data-theme');
    }
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) { /* storage unavailable: choice lasts this visit only */ }
    updateToggleLabel(theme);
    document.dispatchEvent(
      new CustomEvent('site:themechange', { detail: { theme: theme } })
    );
  }

  if (themeBtn) {
    // Label only — deliberately no storage write and no dispatch on load,
    // so a page visit with the saved (or default) theme is a no-op.
    updateToggleLabel(currentTheme());
    themeBtn.addEventListener('click', function () {
      setTheme(currentTheme() === 'light' ? 'dark' : 'light');
    });
  }
})();
