// Popup logic — reads/writes chrome.storage.local

const toggleAds = document.getElementById('toggle-ads');
const toggleBg = document.getElementById('toggle-bg');
const toggleUpsell = document.getElementById('toggle-upsell');
const adsBlockedEl = document.getElementById('ads-blocked');
const timeSavedEl = document.getElementById('time-saved');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

function formatTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function updateStatusPill(settings) {
  const active = settings.blockAds || settings.backgroundPlay || settings.removeUpsells;
  statusDot.className = 'status-dot' + (active ? '' : ' inactive');
  statusText.textContent = active ? 'Protection Active' : 'Protection Off';
}

// Load settings and stats from storage
chrome.storage.local.get(null, (data) => {
  toggleAds.checked = data.blockAds !== false;
  toggleBg.checked = data.backgroundPlay !== false;
  toggleUpsell.checked = data.removeUpsells !== false;

  adsBlockedEl.textContent = data.adsBlocked || 0;
  timeSavedEl.textContent = formatTime(data.timeSavedSeconds || 0);

  updateStatusPill({
    blockAds: toggleAds.checked,
    backgroundPlay: toggleBg.checked,
    removeUpsells: toggleUpsell.checked,
  });
});

// Save on toggle change and reload active YouTube tabs
function onToggleChange() {
  const newSettings = {
    blockAds: toggleAds.checked,
    backgroundPlay: toggleBg.checked,
    removeUpsells: toggleUpsell.checked,
  };
  chrome.storage.local.set(newSettings);
  updateStatusPill(newSettings);

  // Reload open YouTube tabs so the new settings take effect immediately
  chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
    tabs.forEach((tab) => chrome.tabs.reload(tab.id));
  });
}

toggleAds.addEventListener('change', onToggleChange);
toggleBg.addEventListener('change', onToggleChange);
toggleUpsell.addEventListener('change', onToggleChange);
