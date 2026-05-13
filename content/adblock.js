// YT Unleashed — LIGHTWEIGHT ad blocker (isolated content-script world)
//
// The previous version hung the page (Chrome's "Page Unresponsive" dialog):
//   - removeSponsoredCards walked every <span> in #secondary every 100ms.
//   - killAntiAdblockPopup read popup.textContent on every popup container
//     every 100ms (huge subtree walks).
//   - MutationObserver fired setTimeout(killAntiAdblockPopup) on every
//     popup-container insertion, queuing those heavy walks faster than
//     the browser could finish them.
//
// New design — CSS does the heavy lifting (text-based detection via :has()
// and aria-label selectors), JS only handles things CSS can't:
//   1. Click the skip button (DOM action).
//   2. Mute the video element + bump playbackRate to 16 (JS property).
//   3. Resume playback after we remove an anti-adblock popup.
//   4. Background-play: re-play() the video if YouTube paused it.
//
// No textContent walks. No span iteration. No popup-text scanning.

(function ytuLight() {
  'use strict';

  let settings = { blockAds: true, backgroundPlay: true, removeUpsells: true };
  try {
    chrome.storage.local.get(null, (s) => {
      if (s) settings = { ...settings, ...s };
    });
  } catch (_) {}

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => (root || document).querySelectorAll(sel);

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

  // ── User intent tracking (don't fight a deliberate pause) ────────────────
  let _userPaused = false;
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (t.closest && (t.closest('.ytp-play-button') || t.closest('.html5-main-video'))) {
        const v = getVideo();
        if (v) _userPaused = !v.paused;
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

  // ── Skip-button click ────────────────────────────────────────────────────
  const SKIP_SELECTORS = [
    '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button-modern',
    '.ytp-ad-skip-button',
    '.ytp-skip-ad-button',
    'button[class*="skip-ad-button"]',
  ];
  function forceClickSkip() {
    for (let i = 0; i < SKIP_SELECTORS.length; i++) {
      const btn = $(SKIP_SELECTORS[i]);
      if (btn) {
        try {
          btn.removeAttribute('disabled');
          btn.click();
        } catch (_) {}
        return true;
      }
    }
    return false;
  }

  // ── Ad video handler — runs every 200ms, very cheap ──────────────────────
  function killVideoAd() {
    if (!settings.blockAds || !isAdShowing()) return;
    const video = getVideo();
    if (!video) return;

    video.muted = true;
    if (forceClickSkip()) return;

    // Speed-blast through unskippable ads. We do NOT set currentTime —
    // hard-seeking to duration leaves the player stuck on the spinner.
    if (video.duration > 1 && video.playbackRate !== 16) {
      video.playbackRate = 16;
    }
  }

  function restoreAfterAd() {
    if (isAdShowing()) return;
    const video = getVideo();
    if (!video) return;
    if (video.playbackRate === 16) video.playbackRate = 1;
  }

  // ── Background play ──────────────────────────────────────────────────────
  function ensureBackgroundPlay() {
    if (!settings.backgroundPlay) return;
    const v = getVideo();
    if (!v) return;
    // Don't replay an ended video (would restart from 0 — the bug from the
    // last screenshot where the user got "stuck at 0:15 / 0:15").
    if (v.ended) return;
    if (isAdShowing()) return;
    if (v.paused && !_userPaused && v.readyState >= 3) {
      v.play().catch(() => {});
    }
  }

  // ── Resume after we kill an anti-adblock popup ───────────────────────────
  function resumeAfterPopupKill() {
    const v = getVideo();
    if (!v || v.ended || isAdShowing()) return;
    if (v.paused && !_userPaused) {
      v.play().catch(() => {});
    }
    // Strip the dim backdrop that ytd-popup-container left behind
    $$('tp-yt-iron-overlay-backdrop').forEach((b) => b.remove());
    document.body.style.removeProperty('overflow');
  }

  // ── Targeted MutationObserver — only specific tags, no text scanning ─────
  const AD_TAGS = new Set([
    'ytd-ad-slot-renderer',
    'ytd-action-companion-ad-renderer',
    'ytd-display-ad-renderer',
    'ytd-banner-promo-renderer',
    'ytd-promoted-sparkles-web-renderer',
    'ytd-promoted-sparkles-text-search-renderer',
    'ytd-promoted-video-renderer',
    'ytd-in-feed-ad-layout-renderer',
    'ytd-search-pyv-renderer',
    'ytd-companion-slot-renderer',
    'ytd-player-legacy-desktop-watch-ads-renderer',
    'ytd-mealbar-promo-renderer',
    'ytd-statement-banner-renderer',
    'ytd-premium-yva-upsell-renderer',
    'ytd-enforcement-message-view-model',
  ]);

  function handleAdNode(node) {
    const wrapper = node.closest('ytd-rich-item-renderer, ytd-rich-section-renderer') || node;
    wrapper.remove();
  }

  // When a ytd-popup-container is added, check (scoped to itself, fast)
  // whether it contains telltale ad/upsell buttons. If yes, remove it.
  function checkPopupContainer(popup) {
    // Scoped query — only this popup's subtree, not the whole document
    const giveaway = popup.querySelector(
      'ytd-enforcement-message-view-model, ' +
      'button[aria-label*="Keep Ads"], button[aria-label*="Keep ads"], ' +
      'button[aria-label*="Go ad-free"], button[aria-label*="ad-free"], ' +
      'button[aria-label*="ad blocker"], button[aria-label*="Ad blocker"]'
    );
    if (giveaway) {
      popup.remove();
      resumeAfterPopupKill();
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (let i = 0; i < mutations.length; i++) {
      const m = mutations[i];

      // Player class change → maybe entered ad
      if (m.type === 'attributes' && m.attributeName === 'class') {
        const el = m.target;
        if (el.classList && (el.classList.contains('ad-showing') || el.classList.contains('ad-interrupting'))) {
          killVideoAd();
        }
        continue;
      }

      if (!m.addedNodes || !m.addedNodes.length) continue;
      for (let j = 0; j < m.addedNodes.length; j++) {
        const node = m.addedNodes[j];
        if (node.nodeType !== 1) continue;
        const tag = node.tagName ? node.tagName.toLowerCase() : '';

        if (AD_TAGS.has(tag)) {
          handleAdNode(node);
          if (tag === 'ytd-enforcement-message-view-model') {
            resumeAfterPopupKill();
          }
          continue;
        }

        // ytd-popup-container — could be the "Keep Ads / Go ad-free" upsell.
        // Defer one microtask so its children are populated before we check.
        if (tag === 'ytd-popup-container') {
          Promise.resolve().then(() => {
            if (node.isConnected) checkPopupContainer(node);
          });
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  // ── Periodic sweeps ──────────────────────────────────────────────────────

  // Fast tick (200ms) — only video-element manipulation, very cheap.
  setInterval(() => {
    if (settings.blockAds) {
      killVideoAd();
      restoreAfterAd();
    }
    ensureBackgroundPlay();
  }, 200);

  // Slow tick (2s) — DOM cleanup. Direct selectors only, no text walks.
  const FALLBACK_SELECTORS = [
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
    'ytd-companion-slot-renderer',
    'ytd-player-legacy-desktop-watch-ads-renderer',
    'ytd-enforcement-message-view-model',
    'ytd-mealbar-promo-renderer',
    'ytd-statement-banner-renderer',
    'ytd-premium-yva-upsell-renderer',
  ];
  setInterval(() => {
    if (!settings.blockAds && !settings.removeUpsells) return;
    for (let i = 0; i < FALLBACK_SELECTORS.length; i++) {
      try {
        const list = document.querySelectorAll(FALLBACK_SELECTORS[i]);
        for (let j = 0; j < list.length; j++) handleAdNode(list[j]);
      } catch (_) {}
    }
    // Backdrop cleanup if any popup got removed but its backdrop lingered
    const backdrop = $('tp-yt-iron-overlay-backdrop[opened]');
    if (backdrop && !$('ytd-popup-container[active], tp-yt-paper-dialog[opened]')) {
      backdrop.remove();
    }
  }, 2000);
})();
