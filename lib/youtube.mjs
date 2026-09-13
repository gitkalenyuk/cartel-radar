// lib/youtube.mjs — YouTube Data API v3 (опційно; без ключа повертає null і UI працює в LLM-режимі)
const API = "https://www.googleapis.com/youtube/v3";

export const QUOTA_COST = { search: 100, videos: 1, channels: 1, playlistItems: 1 };

const quota = { used: 0, day: new Date().toISOString().slice(0, 10) };
export function quotaState() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== quota.day) { quota.day = today; quota.used = 0; }
  return { used: quota.used, day: quota.day, dailyLimit: 10000, remaining: Math.max(0, 10000 - quota.used) };
}

export function ytEnabled(cfg) { return cfg?.youtube?.mode !== "off" && !!cfg?.youtube?.apiKey; }

async function call(cfg, endpoint, params, costKey) {
  const st = quotaState();
  if (st.remaining < (QUOTA_COST[costKey] || 1)) throw new Error("Денна квота YouTube Data API вичерпана (10000 юнітів)");
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  url.searchParams.set("key", cfg.youtube.apiKey);
  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
  quota.used += (QUOTA_COST[costKey] || 1);
  if (!resp.ok) {
    const body = await resp.text();
    let msg = `YouTube API HTTP ${resp.status}`;
    try { const j = JSON.parse(body); if (j.error?.message) msg += ": " + j.error.message; } catch {}
    throw new Error(msg);
  }
  return resp.json();
}

export const median = (arr) => {
  const a = (arr || []).filter((n) => typeof n === "number" && isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
};

export const mean = (arr) => { const a = (arr || []).filter(Number.isFinite); return a.length ? Math.round(a.reduce((s, n) => s + n, 0) / a.length) : 0; };

export async function searchVideos(cfg, { q, maxResults = 20, order = "relevance", publishedAfter = null, regionCode = null, relevanceLanguage = null }) {
  const data = await call(cfg, "search", {
    part: "snippet", type: "video", q, maxResults: Math.min(50, maxResults), order,
    publishedAfter, regionCode: regionCode || cfg.youtube.region, relevanceLanguage: relevanceLanguage || cfg.youtube.hl,
  }, "search");
  return (data.items || []).map((it) => ({
    videoId: it.id.videoId, title: it.snippet.title, channelId: it.snippet.channelId,
    channelTitle: it.snippet.channelTitle, publishedAt: it.snippet.publishedAt, description: it.snippet.description,
  }));
}

export async function searchChannels(cfg, { q, maxResults = 20, regionCode = null, relevanceLanguage = null }) {
  const data = await call(cfg, "search", {
    part: "snippet", type: "channel", q, maxResults: Math.min(50, maxResults),
    regionCode: regionCode || cfg.youtube.region, relevanceLanguage: relevanceLanguage || cfg.youtube.hl,
  }, "search");
  return (data.items || []).map((it) => ({ channelId: it.id.channelId, title: it.snippet.title, description: it.snippet.description }));
}

export async function getVideos(cfg, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const data = await call(cfg, "videos", { part: "snippet,statistics,contentDetails", id: chunk.join(",") }, "videos");
    for (const it of data.items || []) {
      out.push({
        videoId: it.id, title: it.snippet.title, channelId: it.snippet.channelId, channelTitle: it.snippet.channelTitle,
        publishedAt: it.snippet.publishedAt, tags: it.snippet.tags || [], duration: it.contentDetails?.duration,
        thumbnail: it.snippet.thumbnails?.maxres?.url || it.snippet.thumbnails?.high?.url || it.snippet.thumbnails?.medium?.url || null,
        description: (it.snippet.description || "").slice(0, 400),
        views: Number(it.statistics?.viewCount || 0), likes: Number(it.statistics?.likeCount || 0),
        comments: Number(it.statistics?.commentCount || 0),
      });
    }
  }
  return out;
}

