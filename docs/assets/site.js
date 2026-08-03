(function () {
  'use strict';

  // Shared site behaviour. Mark the current page in the site nav using the
  // body[data-page] attribute, so links stay in sync as pages are added —
  // no per-page edits needed beyond setting the attribute in the HTML.
  var page = document.body.getAttribute('data-page');
  if (!page) return;

  Array.prototype.forEach.call(
    document.querySelectorAll('.site-nav__link[data-page-link]'),
    function (link) {
      if (link.getAttribute('data-page-link') === page) {
        link.setAttribute('aria-current', 'page');
      }
    }
  );
})();
