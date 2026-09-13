// lib/realsource.mjs — єдиний гібридний шар реальних даних YouTube.
//
// Дає застосунку однакові функції незалежно від джерела:
//   • "api"   — офіційний YouTube Data API (потрібен ключ, добова квота);
//   • "ytdlp" — локальний yt-dlp (без ключа й без квоти);
//   • "both"  — спершу yt-dlp, якщо не вдалося — API (найнадійніше);
//   • "auto"  — вибрати доступне автоматично (типово);
//   • "off"   — реальні дані вимкнено, працюють лише моделі.
//
// Уся решта застосунку не знає, звідки прийшли дані: форми відповідей
// ідентичні тим, що повертає lib/youtube.mjs.

import * as YT from "./youtube.mjs";
import * as YD from "./ytdlp.mjs";
import * as AN from "./analytics.mjs";

export const MODES = [
  { id: "auto", name: "Автоматично", hint: "yt-dlp, якщо він є; інакше офіційний API" },
  { id: "ytdlp", name: "yt-dlp (без ключа)", hint: "Локальний збір даних, без ключа й без квоти" },
  { id: "api", name: "YouTube API", hint: "Офіційний API, потрібен ключ і добова квота" },
  { id: "both", name: "Гібрид: yt-dlp + API", hint: "yt-dlp як основа, API як запасний шлях" },
  { id: "off", name: "Вимкнено", hint: "Лише міркування моделі, без реальних даних" },
];

export function ytdlpAvailable() {
  return YD.ytdlpInfo().available;
}

export function apiAvailable(cfg) {
  return !!cfg?.youtube?.apiKey;
}

export function sourceMode(cfg) {
  let mode = cfg?.youtube?.mode || "auto";
  // старі збірки писали "on" (просто «увімкнено») — тепер це автоматичний вибір
  if (mode === "on") mode = "auto";
  if (mode !== "auto") return mode;
  if (ytdlpAvailable()) return "ytdlp";
  if (apiAvailable(cfg)) return "api";
  return "off";
}

export function enabled(cfg) {
  return sourceMode(cfg) !== "off";
}

/** Опис активного джерела — для інтерфейсу й звітів. */
export function sourceInfo(cfg) {
  const mode = sourceMode(cfg);
  const info = YD.ytdlpInfo();
  if (!info.version) { try { YD.ytdlpVersion().catch(() => {}); } catch {} }
  return {
    mode,
    modeName: (MODES.find((m) => m.id === mode) || {}).name || mode,
    ytdlp: info.available,
    ytdlpPath: info.path,
    ytdlpVersion: info.version,
    api: apiAvailable(cfg),
    label: mode === "ytdlp" ? "yt-dlp (без ключа)"
      : mode === "api" ? "YouTube API"
      : mode === "both" ? "yt-dlp + API"
      : mode === "off" ? "вимкнено" : mode,
  };
}

function useApiFirst(cfg) {
  const m = sourceMode(cfg);
  return m === "api";
}

