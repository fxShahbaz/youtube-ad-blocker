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

  // ─── AD LIFECYCLE & STEALTH SKIP ───────────────────────────────────────────
  // Strategy for "premium feel":
  //   1. On ad start: black out the player (CSS via data-ytu-ad), mute audio,
  //      save the user's original volume/rate so we can restore them cleanly.
  //   2. While the ad is active: poll every 50ms — click any skip button the
  //      instant it's in the DOM (ignore visibility, ignore `disabled`), and
  //      jam currentTime to the end + 16x rate as a fallback for unskippable
  //      ads where seeking is blocked.
  //   3. On ad end: clear the CSS overlay, restore audio/rate, stop polling.
  let _adActive = false;
  let _adKillerInterval = null;
  let _originalVolume = 1;
  let _originalMuted = false;
  let _originalRate = 1;
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
    return !!player && (
      player.classList.contains('ad-showing') ||
      player.classList.contains('ad-interrupting')
    );
  }

  // Force-click any skip button regardless of visibility/disabled state.
  // YouTube uses `disabled` during the 5s countdown — we override that.
  function clickSkipButton() {
    const btn = document.querySelector(
      '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, ' +
      'button[class*="skip-ad-button"], .ytp-ad-skip-button-container button'
    );
    if (!btn) return false;
    try {
      btn.removeAttribute('disabled');
      btn.click();
      // Also dispatch a mousedown/mouseup for stubborn handlers
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    } catch (_) {}
    return true;
  }

  // Called every 50ms while an ad is active.
  function killAd() {
    if (!settings.blockAds) return;
    const video = getVideo();
    if (!video) return;

    // Keep audio silenced no matter how YouTube fights back
    if (!video.muted) video.muted = true;
    if (video.volume !== 0) video.volume = 0;

    // Skip button → instant exit
    if (clickSkipButton()) return;

    // No skip available → jump to end. If seeking is blocked, the 16x
    // playback rate makes it finish in ~0.3s anyway.
    if (video.duration && !isNaN(video.duration) && video.duration > 0) {
      _lastAdDuration = video.duration;
      try {
        if (video.currentTime < video.duration - 0.1) {
          video.currentTime = video.duration;
        }
      } catch (_) {}
      if (video.playbackRate !== 16) video.playbackRate = 16;
    }
  }

  function onAdStart() {
    if (_adActive) return;
    _adActive = true;

    const video = getVideo();
    if (video) {
      _originalVolume = video.volume;
      _originalMuted = video.muted;
      _originalRate = video.playbackRate;
    }

    // CSS attribute drives the "black box over player" overlay
    document.documentElement.setAttribute('data-ytu-ad', '1');

    // Aggressive 50ms loop — clicks skip the instant it appears
    if (!_adKillerInterval) {
      _adKillerInterval = setInterval(killAd, 50);
    }
    killAd();
  }

  function onAdEnd() {
    if (!_adActive) return;
    _adActive = false;

    document.documentElement.removeAttribute('data-ytu-ad');

    const video = getVideo();
    if (video) {
      video.muted = _originalMuted;
      video.volume = _originalVolume;
      video.playbackRate = _originalRate === 16 ? 1 : _originalRate;
    }

    if (_adKillerInterval) {
      clearInterval(_adKillerInterval);
      _adKillerInterval = null;
    }

    reportAdSkipped();
  }

  function checkAdState() {
    const ad = isShowingAd();
    if (ad && !_adActive) onAdStart();
    else if (!ad && _adActive) onAdEnd();
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

  // Wrapper tags that occupy a grid cell / full-width slot in YouTube's layout.
  // Removing one of these makes CSS Grid auto-flow neighbors into the freed space.
  const WRAPPER_SELECTOR =
    'ytd-rich-item-renderer, ytd-rich-section-renderer, ytd-shelf-renderer, ' +
    'ytd-item-section-renderer, ytd-horizontal-card-list-renderer';

  // Walk up to find the outermost wrapper that should be removed instead of `el`.
  // Returns `el` itself if no wrapper ancestor exists.
  function findRemovalTarget(el) {
    return el.closest(WRAPPER_SELECTOR) || el;
  }

  function removeAndCollapse(el) {
    if (!el || !el.isConnected) return;
    const target = findRemovalTarget(el);
    const parent = target.parentElement;
    target.remove();

    // After removal, check if the parent row/section also became empty and collapse it.
    if (parent) {
      const parentTag = parent.tagName?.toLowerCase();
      if (
        (parentTag === 'ytd-rich-grid-row' ||
          parentTag === 'ytd-rich-shelf-renderer' ||
          parentTag === 'ytd-horizontal-list-renderer') &&
        parent.children.length === 0
      ) {
        parent.remove();
      }
    }
  }

  function removePageAds() {
    if (!settings.blockAds) return;
    PAGE_AD_SELECTORS.forEach((sel) => {
      document.querySelectorAll(sel).forEach(removeAndCollapse);
    });
    // Also catch empty grid cells left behind by aggressive YouTube placeholder logic
    document.querySelectorAll('ytd-rich-item-renderer').forEach((cell) => {
      if (cell.children.length === 0 || cell.textContent.trim() === '') {
        cell.remove();
      }
    });
  }

  function removeUpsells() {
    if (!settings.removeUpsells) return;
    UPSELL_SELECTORS.forEach((sel) => {
      document.querySelectorAll(sel).forEach(removeAndCollapse);
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

          // Look for ad elements inside the added subtree, not just the top node.
          // YouTube often inserts a wrapper (ytd-rich-item-renderer) with the ad
          // slot already nested inside it, so checking only `node.tagName` misses them.
          if (settings.blockAds) {
            const adInside = node.matches?.(PAGE_AD_SELECTORS.join(','))
              ? node
              : node.querySelector?.(PAGE_AD_SELECTORS.join(','));
            if (adInside) {
              removeAndCollapse(adInside);
              return;
            }
          }

          if (settings.removeUpsells) {
            const upsellInside = node.matches?.(UPSELL_SELECTORS.join(','))
              ? node
              : node.querySelector?.(UPSELL_SELECTORS.join(','));
            if (upsellInside) {
              removeAndCollapse(upsellInside);
            }
          }
        });
      }
    }

    if (adClassChange) {
      // Flip into / out of "ad active" mode immediately when YouTube toggles
      // the .ad-showing class on the player. onAdStart() spins up a 50ms
      // killer loop; onAdEnd() restores audio and clears the black overlay.
      checkAdState();
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

    // Polling loop as belt-and-suspenders fallback for the ad lifecycle
    // and DOM-level ad cleanup. The 50ms killAd loop is spun up separately
    // by onAdStart() and only runs while an ad is actually playing.
    setInterval(() => {
      checkAdState();
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
