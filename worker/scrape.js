/**
 * Thumbnail Board — YouTube scrape + outlier scoring.
 *
 * Runs from the Worker's scheduled() handler (cron every 6h) and from the
 * manual POST /api/scrape/run endpoint. Reads scrape_sources.json from the
 * repo, queries YouTube Data API v3, applies niche/age/views/duration/regex
 * filters, computes an outlier score per candidate (median views/day of the
 * channel's last 30 long-form videos), and returns the top N for the inbox.
 *
 * Costs (YouTube Data API v3 quota = 10k units/day):
 *   - search.list         = 100 units
 *   - channels.list       = 1 unit
 *   - playlistItems.list  = 1 unit
 *   - videos.list         = 1 unit (accepts up to 50 ids per call)
 */

const YT_API = 'https://www.googleapis.com/youtube/v3';

// Allowed YouTube category IDs (snippet.categoryId):
//   22 People & Blogs, 24 Entertainment, 26 Howto & Style,
//   27 Education,      28 Science & Tech
const ALLOWED_CATEGORY_IDS = new Set(['22', '24', '26', '27', '28']);

// Hard blocklist applied to title, channel name and (truncated) description.
const BLOCKLIST_REGEX = /\b(reaction|prank|asmr|mukbang|gameplay|let'?s play|fortnite|roblox|minecraft|cocomelon|peppa|toy review|nursery rhyme|family friendly gaming|unboxing haul)\b/i;
const KIDS_REGEX      = /\b(kids|kid'?s|children|baby|toddler|niñ[oa]s?)\b/i;

const DEFAULT_THRESHOLDS = {
  min_views:              50000,
  max_age_days:           730,
  min_duration_seconds:   90,
  min_outlier_score:      1.5,
  cap_per_run:            30,
};

// ── Utility ─────────────────────────────────────────────────────────
function parseISO8601Duration(iso) {
  // PT1H2M30S → seconds
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

function daysSince(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return Math.max(0, (Date.now() - t) / 86400000);
}

function formatViews(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── YouTube API helpers ─────────────────────────────────────────────
async function yt(env, path, params) {
  if (!env.YOUTUBE_API_KEY) {
    throw new Error('YOUTUBE_API_KEY secret not set on this Worker');
  }
  const url = new URL(`${YT_API}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  url.searchParams.set('key', env.YOUTUBE_API_KEY);
  const r = await fetch(url.toString());
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`YT ${path} ${r.status}: ${body.slice(0, 240)}`);
  }
  return r.json();
}

async function searchVideoIds(env, query, maxResults = 8) {
  const data = await yt(env, 'search', {
    part: 'snippet',
    q: query,
    maxResults,
    type: 'video',
    order: 'viewCount',
    relevanceLanguage: 'en',
    safeSearch: 'moderate',
  });
  return (data.items || []).map(it => it.id?.videoId).filter(Boolean);
}

async function resolveChannelHandle(env, handle) {
  const clean = handle.replace(/^@/, '').trim();
  if (!clean) return null;
  const data = await yt(env, 'channels', {
    part: 'contentDetails,snippet',
    forHandle: '@' + clean,
  });
  const ch = (data.items || [])[0];
  if (!ch) return null;
  return {
    channelId:         ch.id,
    uploadsPlaylistId: ch.contentDetails?.relatedPlaylists?.uploads || '',
    title:             ch.snippet?.title || clean,
  };
}

async function recentUploadsForPlaylist(env, playlistId, maxResults = 15) {
  const data = await yt(env, 'playlistItems', {
    part: 'contentDetails',
    playlistId,
    maxResults,
  });
  return (data.items || []).map(it => it.contentDetails?.videoId).filter(Boolean);
}

async function trendingVideoIds(env, categoryId, regionCode = 'US', maxResults = 25) {
  const data = await yt(env, 'videos', {
    part: 'id',
    chart: 'mostPopular',
    regionCode,
    videoCategoryId: categoryId,
    maxResults,
  });
  return (data.items || []).map(it => it.id).filter(Boolean);
}

async function videoDetailsBatch(env, ids) {
  if (!ids.length) return [];
  // YouTube accepts up to 50 ids per call
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    const data = await yt(env, 'videos', {
      part: 'snippet,statistics,contentDetails',
      id: slice.join(','),
    });
    out.push(...(data.items || []));
  }
  return out;
}

// ── Shorts detection ────────────────────────────────────────────────
/**
 * Detect a YouTube Short by following the /shorts/{id} URL:
 *   - real Short  → stays on  /shorts/{id}  (final URL pathname starts with /shorts/)
 *   - regular vid → redirects to /watch?v={id}
 * Needed because Shorts can now be up to 3 min long, so the duration
 * filter alone (>= 90s) misses ~15% of them.
 */
async function isShort(videoId) {
  try {
    const r = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (thumbnail-board-worker)' },
    });
    return new URL(r.url).pathname.startsWith('/shorts/');
  } catch {
    return false; // on network error, don't drop the candidate
  }
}

// ── Filters ─────────────────────────────────────────────────────────
function passesNicheFilter(video, thresholds) {
  const s     = video.snippet || {};
  const stats = video.statistics || {};
  const cd    = video.contentDetails || {};

  if (!ALLOWED_CATEGORY_IDS.has(s.categoryId)) return false;

  const title       = s.title || '';
  const channel     = s.channelTitle || '';
  const description = (s.description || '').slice(0, 600);

  if (BLOCKLIST_REGEX.test(title))       return false;
  if (BLOCKLIST_REGEX.test(channel))     return false;
  if (BLOCKLIST_REGEX.test(description)) return false;
  if (KIDS_REGEX.test(title))            return false;
  if (KIDS_REGEX.test(channel))          return false;

  // Defense in depth against Shorts (some pass through with #shorts tags)
  if (/#shorts?\b/i.test(title) || /#shorts?\b/i.test(description)) return false;

  const dur = parseISO8601Duration(cd.duration);
  if (dur < thresholds.min_duration_seconds) return false;

  const age = daysSince(s.publishedAt);
  if (age > thresholds.max_age_days) return false;

  const views = parseInt(stats.viewCount || '0', 10);
  if (views < thresholds.min_views) return false;

  return true;
}

// ── Outlier scoring ─────────────────────────────────────────────────
/**
 * Compute baseline views-per-day for a channel:
 *   - last 50 uploads
 *   - exclude Shorts (duration ≤ 60s)
 *   - require video age ≥ 30 days  (so the vpd has settled)
 *   - cap window at age ≤ 365 days (avoid channels that pivoted niche)
 *   - take the MEDIAN of views/day to resist a single previous viral
 * Cached in baselineCache (per scrape run) to avoid recomputing.
 */
async function getChannelBaseline(env, channelId, baselineCache) {
  if (baselineCache.has(channelId)) return baselineCache.get(channelId);

  let baseline = { median_vpd: 0, n: 0 };
  try {
    const chData = await yt(env, 'channels', { part: 'contentDetails', id: channelId });
    const uploads = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) {
      baselineCache.set(channelId, baseline);
      return baseline;
    }
    const ids = await recentUploadsForPlaylist(env, uploads, 50);
    if (!ids.length) {
      baselineCache.set(channelId, baseline);
      return baseline;
    }
    const videos = await videoDetailsBatch(env, ids);

    const vpds = [];
    for (const v of videos) {
      const dur = parseISO8601Duration(v.contentDetails?.duration);
      if (dur <= 60) continue; // skip Shorts
      const age = daysSince(v.snippet?.publishedAt);
      if (age < 30 || age > 365) continue;
      const views = parseInt(v.statistics?.viewCount || '0', 10);
      if (views <= 0) continue;
      vpds.push(views / Math.max(age, 1));
    }
    baseline = { median_vpd: median(vpds), n: vpds.length };
  } catch (e) {
    baseline = { median_vpd: 0, n: 0, error: e.message };
  }
  baselineCache.set(channelId, baseline);
  return baseline;
}

function calculateOutlierScore(video, baseline) {
  const views = parseInt(video.statistics?.viewCount || '0', 10);
  const age   = Math.max(daysSince(video.snippet?.publishedAt), 1);
  const targetVpd = views / age;

  if (baseline.median_vpd <= 0 || baseline.n < 3) {
    return {
      score:       0,
      confidence:  'low',
      baselineVpd: Math.round(baseline.median_vpd || 0),
      baselineN:   baseline.n || 0,
    };
  }
  const score = targetVpd / baseline.median_vpd;
  const confidence = (baseline.n >= 10 && age >= 14) ? 'high' : 'low';
  return {
    score:       +score.toFixed(2),
    confidence,
    baselineVpd: Math.round(baseline.median_vpd),
    baselineN:   baseline.n,
  };
}

// ── Main scrape function ────────────────────────────────────────────
/**
 * @param {object} env Worker env (YOUTUBE_API_KEY, ...)
 * @param {object} sources { channels, queries|search_queries, thresholds }
 * @param {Set<string>} excludeIds video IDs already in board/pending/rejected/inbox
 * @returns {Promise<{candidates: Array, stats: object}>}
 */
export async function runScrape(env, sources, excludeIds) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(sources.thresholds || {}) };
  const stats = {
    discovered:     0,
    after_dedup:    0,
    after_filters:  0,
    after_outlier:  0,
    kept:           0,
    errors:         [],
    started_at:     new Date().toISOString(),
  };

  const collected = new Set();

  // 1) Channels
  for (const handle of (sources.channels || [])) {
    try {
      const ch = await resolveChannelHandle(env, handle);
      if (!ch?.uploadsPlaylistId) continue;
      const ids = await recentUploadsForPlaylist(env, ch.uploadsPlaylistId, 15);
      for (const id of ids) collected.add(id);
    } catch (e) {
      stats.errors.push(`channel ${handle}: ${e.message}`);
    }
  }

  // 2) Queries (search.list — 100 units each, use sparingly)
  for (const q of (sources.queries || sources.search_queries || [])) {
    try {
      const ids = await searchVideoIds(env, q, 8);
      for (const id of ids) collected.add(id);
    } catch (e) {
      stats.errors.push(`query "${q}": ${e.message}`);
    }
  }

  // 3) Trending: Education + Science & Tech
  for (const cat of ['27', '28']) {
    try {
      const ids = await trendingVideoIds(env, cat, 'US', 25);
      for (const id of ids) collected.add(id);
    } catch (e) {
      stats.errors.push(`trending ${cat}: ${e.message}`);
    }
  }

  stats.discovered = collected.size;

  const candidateIds = [...collected].filter(id => !excludeIds.has(id));
  stats.after_dedup = candidateIds.length;
  if (!candidateIds.length) return { candidates: [], stats };

  // 4) Fetch full video details
  const allVideos = await videoDetailsBatch(env, candidateIds).catch(e => {
    stats.errors.push(`details: ${e.message}`);
    return [];
  });

  // 5) Niche filter
  const niched = allVideos.filter(v => passesNicheFilter(v, thresholds));
  stats.after_filters = niched.length;

  // 5b) Shorts detection — only for the gray zone (≤ 200s). Longer videos
  //     can't be Shorts (YouTube cap is 3 min currently).
  const needShortCheck = niched.filter(v =>
    parseISO8601Duration(v.contentDetails?.duration) <= 200
  );
  const shortFlags = new Map();
  await Promise.all(needShortCheck.map(async v => {
    shortFlags.set(v.id, await isShort(v.id));
  }));
  const notShorts = niched.filter(v => !shortFlags.get(v.id));
  stats.after_shorts = notShorts.length;
  stats.shorts_blocked = niched.length - notShorts.length;

  // 6) Outlier scoring (with per-channel baseline cache)
  const baselineCache = new Map();
  const scored = [];
  for (const v of notShorts) {
    const channelId = v.snippet?.channelId;
    if (!channelId) continue;
    const baseline = await getChannelBaseline(env, channelId, baselineCache);
    const outlier = calculateOutlierScore(v, baseline);
    if (outlier.score < thresholds.min_outlier_score) continue;
    const views = parseInt(v.statistics?.viewCount || '0', 10);
    scored.push({
      id:                v.id,
      title:             v.snippet.title || '',
      channel:           v.snippet.channelTitle || '',
      channelId,
      views:             formatViews(views),
      viewsRaw:          views,
      publishedAt:       v.snippet.publishedAt,
      ageDays:           Math.round(daysSince(v.snippet.publishedAt)),
      durationSeconds:   parseISO8601Duration(v.contentDetails?.duration),
      categoryId:        v.snippet.categoryId,
      outlierScore:      outlier.score,
      outlierConfidence: outlier.confidence,
      baselineVpd:       outlier.baselineVpd,
      baselineN:         outlier.baselineN,
      addedAt:           new Date().toISOString(),
    });
  }
  stats.after_outlier = scored.length;

  // 7) Sort by score desc, cap to N
  scored.sort((a, b) => b.outlierScore - a.outlierScore);
  const capped = scored.slice(0, thresholds.cap_per_run);
  stats.kept = capped.length;
  stats.finished_at = new Date().toISOString();

  return { candidates: capped, stats };
}
