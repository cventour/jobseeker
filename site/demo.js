/* The dashboard demo: a cursor that walks the tab strip while the screenshots switch under it.
 *
 * Real screenshots rather than a recreated UI, so it cannot drift out of date with the app the way
 * a hand-built mock would. They are all 2800px wide and taken from the sample dataset shipped with
 * the repository, which is why the tab coordinates below are shared and why no real employer or
 * contact appears in any of them.
 *
 * Percentages, never pixels: the frame is fluid, so a hardcoded cursor position would be right at
 * exactly one window width. Each tab's x is its centre in the source image over 2800; y is the tab
 * strip's centre over 1421, the height the frame's aspect ratio is pinned to.
 */
(function () {
  'use strict';

  var demo = document.querySelector('[data-demo]');
  if (!demo) return;

  var shots = demo.querySelectorAll('.demo-view img');
  var cursor = demo.querySelector('.demo-cursor');
  if (shots.length < 2 || !cursor) return;

  // x: centre of each tab in the source screenshots. y: the tab strip itself.
  var STEPS = [
    { x: 5.6,  scroll: 0 },    // Today
    { x: 13.2, scroll: -9 },   // Applications -- the longest table, so it earns a scroll
    { x: 26.6, scroll: -7 },   // Jobs
    { x: 52.6, scroll: 0 }     // Activity
  ];
  var TAB_Y = 17.7;
  var HOLD = 3400;   // time spent reading a tab before moving on
  var TRAVEL = 950;  // cursor flight time, matched to the CSS transition

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var i = 0, timer = null, running = false;

  function show(n) {
    shots.forEach(function (img, k) {
      img.classList.toggle('on', k === n);
      // Only the visible shot is offset; resetting the others means a tab always re-enters from
      // the top rather than remembering where it was left.
      img.style.transform = 'translateY(' + (k === n ? STEPS[n].scroll : 0) + '%)';
    });
  }

  function place(n) {
    cursor.style.left = STEPS[n].x + '%';
    cursor.style.top = TAB_Y + '%';
  }

  function step() {
    var next = (i + 1) % STEPS.length;
    place(next);                                   // cursor travels first...
    timer = setTimeout(function () {
      cursor.classList.add('click');               // ...then the click lands...
      setTimeout(function () { cursor.classList.remove('click'); }, 420);
      i = next;
      show(i);                                     // ...and the tab changes under it.
      timer = setTimeout(step, HOLD);
    }, TRAVEL);
  }

  function start() {
    if (running || reduced.matches) return;
    running = true;
    timer = setTimeout(step, 1400);
  }

  function stop() {
    running = false;
    clearTimeout(timer);
  }

  show(0);
  place(0);
  demo.classList.add('ready');

  if (reduced.matches) return; // A static first frame is the whole experience, and that is fine.

  // Animating a demo nobody is looking at burns battery for nothing -- but the observer is only an
  // optimisation, never the thing that decides whether the demo works. Its callbacks are suspended
  // in a background tab, so a geometry check backs it up; otherwise a page opened in a background
  // tab would show a frozen screenshot for as long as it stayed there.
  function onScreen() {
    var r = demo.getBoundingClientRect();
    var h = window.innerHeight || 0;
    return r.top < h - h * 0.15 && r.bottom > h * 0.15;
  }
  function check() { onScreen() ? start() : stop(); }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { e.isIntersecting ? start() : stop(); });
    }, { threshold: 0.35 }).observe(demo);
  }
  check();
  window.addEventListener('scroll', check, { passive: true });
  window.addEventListener('resize', check, { passive: true });

  document.addEventListener('visibilitychange', function () {
    document.hidden ? stop() : start();
  });
})();
