// YT Unleashed — content script (runs at document_start, all frames)
(function ytUnleashed() {
  'use strict';

  // ─── SETTINGS ──────────────────────────────────────────────────────────────
  let settings = { blockAds: true, backgroundPlay: true, removeUpsells: true };

  chrome.storage.local.get(null, (s) => {
    if (s) settings = { ...settings, ...s };
  });

  // ─── BACKGROUND PLAY PATCH (must run before YouTube's scripts) ─────────────
  // Override the Page Visibility API so YouTube never sees the tab as hidden.
  // This prevents auto-pause when minimizing the window or switching tabs.
  (function patchVisibility() {
    try {
      Object.defineProperty(document, 'hidden', {
        get: () => false,
        configurable: true,
      });
      Object.defineProperty(document, 'visibilityState', {
        get: () => 'visible',
        configurable: true,
      });

      // Drop any visibilitychange listener YouTube tries to register
      const _orig = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (type, listener, opts) {
        if (type === 'visibilitychange') return; // swallow YouTube's pause handler
        return _orig.call(this, type, listener, opts);
      };
    } catch (_) {}
  })();

  // ─── AD SKIP LOGIC ─────────────────────────────────────────────────────────
  let _lastAdDuration = 0;
  let _userPaused = false;

  function getVideo() {
    return document.querySelector('video');
  }

  function getPlayer() {
    return document.querySelector('.html5-video-player');
  }

  function isShowingAd() {
    const player = getPlayer();
    return player && (
      player.classList.contains('ad-showing') ||
      player.classList.contains('ad-interrupting')
    );
  }

  function skipCurrentAd() {
    if (!settings.blockAds) return;

    // Try the skip button first (user-friendly, least disruptive)
    const skipBtn = document.querySelector(
      '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, [class*="skip-ad-button"]'
    );
    if (skipBtn && skipBtn.offsetParent !== null) {
      skipBtn.click();
      reportAdSkipped();
      return;
    }

    const video = getVideo();
    if (!video || !isShowingAd()) return;

    // Speed through unskippable ads (16x hits end almost instantly)
    if (video.duration && !isNaN(video.duration) && video.duration > 0) {
      _lastAdDuration = video.duration;
      video.playbackRate = 16;
      video.volume = 0; // mute during ad
    }
  }

  function restoreVideoState() {
    const video = getVideo();
    if (!video) return;
    if (!isShowingAd() && video.playbackRate === 16) {
      video.playbackRate = 1;
      video.volume = 1;
      reportAdSkipped();
    }
  }

  function reportAdSkipped() {
    try {
      chrome.runtime.sendMessage({ type: 'AD_SKIPPED', duration: Math.round(_lastAdDuration) });
    } catch (_) {}
    _lastAdDuration = 0;
  }

  // ─── REMOVE DOM AD ELEMENTS ────────────────────────────────────────────────
  const PAGE_AD_SELECTORS = [
    '#masthead-ad',
    '#player-ads',
    'ytd-ad-slot-renderer',
    'ytd-action-companion-ad-renderer',
    'ytd-display-ad-renderer',
    'ytd-banner-promo-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-video-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-search-pyv-renderer',
    'ytd-video-masthead-ad-v3-renderer',
    'ytd-companion-slot-renderer',
  ];

  const UPSELL_SELECTORS = [
    'ytd-premium-yva-upsell-renderer',
    'ytd-mealbar-promo-renderer',
    'ytd-statement-banner-renderer',
    '.ytd-upsell-dialog-renderer',
    'tp-yt-paper-dialog[aria-label*="Premium"]',
    'tp-yt-paper-dialog[aria-label*="premium"]',
  ];

  function removePageAds() {
    if (!settings.blockAds) return;
    PAGE_AD_SELECTORS.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => el.remove());
    });
  }

  function removeUpsells() {
    if (!settings.removeUpsells) return;
    UPSELL_SELECTORS.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => el.remove());
    });
  }

  function removeVideoOverlays() {
    if (!settings.blockAds) return;
    [
      '.ytp-ad-overlay-container',
      '.ytp-ad-image-overlay',
      '.ytp-ad-text-overlay',
      '.ytp-ce-element',
      '.ytp-suggested-action',
      '.ytp-ad-action-interstitial',
    ].forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        el.style.display = 'none';
      });
    });
  }

  // ─── BACKGROUND PLAY: resume if YouTube managed to pause ──────────────────
  function keepPlaying() {
    if (!settings.backgroundPlay) return;
    const video = getVideo();
    if (!video || isShowingAd()) return;
    if (video.paused && !_userPaused && video.readyState >= 3) {
      video.play().catch(() => {});
    }
  }

  // ─── TRACK USER INTENT TO PAUSE ───────────────────────────────────────────
  function trackPauseIntent() {
    document.addEventListener(
      'click',
      (e) => {
        if (
          e.target.closest('.ytp-play-button') ||
          e.target.closest('.html5-main-video')
        ) {
          const v = getVideo();
          if (v) _userPaused = !v.paused; // if playing → user wants pause
        }
      },
      true
    );

    // Space bar pause
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'Space' && document.activeElement?.tagName !== 'INPUT') {
          const v = getVideo();
          if (v) _userPaused = !v.paused;
        }
      },
      true
    );
  }

  // ─── MUTATION OBSERVER ────────────────────────────────────────────────────
  const observer = new MutationObserver((mutations) => {
    let adClassChange = false;

    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'class') {
        const el = m.target;
        if (el.classList?.contains('ad-showing') || el.classList?.contains('ad-interrupting')) {
          adClassChange = true;
        }
      }

      if (m.addedNodes.length) {
        m.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          const tag = node.tagName?.toLowerCase();

          // Nuke ad elements the moment they're inserted
          if (
            settings.blockAds &&
            (tag === 'ytd-ad-slot-renderer' ||
              tag === 'ytd-action-companion-ad-renderer' ||
              tag === 'ytd-display-ad-renderer' ||
              tag === 'ytd-banner-promo-renderer' ||
              tag === 'ytd-promoted-video-renderer' ||
              tag === 'ytd-in-feed-ad-layout-renderer' ||
              (node.id === 'masthead-ad') ||
              (node.id === 'player-ads'))
          ) {
            node.remove();
            return;
          }

          // Nuke upsell dialogs the moment they're inserted
          if (
            settings.removeUpsells &&
            (tag === 'ytd-premium-yva-upsell-renderer' ||
              tag === 'ytd-mealbar-promo-renderer' ||
              tag === 'ytd-statement-banner-renderer')
          ) {
            node.remove();
          }
        });
      }
    }

    if (adClassChange) {
      // Stagger attempts to catch both skip button appearance and fast-forward fallback
      skipCurrentAd();
      setTimeout(skipCurrentAd, 100);
      setTimeout(skipCurrentAd, 400);
      setTimeout(skipCurrentAd, 900);
    }
  });

  // ─── INIT ─────────────────────────────────────────────────────────────────
  function init() {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });

    trackPauseIntent();

    // Polling loop as belt-and-suspenders fallback
    setInterval(() => {
      skipCurrentAd();
      restoreVideoState();
      removeVideoOverlays();
      removePageAds();
      removeUpsells();
      keepPlaying();
    }, 600);

    removePageAds();
    removeUpsells();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