export async function resolveChannel(cfg, input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Порожній запит каналу");
  const byId = raw.match(/channel\/(UC[\w-]{20,})/);
  if (byId) return { channelId: byId[1] };
  const isId = /^UC[\w-]{20,}$/.test(raw);
  if (isId) return { channelId: raw };
  const handleMatch = raw.match(/@([A-Za-z0-9_.\-]+)/);
  const handle = handleMatch ? handleMatch[1] : (raw.startsWith("@") ? raw.slice(1) : null);
  const params = { part: "snippet,statistics,contentDetails,brandingSettings", maxResults: 1 };
  if (handle) params.forHandle = handle; else params.forUsername = raw.replace(/^.*youtube\.com\//, "").replace(/\/.*$/, "");
  const data = await call(cfg, "channels", params, "channels");
  const it = (data.items || [])[0];
  if (!it) throw new Error(`Канал не знайдено: ${raw}`);
  return {
    channelId: it.id, title: it.snippet.title, description: it.snippet.description,
    publishedAt: it.snippet.publishedAt, country: it.snippet.country,
    subs: Number(it.statistics?.subscriberCount || 0), views: Number(it.statistics?.viewCount || 0),
    videoCount: Number(it.statistics?.videoCount || 0),
    uploads: it.contentDetails?.relatedPlaylists?.uploads,
    keywords: it.brandingSettings?.channel?.keywords || "",
  };
}

export async function getChannelStats(cfg, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await call(cfg, "channels", { part: "snippet,statistics,contentDetails", id: ids.slice(i, i + 50).join(",") }, "channels");
    for (const it of data.items || []) {
      out.push({
        channelId: it.id, title: it.snippet.title, publishedAt: it.snippet.publishedAt,
        subs: Number(it.statistics?.subscriberCount || 0), views: Number(it.statistics?.viewCount || 0),
        videoCount: Number(it.statistics?.videoCount || 0), uploads: it.contentDetails?.relatedPlaylists?.uploads,
      });
    }
  }
  return out;
}

export async function recentUploads(cfg, uploadsPlaylistId, max = 25) {
  const data = await call(cfg, "playlistItems", { part: "contentDetails", playlistId: uploadsPlaylistId, maxResults: Math.min(50, max) }, "playlistItems");
  return (data.items || []).map((it) => it.contentDetails?.videoId).filter(Boolean);
}

/**
 * Насиченість ніші за реальними даними: скільки грають, які перегляди, свіжість, чи є вибухові відео.
 */
export async function nicheRealityCheck(cfg, keyword, { maxResults = 25 } = {}) {
  const found = await searchVideos(cfg, { q: keyword, maxResults, order: "relevance" });
  if (!found.length) return { keyword, total: 0, verdict: "Немає результатів — або ніша порожня, або ключ звузький", videos: [] };
  const vids = await getVideos(cfg, found.map((v) => v.videoId));
  const now = Date.now();
  const ageDays = (v) => Math.max(1, Math.round((now - new Date(v.publishedAt).getTime()) / 86400000));
  const views = vids.map((v) => v.views);
  const med = median(views);
  const chans = await getChannelStats(cfg, [...new Set(vids.map((v) => v.channelId))].slice(0, 50));
  const chanMap = new Map(chans.map((c) => [c.channelId, c]));
  const fresh = vids.filter((v) => ageDays(v) <= 90);
  const recentOrders = await searchVideos(cfg, { q: keyword, maxResults: 10, order: "date" });
  const recentVids = recentOrders.length ? await getVideos(cfg, recentOrders.map((v) => v.videoId)) : [];
  const smallChannels = vids.filter((v) => (chanMap.get(v.channelId)?.subs || 0) > 0 && (chanMap.get(v.channelId)?.subs || 0) < 50000);
  const outliers = vids
    .map((v) => {
      const ch = chanMap.get(v.channelId);
      const perVideo = ch && ch.videoCount ? ch.views / ch.videoCount : 0;
      return { ...v, subs: ch?.subs || 0, channelAvg: Math.round(perVideo), multiple: perVideo ? Math.round((v.views / perVideo) * 10) / 10 : null, ageDays: ageDays(v) };
    })
    .filter((v) => v.multiple && v.multiple >= 2)
    .sort((a, b) => (b.multiple || 0) - (a.multiple || 0))
    .slice(0, 8);

  const demandIndex = Math.min(10, Math.round((Math.log10(Math.max(1, med)) / 6) * 10 * 10) / 10);
  const freshness = fresh.length / vids.length;
  const smallShare = smallChannels.length / Math.max(1, vids.length);
  const saturationIndex = Math.max(0, Math.min(10, Math.round((1 - smallShare) * 10 * 10) / 10));
  const opportunity = Math.max(0, Math.min(10, Math.round((demandIndex * 0.5 + (10 - saturationIndex) * 0.3 + freshness * 10 * 0.2) * 10) / 10));

  return {
    keyword, total: found.length, medianViews: med, meanViews: mean(views),
    freshShare: Math.round(freshness * 100), smallChannelShare: Math.round(smallShare * 100),
    demandIndex, saturationIndex, opportunityIndex: opportunity,
    competition: {
      channels: chans.length,
      bigChannels: chans.filter((c) => c.subs >= 500000).length,
      midChannels: chans.filter((c) => c.subs >= 50000 && c.subs < 500000).length,
      smallChannels: chans.filter((c) => c.subs < 50000).length,
      medianSubs: median(chans.map((c) => c.subs)),
    },
    recent: recentVids.slice(0, 10).map((v) => ({ title: v.title, views: v.views, publishedAt: v.publishedAt, channelTitle: v.channelTitle, videoId: v.videoId })),
    outliers,
    videos: vids.slice(0, 25).map((v) => ({ ...v, subs: chanMap.get(v.channelId)?.subs || 0, ageDays: ageDays(v) })),
    verdict: opportunity >= 7 ? "Гарне вікно: попит є, а великі канали не домінують." : opportunity >= 5 ? "Робоче вікно — потрібна сильна упаковка." : "Тісно: домінують великі канали.",
  };
}

