// Theme pre-paint hook — loaded non-deferred in each page's <head>, ahead of
// the stylesheet, so the saved choice is applied before the first paint (no
// flash of the default theme). This only APPLIES what site.js persisted under
// the "car.theme" key; the toggle itself lives in site.js. Dark is the :root
// default in styles.css, so an unsaved visit — or a blocked/failed load of
// this file — simply renders the default dark theme.
(function () {
  try {
    var t = localStorage.getItem('car.theme');
    if (t === 'light' || t === 'dark') {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (e) { /* storage unavailable: stay on the default */ }
})();
