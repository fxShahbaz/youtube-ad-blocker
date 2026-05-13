// YT Unleashed — page-world patch (runs in the page's MAIN execution world)
//
// This is the keystone of the "instant play" experience. It runs at
// document_start *before* any YouTube script executes, and it intercepts the
// player API response so YouTube's player never even tries to load an ad.
//
// How YouTube serves ads:
//   1. The page calls /youtubei/v1/player to get the watch-page video info.
//   2. The response includes ad metadata in fields like `playerAds`,
//      `adPlacements`, `adSlots`, and `adBreakHeartbeatParams`.
//   3. The player reads those fields and prepends ad video streams to the
//      playback queue before the real video.
//
// Our patch:
//   - Intercepts `window.fetch` and the XHR `responseText` getter.
//   - For requests to /youtubei/v1/player or /youtubei/v1/next, parses the
//     JSON response, deletes every ad-related key (recursively), and returns
//     a clean response.
//   - Also blanks `ytInitialPlayerResponse` (the inline server-rendered
//     player config) before any script can read it.
//
// Result: the player loads the real video directly. No ad buffering, no
// transition gap, no black cloak needed. ~1–2 seconds saved per video.

(function ytuPagePatch() {
  'use strict';

  if (window.__ytuPagePatched) return;
  window.__ytuPagePatched = true;

  // Keys at any level of the player-response tree that hold ad data
  const AD_KEYS = new Set([
    'adPlacements',
    'adPlacementRenderer',
    'playerAds',
    'adSlots',
    'adBreakHeartbeatParams',
    'adBreaks',
    'adCpn',
    'adServingDataKey',
    'adsAttributes',
    'adsSafetyReason',
    'auxiliaryUi',
  ]);

  // Recursively strip ad keys from any object/array.
  // Walks the entire tree because YouTube wraps the data in several layers
  // (e.g. response.playerResponse.adPlacements vs response.adPlacements).
  function stripAds(obj, depth) {
    if (!obj || depth > 12) return obj;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) stripAds(obj[i], depth + 1);
      return obj;
    }
    if (typeof obj !== 'object') return obj;
    for (const key of Object.keys(obj)) {
      if (AD_KEYS.has(key)) {
        delete obj[key];
      } else {
        stripAds(obj[key], depth + 1);
      }
    }
    return obj;
  }

  function isPlayerUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return (
      url.includes('/youtubei/v1/player') ||
      url.includes('/youtubei/v1/next') ||
      url.includes('/youtubei/v1/reel/reel_item_watch') ||
      url.includes('/get_midroll_info') ||
      url.includes('/api/stats/ads')
    );
  }

  // ── fetch() interception ─────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = function patchedFetch(input, init) {
    const url =
      typeof input === 'string'
        ? input
        : input && input.url
        ? input.url
        : '';

    const result = origFetch.apply(this, arguments);

    if (!isPlayerUrl(url)) return result;

    return result.then((response) => {
      // Clone so the original stream stays untouched if we fail
      return response
        .clone()
        .text()
        .then((text) => {
          try {
            const data = JSON.parse(text);
            stripAds(data, 0);
            return new Response(JSON.stringify(data), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          } catch (_) {
            return response; // not JSON or parse error → pass through
          }
        })
        .catch(() => response);
    });
  };

  // ── XHR interception ─────────────────────────────────────────────────────
  // YouTube uses both fetch and XHR depending on code path. We override the
  // responseText getter so any caller reading it sees ad-stripped JSON.
  const xhrProto = XMLHttpRequest.prototype;
  const origOpen = xhrProto.open;
  xhrProto.open = function patchedOpen(method, url) {
    this.__ytuUrl = url;
    return origOpen.apply(this, arguments);
  };

  const textDesc = Object.getOwnPropertyDescriptor(xhrProto, 'responseText');
  if (textDesc && textDesc.get) {
    Object.defineProperty(xhrProto, 'responseText', {
      configurable: true,
      get() {
        const raw = textDesc.get.call(this);
        if (!isPlayerUrl(this.__ytuUrl)) return raw;
        try {
          const data = JSON.parse(raw);
          stripAds(data, 0);
          return JSON.stringify(data);
        } catch (_) {
          return raw;
        }
      },
    });
  }

  const respDesc = Object.getOwnPropertyDescriptor(xhrProto, 'response');
  if (respDesc && respDesc.get) {
    Object.defineProperty(xhrProto, 'response', {
      configurable: true,
      get() {
        const raw = respDesc.get.call(this);
        if (!isPlayerUrl(this.__ytuUrl) || raw == null) return raw;
        // responseType may be 'json' (already parsed) or '' (string)
        if (typeof raw === 'object') {
          stripAds(raw, 0);
          return raw;
        }
        if (typeof raw === 'string') {
          try {
            const data = JSON.parse(raw);
            stripAds(data, 0);
            return JSON.stringify(data);
          } catch (_) {
            return raw;
          }
        }
        return raw;
      },
    });
  }

  // ── Inline player response on first page load ────────────────────────────
  // YouTube also sets `var ytInitialPlayerResponse = {...}` in an inline
  // <script>. By the time the player JS reads it, we've already stripped ads.
  let _yipr;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get() {
        return _yipr;
      },
      set(val) {
        if (val) stripAds(val, 0);
        _yipr = val;
      },
    });
  } catch (_) {}

  // Same for the older ytplayer.config path
  let _ytplayer;
  try {
    Object.defineProperty(window, 'ytplayer', {
      configurable: true,
      get() {
        return _ytplayer;
      },
      set(val) {
        if (val && val.config && val.config.args) {
          try {
            if (val.config.args.player_response) {
              const pr = JSON.parse(val.config.args.player_response);
              stripAds(pr, 0);
              val.config.args.player_response = JSON.stringify(pr);
            }
          } catch (_) {}
        }
        _ytplayer = val;
      },
    });
  } catch (_) {}
})();
