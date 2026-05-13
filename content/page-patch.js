// YT Unleashed — page-world patch (MAIN execution world, document_start)
//
// Intercepts /youtubei/v1/player responses and strips ad metadata so YouTube
// never queues an ad stream. Real video loads immediately.
//
// Critical implementation detail: when we rebuild the Response we MUST strip
// content-encoding and content-length headers. The original response was
// Brotli/gzip compressed; our new body is plain JSON. If we keep the
// content-encoding header, YouTube tries to decompress plain text as Brotli,
// fails, and stalls — which manifests as a multi-second loading delay.

(function ytuPagePatch() {
  'use strict';

  if (window.__ytuPagePatched) return;
  window.__ytuPagePatched = true;

  function stripAds(obj) {
    if (!obj || typeof obj !== 'object') return;
    try {
      delete obj.adPlacements;
      delete obj.playerAds;
      delete obj.adSlots;
      delete obj.adBreakHeartbeatParams;
      delete obj.adBreaks;
      // Nested player response (next-endpoint wraps the player response)
      if (obj.playerResponse) stripAds(obj.playerResponse);
    } catch (_) {}
  }

  function isPlayerUrl(url) {
    return typeof url === 'string' && url.indexOf('/youtubei/v1/player') !== -1;
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = function ytuFetch(input, init) {
    const url =
      typeof input === 'string' ? input : input && input.url ? input.url : '';
    const promise = origFetch(input, init);

    if (!isPlayerUrl(url)) return promise;

    return promise
      .then(function (response) {
        if (!response || !response.ok) return response;
        return response
          .clone()
          .text()
          .then(function (text) {
            try {
              const data = JSON.parse(text);
              stripAds(data);
              // CRITICAL: drop content-encoding + content-length so the
              // browser doesn't try to Brotli-decode our plain JSON body.
              const headers = new Headers(response.headers);
              headers.delete('content-encoding');
              headers.delete('content-length');
              return new Response(JSON.stringify(data), {
                status: response.status,
                statusText: response.statusText,
                headers: headers,
              });
            } catch (_) {
              return response;
            }
          })
          .catch(function () {
            return response;
          });
      })
      .catch(function () {
        return promise;
      });
  };

  // Inline server-rendered player response (first page load).
  // Stripping this prevents the very first video from getting an ad.
  let _yipr;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: function () {
        return _yipr;
      },
      set: function (v) {
        try {
          if (v) stripAds(v);
        } catch (_) {}
        _yipr = v;
      },
    });
  } catch (_) {}
})();