/** Завантажує прев'ю і повертає base64-блоки для vision-моделі. */
export async function fetchThumbnails(urls, limit = 4) {
  const out = [];
  for (const url of urls.filter(Boolean).slice(0, limit)) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) continue;
      const mimeType = r.headers.get("content-type") || "image/jpeg";
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 4 * 1024 * 1024) continue;
      out.push({ url, mimeType: mimeType.split(";")[0], base64: buf.toString("base64") });
    } catch { /* пропускаємо недоступне прев'ю */ }
  }
  return out;
}

export async function analyzeChannelReality(cfg, input) {
  const ch = await resolveChannel(cfg, input);
  const ids = ch.uploads ? await recentUploads(cfg, ch.uploads, 50) : [];
  const vids = ids.length ? await getVideos(cfg, ids) : [];
  const views = vids.map((v) => v.views);
  const med = median(views);
  const sorted = [...vids].sort((a, b) => b.views - a.views);
  const gaps = [];
  const titles = vids.map((v) => v.title);
  if (!titles.some((t) => /vs|проти|порівнян/i.test(t))) gaps.push("Немає порівнянь із конкурентами/альтернативами");
  if (!titles.some((t) => /\d/.test(t))) gaps.push("Заголовки майже без цифр — слабка упаковка");
  if (vids.length && med > 0) {
    const recent10 = vids.slice(0, 10).map((v) => v.views);
    const older10 = vids.slice(10, 20).map((v) => v.views);
    if (older10.length && median(recent10) < median(older10) * 0.7) gaps.push("Свіжі відео просідають — аудиторія вигорає від формату");
  }
  if (!titles.some((t) => /^(як|how|чому|why)/i.test(t))) gaps.push("Мало instructional-контенту (як/чому) — слабкий пошуковий трафік");
  const countByMonth = {};
  for (const v of vids) { const k = v.publishedAt.slice(0, 7); countByMonth[k] = (countByMonth[k] || 0) + 1; }
  return {
    channel: ch,
    stats: { medianViews: med, meanViews: mean(views), sampleSize: vids.length, top10Avg: mean(sorted.slice(0, 10).map((v) => v.views)) },
    outliers: sorted.slice(0, 8).map((v) => ({ title: v.title, views: v.views, multiple: med ? Math.round((v.views / med) * 10) / 10 : null, videoId: v.videoId, publishedAt: v.publishedAt })),
    uploadsByMonth: countByMonth,
    recentVideos: vids.slice(0, 30).map((v) => ({ title: v.title, views: v.views, likes: v.likes, comments: v.comments, publishedAt: v.publishedAt, videoId: v.videoId, thumbnail: v.thumbnail })),
    topThumbnails: sorted.slice(0, 6).map((v) => ({ title: v.title, views: v.views, videoId: v.videoId, thumbnail: v.thumbnail })),
    gaps,
  };
}
