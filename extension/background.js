// Re-trigger init in content script on YouTube SPA navigation
// (avoids double-injection by using messaging instead of executeScript)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.url && tab.url.includes('youtube.com/watch')) {
    chrome.tabs.sendMessage(tabId, { type: 'TB_URL_CHANGED' }).catch(() => {});
  }
});
