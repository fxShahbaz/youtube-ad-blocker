// YT Unleashed — page-world patch (MAIN execution world, document_start)
//
// SINGLE PURPOSE: background play. Content scripts run in an isolated JS
// world, so Object.defineProperty(document, 'hidden', …) from adblock.js
// doesn't affect what YouTube's own code sees. This script runs in the
// page's main world before any YouTube script, and overrides the Page
// Visibility API so YouTube never thinks the tab is hidden.
//
// We do NOT intercept fetch/XHR here. Previous versions did, and that
// caused two problems: (a) Brotli content-encoding header mismatches that
// stalled the player, and (b) anti-adblock detection that triggered the
// "Ad blockers violate YouTube's Terms" popup.

(function ytuPageWorldPatch() {
  'use strict';
  if (window.__ytuPagePatched) return;
  window.__ytuPagePatched = true;

  try {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    Object.defineProperty(document, 'webkitHidden', {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(document, 'webkitVisibilityState', {
      configurable: true,
      get: () => 'visible',
    });

    // Drop any visibilitychange listener YouTube tries to register.
    const _orig = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, opts) {
      if (type === 'visibilitychange' || type === 'webkitvisibilitychange') return;
      return _orig.call(this, type, listener, opts);
    };
  } catch (_) {}
})();
