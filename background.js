// Service worker — manages settings and generates the toolbar icon

const DEFAULT_SETTINGS = {
  blockAds: true,
  backgroundPlay: true,
  removeUpsells: true,
  adsBlocked: 0,
  timeSavedSeconds: 0,
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(null);
  const merged = { ...DEFAULT_SETTINGS, ...existing };
  await chrome.storage.local.set(merged);
  generateIcon();
});

chrome.runtime.onStartup.addListener(() => {
  generateIcon();
});

// Generate the toolbar icon using OffscreenCanvas
function generateIcon() {
  const sizes = [16, 48, 128];
  const imageDataMap = {};

  for (const size of sizes) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const s = size;

    // Background circle — YouTube red
    ctx.fillStyle = '#FF0000';
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
    ctx.fill();

    // White play triangle
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.moveTo(s * 0.38, s * 0.28);
    ctx.lineTo(s * 0.38, s * 0.72);
    ctx.lineTo(s * 0.76, s * 0.50);
    ctx.closePath();
    ctx.fill();

    // Gold crown at top
    if (size >= 48) {
      ctx.fillStyle = '#FFD700';
      ctx.beginPath();
      ctx.moveTo(s * 0.22, s * 0.30);
      ctx.lineTo(s * 0.31, s * 0.14);
      ctx.lineTo(s * 0.50, s * 0.22);
      ctx.lineTo(s * 0.69, s * 0.14);
      ctx.lineTo(s * 0.78, s * 0.30);
      ctx.closePath();
      ctx.fill();
    }

    imageDataMap[size] = ctx.getImageData(0, 0, s, s);
  }

  chrome.action.setIcon({
    imageData: {
      16: imageDataMap[16],
      48: imageDataMap[48],
      128: imageDataMap[128],
    },
  });
}

// Receive stat updates from content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'AD_SKIPPED') {
    chrome.storage.local.get(['adsBlocked', 'timeSavedSeconds'], (data) => {
      const newCount = (data.adsBlocked || 0) + 1;
      const newTime = (data.timeSavedSeconds || 0) + (msg.duration || 5);
      chrome.storage.local.set({ adsBlocked: newCount, timeSavedSeconds: newTime });
    });
  }
  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.local.get(null, (settings) => sendResponse(settings));
    return true; // async response
  }
});
