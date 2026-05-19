// Re-inject content script on YouTube SPA navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.url && tab.url.includes('youtube.com/watch')) {
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    }).catch(() => {});
  }
});