// ── допоміжне ─────────────────────────────────────────────────────────────
function isoDuration(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return null;
  const s = Math.round(Number(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return "PT" + (h ? h + "H" : "") + (m ? m + "M" : "") + (r || (!h && !m) ? r + "S" : "");
}
const thumbOf = (id) => (id ? "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg" : null);
const isoDate = (yyyy_mm_dd) => {
  if (!yyyy_mm_dd || String(yyyy_mm_dd).length !== 8) return null;
  const s = String(yyyy_mm_dd);
  return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8) + "T00:00:00Z";
};

function toApiVideo(v) {
  return {
    videoId: v.id,
    title: v.title,
    channelId: v.channelId,
    channelTitle: v.channel,
    publishedAt: isoDate(v.date),
    tags: v.tags || [],
    duration: isoDuration(v.duration),
    durationSec: v.duration ?? null,
    thumbnail: thumbOf(v.id),
    description: "",
    views: v.views || 0,
    likes: v.likes || 0,
    comments: v.comments || 0,
    subs: v.subscribers || 0,
    heatmap: v.heatmap || null,
    source: "ytdlp",
  };
}

// ── розбір посилання на канал ─────────────────────────────────────────────
export function channelUrlFromInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const byId = raw.match(/channel\/(UC[\w-]{20,})/);
  if (byId) return "https://www.youtube.com/channel/" + byId[1] + "/videos";
  if (/^UC[\w-]{20,}$/.test(raw)) return "https://www.youtube.com/channel/" + raw + "/videos";
  const handle = raw.match(/@([A-Za-z0-9_.\-]+)/);
  if (handle) return "https://www.youtube.com/@" + handle[1] + "/videos";
  if (/^youtube\.com\//.test(raw) || /^www\.youtube\.com\//.test(raw)) return "https://" + raw.replace(/^https?:\/\//, "") + "/videos";
  return null;
}

export const uploadsPlaylistToChannelId = (playlistId) =>
  playlistId && /^UU[\w-]{20,}$/.test(playlistId) ? "UC" + playlistId.slice(2) : null;

// ── читання ───────────────────────────────────────────────────────────────
export async function searchVideos(cfg, opts) {
  const { q, maxResults = 20 } = opts || {};
  if (!enabled(cfg)) throw new Error("Реальні дані вимкнені в налаштуваннях.");
  if (useApiFirst(cfg)) return YT.searchVideos(cfg, opts);
  try {
    const res = await YD.searchVideos(q, maxResults);
    return res.videos.map((v) => ({
      videoId: v.id, title: v.title, channelId: v.channelId, channelTitle: v.channel,
      publishedAt: isoDate(v.date), description: "",
    }));
  } catch (e) {
    if (sourceMode(cfg) === "both" && apiAvailable(cfg)) return YT.searchVideos(cfg, opts);
    throw e;
  }
}

export async function getVideos(cfg, ids) {
  if (!enabled(cfg)) return [];
  if (useApiFirst(cfg)) return YT.getVideos(cfg, ids);
  try {
    const det = await YD.videoDetails([...new Set(ids || [])]);
    return det.map(toApiVideo);
  } catch (e) {
    if (sourceMode(cfg) === "both" && apiAvailable(cfg)) return YT.getVideos(cfg, ids);
    throw e;
  }
}

export async function resolveChannel(cfg, input) {
  if (!enabled(cfg)) throw new Error("Реальні дані вимкнені в налаштуваннях.");
  if (useApiFirst(cfg)) return YT.resolveChannel(cfg, input);
  const url = channelUrlFromInput(input) || input;
  try {
    const cat = await YD.channelCatalog(url, { limit: 1 });
    const first = cat.videos[0];
    const info = await YD.channelInfo(url);
    const channelId = info.id || first?.channelId;
    return {
      channelId,
      title: info.name,
      description: info.description || "",
      publishedAt: null,
      country: null,
      subs: info.subscribers || 0,
      views: 0,
      videoCount: info.videoCount || cat.total || 0,
      // вкладки завантажень у yt-dlp немає, але її id виводиться з id каналу
      uploads: channelId ? "UU" + channelId.slice(2) : null,
      keywords: "",
      source: "ytdlp",
    };
  } catch (e) {
    if (sourceMode(cfg) === "both" && apiAvailable(cfg)) return YT.resolveChannel(cfg, input);
    throw e;
  }
}

export async function getChannelStats(cfg, ids) {
  if (!enabled(cfg)) return [];
  if (useApiFirst(cfg)) return YT.getChannelStats(cfg, ids);
  try {
    const out = [];
    for (const id of (ids || []).slice(0, 8)) {
      try {
        const info = await YD.channelInfo("https://www.youtube.com/channel/" + id + "/videos");
        out.push({ channelId: id, title: info.name, publishedAt: null, subs: info.subscribers || 0, views: 0, videoCount: info.videoCount || 0, uploads: "UU" + id.slice(2) });
      } catch { /* канал міг зникнути */ }
    }
    return out;
  } catch (e) {
    if (sourceMode(cfg) === "both" && apiAvailable(cfg)) return YT.getChannelStats(cfg, ids);
    throw e;
  }
}

export async function recentUploads(cfg, uploadsPlaylistId, max = 25) {
  if (!enabled(cfg)) return [];
  if (useApiFirst(cfg)) return YT.recentUploads(cfg, uploadsPlaylistId, max);
  const channelId = uploadsPlaylistToChannelId(uploadsPlaylistId);
  if (!channelId) return [];
  try {
    const cat = await YD.channelCatalog("https://www.youtube.com/channel/" + channelId + "/videos", { limit: max });
    return cat.videos.map((v) => v.id);
  } catch (e) {
    if (sourceMode(cfg) === "both" && apiAvailable(cfg)) return YT.recentUploads(cfg, uploadsPlaylistId, max);
    throw e;
  }
}

/**
 * Медіана переглядів каналу за останніми відео — потрібна, щоб порахувати
 * кратність («у скільки разів відео перевершило звичний рівень каналу»).
 * yt-dlp не віддає сумарні перегляди каналу, тому беремо медіану каталогу.
 */
export async function channelMedianViews(channelUrl, { limit = 30 } = {}) {
  try {
    const cat = await YD.channelCatalog(channelUrl, { limit });
    const views = cat.videos.map((v) => v.views).filter(Number.isFinite);
    if (views.length < 4) return null;
    return { median: AN.median(views), count: views.length };
  } catch { return null; }
}

// ── насиченість ніші ──────────────────────────────────────────────────────
export async function nicheRealityCheck(cfg, keyword, { maxResults = 25 } = {}) {
  if (!enabled(cfg)) throw new Error("Реальні дані вимкнені в налаштуваннях.");
  if (useApiFirst(cfg)) return YT.nicheRealityCheck(cfg, keyword, { maxResults });

  const found = await searchVideos(cfg, { q: keyword, maxResults, order: "relevance" });
  if (!found.length) return { keyword, total: 0, verdict: "Немає результатів — або ніша порожня, або ключ звузький", videos: [], source: "ytdlp" };

  const vids = await getVideos(cfg, found.map((v) => v.videoId));
  const now = Date.now();
  const ageDays = (v) => (v.publishedAt ? Math.max(1, Math.round((now - new Date(v.publishedAt).getTime()) / 86400000)) : null);
  const views = vids.map((v) => v.views).filter(Number.isFinite);
  const med = AN.median(views);

  // статистика каналів: підписники приходять прямо з відео (yt-dlp),
  // сумарні перегляди каналу — недоступні, тому кратність рахуємо за медіаною каталогу
  const chanIds = [...new Set(vids.map((v) => v.channelId).filter(Boolean))];
  const subsFromVideos = new Map();
  for (const v of vids) if (v.channelId && v.subs) subsFromVideos.set(v.channelId, v.subs);
  const chans = chanIds.slice(0, 12).map((id) => ({ channelId: id, subs: subsFromVideos.get(id) || 0, views: 0, videoCount: 0 }));

  const fresh = vids.filter((v) => (ageDays(v) ?? 999) <= 90);
  const smallChannels = vids.filter((v) => {
    const subs = subsFromVideos.get(v.channelId) || 0;
    return subs > 0 && subs < 50000;
  });

  // кратність для найсильніших відео: перегляди ÷ медіана каналу
  const ranked = [...vids].filter((v) => Number.isFinite(v.views)).sort((a, b) => b.views - a.views).slice(0, 8);
  const outliers = [];
  for (const v of ranked) {
    let medCh = null;
    if (v.channelId) medCh = await channelMedianViews("https://www.youtube.com/channel/" + v.channelId + "/videos", { limit: 30 });
    const multiple = medCh && medCh.median ? Math.round((v.views / medCh.median) * 10) / 10 : null;
    if (multiple && multiple >= 2) {
      outliers.push({ ...v, subs: v.subs || 0, channelAvg: medCh ? Math.round(medCh.median) : 0, multiple, ageDays: ageDays(v) });
    }
  }
  outliers.sort((a, b) => (b.multiple || 0) - (a.multiple || 0));

  let recent = [];
  try {
    const recentOrders = await searchVideos(cfg, { q: keyword, maxResults: 10, order: "date" });
    recent = recentOrders.map((v) => ({ title: v.title, publishedAt: v.publishedAt, channelTitle: v.channelTitle, videoId: v.videoId, views: 0 }));
  } catch { /* свіжі відео можуть бути недоступні */ }

  const demandIndex = Math.min(10, Math.round((Math.log10(Math.max(1, med)) / 6) * 10 * 10) / 10);
  const freshness = fresh.length / Math.max(1, vids.length);
  const smallShare = smallChannels.length / Math.max(1, vids.length);
  const saturationIndex = Math.max(0, Math.min(10, Math.round((1 - smallShare) * 10 * 10) / 10));
  const opportunity = Math.max(0, Math.min(10, Math.round((demandIndex * 0.5 + (10 - saturationIndex) * 0.3 + freshness * 10 * 0.2) * 10) / 10));

  return {
    keyword, total: found.length, medianViews: med, meanViews: AN.mean(views),
    freshShare: Math.round(freshness * 100), smallChannelShare: Math.round(smallShare * 100),
    demandIndex, saturationIndex, opportunityIndex: opportunity,
    competition: {
      channels: chans.length,
      bigChannels: chans.filter((c) => c.subs >= 500000).length,
      midChannels: chans.filter((c) => c.subs >= 50000 && c.subs < 500000).length,
      smallChannels: chans.filter((c) => c.subs > 0 && c.subs < 50000).length,
      medianSubs: AN.median(chans.map((c) => c.subs).filter((n) => n > 0)),
    },
    recent,
    outliers,
    videos: vids.slice(0, 25).map((v) => ({ ...v, subs: v.subs || 0, ageDays: ageDays(v) })),
    verdict: opportunity >= 7 ? "Гарне вікно: попит є, а великі канали не домінують." : opportunity >= 5 ? "Робоче вікно — потрібна сильна упаковка." : "Тісно: домінують великі канали.",
    source: "ytdlp",
    note: "Підписники взяті з самих відео; кратність рахується як перегляди ÷ медіана останніх 30 відео каналу.",
  };
}

export async function analyzeChannelReality(cfg, input) {
  if (!enabled(cfg)) throw new Error("Реальні дані вимкнені в налаштуваннях.");
  if (useApiFirst(cfg)) return YT.analyzeChannelReality(cfg, input);

  const url = channelUrlFromInput(input) || input;
  const cat = await YD.channelCatalog(url, { limit: 60 });
  if (!cat.videos.length) throw new Error("Не вдалося зібрати каталог каналу: " + input);

  // точні дати й перегляди для частини відео (решта — приблизні)
  const sample = cat.videos.slice(0, 24);
  let exact = [];
  try { exact = await YD.videoDetails(sample.map((v) => v.id)); } catch { exact = []; }
  const exactMap = new Map(exact.map((v) => [v.id, v]));
  const videos = cat.videos.map((v) => {
    const e = exactMap.get(v.id);
    return e ? { ...v, ...e, views: e.views ?? v.views, date: e.date || v.date, dateExact: true } : v;
  });

  const info = await YD.channelInfo(url).catch(() => ({}));
  const chart = AN.outliers(videos, { hits: 8, flops: 4 });

  const gaps = [];
  const titles = videos.map((v) => v.title);
  if (!titles.some((t) => /vs|проти|порівнян/i.test(t))) gaps.push("Немає порівнянь із конкурентами/альтернативами");
  if (!titles.some((t) => /\d/.test(t))) gaps.push("Заголовки майже без цифр — слабка упаковка");
  const recent10 = videos.slice(0, 10).map((v) => v.views).filter(Number.isFinite);
  const older10 = videos.slice(10, 20).map((v) => v.views).filter(Number.isFinite);
  if (older10.length && AN.median(recent10) < AN.median(older10) * 0.7) gaps.push("Свіжі відео просідають — аудиторія вигорає від формату");

  const ts = AN.titleStats(videos);
  const readers = AN.referenceReadSet(videos, chart);

  return {
    channel: {
      channelId: info.id || videos[0]?.channelId || null,
      title: info.name || videos[0]?.channel || null,
      subs: info.subscribers || videos[0]?.subscribers || 0,
      videoCount: cat.total,
      views: null,
    },
    stats: {
      median: chart.median,
      metric: chart.metric,
      conclusive: chart.conclusive,
      note: chart.note,
      totalVideos: videos.length,
      averageViews: AN.mean(videos.map((v) => v.views).filter(Number.isFinite)),
    },
    hits: chart.hits.slice(0, 8).map((v) => ({ videoId: v.id, title: v.title, views: v.views, multiple: v.xMedian, date: v.date, durationSec: v.duration })),
    flops: chart.flops.map((v) => ({ videoId: v.id, title: v.title, views: v.views, multiple: v.xMedian, date: v.date, durationSec: v.duration })),
    trueOutliers: chart.trueOutliers.map((v) => ({ videoId: v.id, title: v.title, views: v.views, multiple: v.xMedian })),
    titles: ts,
    readSet: readers,
    videos: videos.slice(0, 40).map((v) => ({ videoId: v.id, title: v.title, views: v.views, publishedAt: isoDate(v.date), dateExact: !!v.dateExact, channelTitle: v.channel, subs: v.subscribers || 0, durationSec: v.duration })),
    gaps,
    source: "ytdlp",
  };
}

// ── можливості лише yt-dlp ────────────────────────────────────────────────
export async function transcript(cfg, videoId, lang = "en") {
  return YD.fetchTranscript(videoId, { lang });
}

export async function comments(cfg, videoId, max = 50) {
  return YD.fetchComments(videoId, max);
}

export async function retention(cfg, videoId) {
  const [v] = await YD.videoDetails([videoId]);
  if (!v?.heatmap) return { ok: false, reason: "YouTube не віддав криву утримання для цього відео." };
  return { ok: true, videoId, title: v.title, views: v.views, ...AN.retentionFromHeatmap(v.heatmap) };
}

export async function catalog(cfg, url, { limit = 100 } = {}) {
  return YD.channelCatalog(channelUrlFromInput(url) || url, { limit });
}

export const fetchThumbnails = YT.fetchThumbnails;
