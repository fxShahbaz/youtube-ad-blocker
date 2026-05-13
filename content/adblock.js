// YT Unleashed — GOD MODE ad blocker (isolated content-script world)
//
// Strategy: a single 100ms tick that does five things in priority order:
//   1. Kill the "Ad blockers violate YouTube's Terms" popup (and unfreeze
//      the player if YouTube paused it).
//   2. Kill the "Keep Ads / Go ad-free" YouTube Premium upsell popup.
//   3. If a video ad is playing: mute audio, click any skip button (force),
//      jump video.currentTime to video.duration.
//   4. Remove banner / sidebar / feed ads from the DOM (including their
//      grid-cell wrappers so CSS Grid auto-flows the surrounding videos).
//   5. Resume playback if YouTube paused due to background-tab logic.
//
// Plus a MutationObserver does the same on every DOM insertion so anything
// that slips into the page is killed within microseconds, not 100ms.

(function ytuGodMode() {
  'use strict';

  let settings = { blockAds: true, backgroundPlay: true, removeUpsells: true };
  try {
    chrome.storage.local.get(null, (s) => {
      if (s) settings = { ...settings, ...s };
    });
  } catch (_) {}

  // ────────────────────────────────────────────────────────────────────────
  // SELECTORS
  // ────────────────────────────────────────────────────────────────────────

  // Direct ad surfaces that should always be killed on sight
  const AD_SELECTORS = [
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
    'ytd-merch-shelf-renderer',
    'ytd-product-carousel-container-renderer',
  ];

  // Upsell / promo surfaces
  const UPSELL_SELECTORS = [
    'ytd-premium-yva-upsell-renderer',
    'ytd-mealbar-promo-renderer',
    'ytd-statement-banner-renderer',
    'ytd-popup-container ytd-mealbar-promo-renderer',
    'tp-yt-paper-toast.ytd-mealbar-promo-renderer',
  ];

  // Anti-adblock enforcement popup — YouTube's "you're using an ad blocker" notice
  const ANTI_ADBLOCK_SELECTORS = [
    'ytd-enforcement-message-view-model',
    'tp-yt-paper-dialog[aria-labelledby*="enforcement"]',
  ];

  // Grid cell / section wrappers — if their entire content was just an ad,
  // remove the whole wrapper so CSS Grid auto-flows neighbors with no gap.
  const WRAPPER_SELECTOR =
    'ytd-rich-item-renderer, ytd-rich-section-renderer, ytd-shelf-renderer, ' +
    'ytd-item-section-renderer, ytd-horizontal-card-list-renderer';

  // ────────────────────────────────────────────────────────────────────────
  // DOM HELPERS
  // ────────────────────────────────────────────────────────────────────────

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => (root || document).querySelectorAll(sel);

  function removeWithWrapper(el) {
    if (!el || !el.isConnected) return;
    const target = el.closest(WRAPPER_SELECTOR) || el;
    target.remove();
  }

  function safeRemoveAll(selectorList) {
    selectorList.forEach((sel) => {
      try {
        $$(sel).forEach(removeWithWrapper);
      } catch (_) {}
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // VIDEO AD KILLER
  // ────────────────────────────────────────────────────────────────────────

  let _userPaused = false;

  function getVideo() {
    return $('.html5-video-player video') || $('video');
  }

  function getPlayer() {
    return $('.html5-video-player');
  }

  function isAdShowing() {
    const p = getPlayer();
    return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'));
  }

  function forceClickSkip() {
    // Try every known skip-button class — YouTube has shipped at least 4
    const selectors = [
      '.ytp-ad-skip-button-modern',
      '.ytp-skip-ad-button-modern',
      '.ytp-ad-skip-button',
      '.ytp-skip-ad-button',
      'button[class*="skip-ad-button"]',
      '.ytp-ad-skip-button-container button',
    ];
    for (const sel of selectors) {
      const btn = $(sel);
      if (!btn) continue;
      try {
        btn.removeAttribute('disabled');
        btn.click();
        // Some YouTube builds need a real mouse event sequence
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      } catch (_) {}
      return true;
    }
    return false;
  }

  function killVideoAd() {
    if (!isAdShowing()) return;
    const video = getVideo();
    if (!video) return;

    // 1. Always mute during ad (cheap to re-assert)
    video.muted = true;

    // 2. Click the skip button if it exists (might be the only skip available)
    forceClickSkip();

    // 3. Jam currentTime to the end. The browser fires `ended`, YouTube
    // transitions to the real video. This works for skippable AND
    // unskippable ads as long as seeking isn't blocked.
    if (video.duration && !isNaN(video.duration) && video.duration > 1) {
      if (video.currentTime < video.duration - 0.5) {
        try {
          video.currentTime = video.duration;
        } catch (_) {
          // Seeking blocked → speed through it
          video.playbackRate = 16;
        }
      }
    }
  }

  function restoreVideoAfterAd() {
    if (isAdShowing()) return;
    const video = getVideo();
    if (!video) return;
    if (video.muted) video.muted = false;
    if (video.playbackRate === 16) video.playbackRate = 1;
  }

  // ────────────────────────────────────────────────────────────────────────
  // ANTI-ADBLOCK POPUP KILLER
  //
  // YouTube serves a full-screen modal that says "Ad blockers violate
  // YouTube's Terms of Service" and pauses the video. We detect it by
  // tag name AND by the giveaway text it always contains, then remove the
  // popup container and resume playback.
  // ────────────────────────────────────────────────────────────────────────

  function killAntiAdblockPopup() {
    let killed = false;

    // 1. Direct selectors
    ANTI_ADBLOCK_SELECTORS.forEach((sel) => {
      $$(sel).forEach((el) => {
        const popup = el.closest('ytd-popup-container, tp-yt-paper-dialog') || el;
        popup.remove();
        killed = true;
      });
    });

    // 2. Text-based detection — scan visible popup containers for telltale
    // strings. Covers both the "ad blockers violate…" notice and the
    // newer "Keep Ads / Go ad-free" Premium upsell shown in the screenshot.
    $$('ytd-popup-container, tp-yt-paper-dialog, ytd-modal-with-title-and-button-renderer').forEach((popup) => {
      const text = (popup.textContent || '').toLowerCase();
      if (
        text.includes('ad block') ||
        text.includes('adblock') ||
        text.includes('ad-block') ||
        text.includes('ad blocker') ||
        text.includes('keep ads') ||
        text.includes('go ad-free') ||
        text.includes('enjoy ad-free') ||
        (text.includes('youtube premium') && text.includes('ad'))
      ) {
        const container = popup.closest('ytd-popup-container') || popup;
        container.remove();
        killed = true;
      }
    });

    if (killed) {
      // YouTube pauses the player when it shows the anti-adblock popup;
      // resume playback now that the popup is gone.
      const v = getVideo();
      if (v && v.paused && !_userPaused) {
        v.play().catch(() => {});
      }
      // Also clear the dimmed body overlay if present
      const overlay = $('tp-yt-iron-overlay-backdrop');
      if (overlay) overlay.remove();
      document.body.style.overflow = '';
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // BACKGROUND PLAY (resume video if YouTube paused it on tab switch)
  // ────────────────────────────────────────────────────────────────────────

  function ensureBackgroundPlay() {
    if (!settings.backgroundPlay) return;
    const v = getVideo();
    if (!v) return;
    if (v.paused && !_userPaused && !isAdShowing() && v.readyState >= 3) {
      v.play().catch(() => {});
    }
  }

  function trackUserPauseIntent() {
    document.addEventListener(
      'click',
      (e) => {
        const t = e.target;
        if (t.closest && (t.closest('.ytp-play-button') || t.closest('.html5-main-video'))) {
          const v = getVideo();
          if (v) _userPaused = !v.paused; // playing → user wants pause
        }
      },
      true
    );
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'Space' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
          const v = getVideo();
          if (v) _userPaused = !v.paused;
        }
      },
      true
    );
  }

  // ────────────────────────────────────────────────────────────────────────
  // MAIN TICK — runs every 100ms
  // ────────────────────────────────────────────────────────────────────────

  function tick() {
    try {
      // ORDER MATTERS: kill the popup FIRST so it doesn't visually flicker
      // and so we resume playback before doing anything else.
      killAntiAdblockPopup();

      if (settings.blockAds) {
        killVideoAd();
        restoreVideoAfterAd();
        safeRemoveAll(AD_SELECTORS);
        removeSponsoredCards();
      }

      if (settings.removeUpsells) {
        safeRemoveAll(UPSELL_SELECTORS);
      }

      ensureBackgroundPlay();
    } catch (_) {}
  }

  // ────────────────────────────────────────────────────────────────────────
  // HEURISTIC SWEEP for sidebar/feed ads using "Sponsored" text giveaway
  // ────────────────────────────────────────────────────────────────────────

  function removeSponsoredCards() {
    const roots = $$(
      '#secondary, #secondary-inner, #related, ytd-watch-next-secondary-results-renderer, ' +
      '#contents.ytd-rich-grid-renderer'
    );
    roots.forEach((root) => {
      root.querySelectorAll('span, yt-formatted-string').forEach((el) => {
        if (el.children.length > 0) return;
        const text = el.textContent.trim().toLowerCase();
        if (!text) return;
        if (
          text === 'sponsored' ||
          text.startsWith('sponsored ') ||
          text.includes('ads.google.com')
        ) {
          let container = el.closest(
            'ytd-companion-slot-renderer, ytd-ad-slot-renderer, ytd-display-ad-renderer, ' +
            'ytd-promoted-sparkles-web-renderer, ytd-promoted-sparkles-text-search-renderer, ' +
            'ytd-statement-banner-renderer, ytd-action-companion-ad-renderer, ' +
            'ytd-rich-section-renderer, ytd-rich-item-renderer, ' +
            'ytd-engagement-panel-section-list-renderer, ytd-player-legacy-desktop-watch-ads-renderer'
          );
          if (!container) {
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

  // ────────────────────────────────────────────────────────────────────────
  // MUTATION OBSERVER — kill things the instant they appear, don't wait 100ms
  // ────────────────────────────────────────────────────────────────────────

  const adSelectorString = AD_SELECTORS.join(',');
  const upsellSelectorString = UPSELL_SELECTORS.join(',');
  const antiAdblockSelectorString = ANTI_ADBLOCK_SELECTORS.join(',');

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      // Class change on player → maybe entered/exited ad
      if (m.type === 'attributes' && m.attributeName === 'class') {
        const el = m.target;
        if (el.classList && (el.classList.contains('ad-showing') || el.classList.contains('ad-interrupting'))) {
          killVideoAd();
        }
      }

      if (!m.addedNodes.length) continue;
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;

        // Anti-adblock popup — kill on sight (highest priority)
        if (
          node.matches?.(antiAdblockSelectorString) ||
          node.querySelector?.(antiAdblockSelectorString)
        ) {
          killAntiAdblockPopup();
          return;
        }

        // YouTube Premium / "Keep Ads" popup — same idea, by text content
        if (node.tagName === 'YTD-POPUP-CONTAINER' || node.tagName === 'TP-YT-PAPER-DIALOG') {
          // Defer one tick so text content is populated
          setTimeout(killAntiAdblockPopup, 0);
        }

        if (settings.blockAds) {
          const ad = node.matches?.(adSelectorString)
            ? node
            : node.querySelector?.(adSelectorString);
          if (ad) {
            removeWithWrapper(ad);
            return;
          }
        }

        if (settings.removeUpsells) {
          const up = node.matches?.(upsellSelectorString)
            ? node
            : node.querySelector?.(upsellSelectorString);
          if (up) removeWithWrapper(up);
        }
      });
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // INIT
  // ────────────────────────────────────────────────────────────────────────

  function init() {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });

    trackUserPauseIntent();

    // Main 100ms tick. Cheap because each helper bails fast when there's
    // nothing to do.
    setInterval(tick, 100);

    // First sweep immediately
    tick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
