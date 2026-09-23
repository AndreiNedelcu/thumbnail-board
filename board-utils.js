/* Shared, side-effect-free board rules (also used by the regression checks). */
(function (root) {
  const ownTags = new Set(['channel-theseniordev-main', 'channel-theseniordev-podcast']);
  const ownNames = new Set(['theseniordev', 'therealseniordev', 'theseniordevpodcast', 'seniordev', 'seniordevpodcast']);
  const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function isOwnChannel(video) {
    return (video.tags || []).some(tag => ownTags.has(tag)) ||
      [video.channel, video.channelHandle].some(name => ownNames.has(normalize(name)));
  }
  function safeUrl(value) {
    if (typeof value !== 'string' || !value) return '';
    try {
      const url = new URL(value, 'https://board.local/');
      return ['https:', 'http:'].includes(url.protocol) ? value : '';
    } catch { return ''; }
  }
  // Grids (small) load YouTube's light 480px image first (~25 KB, fast CDN) and
  // fall back to our archived copy, so a video removed from YouTube still shows.
  // Full views (lightbox, copy) prefer the archived full-size image.
  function imageSources(video, small = false) {
    const saved = safeUrl(video.thumbnailUrl || video.thumbnail_url || video.imageUrl);
    const valid = /^[\w-]{11}$/.test(video.id || '');
    const yt = q => valid ? `https://img.youtube.com/vi/${video.id}/${q}.jpg` : '';
    const order = small ? [yt('hqdefault'), saved, yt('mqdefault')]
      : [saved, yt('maxresdefault'), yt('hqdefault'), yt('mqdefault'), yt('default')];
    return [...new Set(order.filter(Boolean))];
  }
  function channelUrl(video) {
    if (/^UC[\w-]{22}$/.test(video.channelId || '')) return `https://www.youtube.com/channel/${video.channelId}`;
    const url = safeUrl(video.channelUrl);
    if (url) {
      const parsed = new URL(url, 'https://board.local/');
      if (['www.youtube.com', 'youtube.com'].includes(parsed.hostname)) return parsed.href;
    }
    if (/^@[\w.-]+$/.test(video.channelHandle || '')) return `https://www.youtube.com/${video.channelHandle}`;
    return '';
  }
  function confirmedDeletedIds(response, requested) {
    if (!response || response.ok !== true) throw new Error(response?.msg || 'Deletion failed. Your thumbnails are unchanged.');
    const wanted = new Set(requested);
    if (Array.isArray(response.deletedIds)) return [...new Set(response.deletedIds.filter(id => wanted.has(id)))];
    // Compatibility with the current Worker, which only returns a count.
    if (response.deleted === wanted.size) return [...wanted];
    throw new Error('The server did not confirm the deletion. Reload to check before retrying.');
  }
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function imageMarkup(video, small=false) {
    const sources=imageSources(video,small);
    return `<img loading="lazy" decoding="async" alt="${escape(video.title||'Thumbnail')}" src="${escape(sources[0]||'image-unavailable.svg')}" data-sources="${escape(JSON.stringify(sources))}" data-source-index="0" onerror="TBBoard.imageError(this)" onload="TBBoard.imageLoaded(this)">`;
  }
  function imageError(img) {
    const sources=JSON.parse(img.dataset.sources||'[]');
    const next=Number(img.dataset.sourceIndex||0)+1;
    img.dataset.sourceIndex=String(next);
    if(next<sources.length) img.src=sources[next];
    else {img.onerror=null;img.onload=null;img.src='image-unavailable.svg';}
  }
  function imageLoaded(img) {
    if(img.naturalWidth<=120 && /\/(img\.youtube\.com|i\.ytimg\.com)\//.test(img.src))imageError(img);
  }
  function setImage(img,video) {
    const sources=imageSources(video);
    img.dataset.sources=JSON.stringify(sources);img.dataset.sourceIndex='0';
    img.onerror=()=>imageError(img);img.onload=()=>imageLoaded(img);
    img.src=sources[0]||'image-unavailable.svg';
  }
  const api = { isOwnChannel, imageSources, channelUrl, confirmedDeletedIds, imageMarkup, imageError, imageLoaded, setImage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TBBoard = api;
})(typeof window === 'undefined' ? globalThis : window);
