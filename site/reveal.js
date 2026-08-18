/* Reveal-on-scroll for [data-reveal] elements.
 *
 * The hiding is done by CSS scoped to .js-reveal, which is set by a one-liner in the page head --
 * before first paint, so there is no flash of a visible card being hidden again. If that script or
 * this one fails, nothing is ever hidden and the page reads exactly as it would have.
 */
(function () {
  'use strict';

  var items = document.querySelectorAll('[data-reveal]');
  if (!items.length) return;

  function revealAll() {
    items.forEach(function (el) { el.classList.add('revealed'); });
  }

  // Old browsers, or a reader who has asked for less motion and should not have content gated
  // behind a scroll position at all.
  if (!('IntersectionObserver' in window) ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    revealAll();
    return;
  }

  // IntersectionObserver callbacks are suspended while a tab is in the background, so a page opened
  // in a background tab could sit with everything at opacity 0. A direct geometry check covers that
  // and any other case where the observer does not get to run.
  function inView(el) {
    var r = el.getBoundingClientRect();
    return r.top < (window.innerHeight || 0) && r.bottom > 0;
  }
  function sweep() {
    items.forEach(function (el) { if (inView(el)) el.classList.add('revealed'); });
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('revealed');
      io.unobserve(entry.target); // Reveal once; re-animating on every scroll past is nausea, not polish.
    });
  }, { threshold: 0.2, rootMargin: '0px 0px -40px 0px' });

  items.forEach(function (el) { io.observe(el); });
  sweep();                                          // anything already on screen at load
  window.addEventListener('scroll', sweep, { passive: true });
  document.addEventListener('visibilitychange', sweep);
})();
