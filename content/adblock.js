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
  // Tracks whether we've already issued the destructive skip (seek + 16x)
  // for the current ad. Prevents the 50ms loop from re-applying these
  // commands while YouTube is transitioning to the real video, which was
  // causing long buffering/loading delays.
  let _adKillFired = false;

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
    // Defensive: bail if the ad-showing class is gone. Without this guard the
    // 50ms loop can fire one extra time *after* YouTube has started loading
    // the real video, and re-applying currentTime=duration / playbackRate=16
    // on the real video element causes the long buffering delay.
    if (!isShowingAd()) return;
    const video = getVideo();
    if (!video) return;

    // Keep audio silenced (cheap to re-assert)
    if (!video.muted) video.muted = true;

    // Skip button → instant exit. Safe to call on every tick; clickSkipButton
    // returns false when no button is present, so we fall through to the
    // forced-end below for unskippable ads.
    if (clickSkipButton()) return;

    // For the forced-end path, only act ONCE per ad. Re-asserting these
    // values 20 times per second was confusing YouTube's state machine
    // and dramatically extending the "Loading…" gap before the real video.
    if (_adKillFired) return;

    if (video.duration && !isNaN(video.duration) && video.duration > 1) {
      _lastAdDuration = video.duration;
      try {
        video.currentTime = video.duration;
      } catch (_) {}
      video.playbackRate = 16;
      _adKillFired = true;
    }
  }

  function onAdStart() {
    if (_adActive) return;
    _adActive = true;
    _adKillFired = false;

    const video = getVideo();
    if (video) {
      _originalVolume = video.volume > 0 ? video.volume : 1;
      _originalMuted = video.muted && video.volume === 0 ? false : video.muted;
      _originalRate = video.playbackRate === 16 ? 1 : video.playbackRate;
    }

    if (!_adKillerInterval) {
      _adKillerInterval = setInterval(killAd, 100);
    }
    killAd();
  }

  function onAdEnd() {
    if (!_adActive) return;
    _adActive = false;
    _adKillFired = false;

    if (_adKillerInterval) {
      clearInterval(_adKillerInterval);
      _adKillerInterval = null;
    }

    const video = getVideo();
    if (video) {
      video.muted = _originalMuted;
      video.volume = _originalVolume;
      video.playbackRate = _originalRate;
      if (video.paused && !_userPaused) {
        video.play().catch(() => {});
      }
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

  // In a back-to-back ad sequence YouTube keeps `.ad-showing` set the whole
  // time but reloads the <video> source for each ad — durationchange and
  // loadstart fire on the boundary. Reset the kill flag so each new ad
  // also gets the seek-to-end treatment.
  function attachAdResetListeners() {
    const video = getVideo();
    if (!video || video._ytuAdResetBound) return;
    video._ytuAdResetBound = true;
    const reset = () => {
      if (_adActive) _adKillFired = false;
    };
    video.addEventListener('durationchange', reset);
    video.addEventListener('loadstart', reset);
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
    'ytd-promoted-sparkles-text-search-renderer',
    'ytd-promoted-video-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-search-pyv-renderer',
    'ytd-video-masthead-ad-v3-renderer',
    'ytd-companion-slot-renderer',
    'ytd-player-legacy-desktop-watch-ads-renderer',
    'ytd-engagement-panel-section-list-renderer[panel-identifier*="ad"]',
    'ytd-engagement-panel-section-list-renderer[target-id*="ad"]',
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
      try {
        document.querySelectorAll(sel).forEach(removeAndCollapse);
      } catch (_) {}
    });
    // Also catch empty grid cells left behind by aggressive YouTube placeholder logic
    document.querySelectorAll('ytd-rich-item-renderer').forEach((cell) => {
      if (cell.children.length === 0 || cell.textContent.trim() === '') {
        cell.remove();
      }
    });
    removeSponsoredCards();
  }

  // Heuristic sweep for sidebar / feed ad cards that don't match any of our
  // known custom-element selectors. YouTube ships new ad surfaces regularly
  // (e.g. the Google Ads "Performance Max" promo panel on watch pages) using
  // generic tag names, so we look for the universal tell: a "Sponsored" or
  // "ads.google.com" label inside the card.
  function removeSponsoredCards() {
    const roots = document.querySelectorAll(
      '#secondary, #secondary-inner, #related, ytd-watch-next-secondary-results-renderer, ' +
      '#contents.ytd-rich-grid-renderer, ytd-engagement-panel-section-list-renderer'
    );
    roots.forEach((root) => {
      // Look at leaf-ish nodes — spans and small divs typically hold the label
      root.querySelectorAll('span, div, yt-formatted-string').forEach((el) => {
        if (el.children.length > 0) return; // not a leaf text node
        const text = el.textContent.trim();
        if (!text) return;
        const lower = text.toLowerCase();
        if (
          lower === 'sponsored' ||
          lower === 'ad' ||
          lower.startsWith('sponsored ') ||
          lower.includes('ads.google.com')
        ) {
          // Walk up to the nearest meaningful container and remove it
          let container = el.closest(
            'ytd-companion-slot-renderer, ytd-ad-slot-renderer, ' +
            'ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer, ' +
            'ytd-promoted-sparkles-text-search-renderer, ytd-statement-banner-renderer, ' +
            'ytd-action-companion-ad-renderer, ytd-rich-section-renderer, ' +
            'ytd-rich-item-renderer, ytd-engagement-panel-section-list-renderer, ' +
            'ytd-player-legacy-desktop-watch-ads-renderer'
          );
          if (!container) {
            // No known wrapper — walk up a few levels looking for any ytd-*
            // custom element that isn't a top-level layout container.
            let node = el.parentElement;
            for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
              const tag = node.tagName?.toLowerCase() || '';
              if (
                tag.startsWith('ytd-') &&
                !tag.includes('app') &&
                !tag.includes('page-manager') &&
                !tag.includes('two-column') &&
                !tag.includes('watch-flexy')
              ) {
                container = node;
                break;
              }
            }
          }
          if (container && container.isConnected) container.remove();
        }
      });
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
