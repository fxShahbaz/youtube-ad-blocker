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
    // Property overrides — when YouTube's handlers check document.hidden /
    // visibilityState inside their listener, they'll see "visible" and won't
    // pause the video. This alone is enough for most YouTube builds.
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

    // Note: we deliberately do NOT override addEventListener anymore. The
    // previous global override blocked visibilitychange listeners across
    // every EventTarget — which broke YouTube's own end-of-video transition
    // pipeline and left videos stuck on the loading spinner. The property
    // overrides above handle the background-play case cleanly on their own.
  } catch (_) {}
})();
