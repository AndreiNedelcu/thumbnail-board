// Re-trigger init in content script on YouTube SPA navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.url && tab.url.includes('youtube.com/watch')) {
    chrome.tabs.sendMessage(tabId, { type: 'TB_URL_CHANGED', url: tab.url }).catch(() => {});
  }
});

// Let content script ask for the current tab URL (always reliable from background)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TB_GET_URL') {
    chrome.tabs.get(sender.tab.id, (tab) => {
      sendResponse({ url: tab.url || '' });
    });
    return true; // keep channel open for async response
  }
});
