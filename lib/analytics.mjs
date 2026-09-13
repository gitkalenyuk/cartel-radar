// lib/analytics.mjs — аналітика реальних даних YouTube.
// Порт найцінніших алгоритмів із системи «Агент каналу» (harvest.py) на JavaScript.
// Усі функції чисті: жодних мережевих викликів, жодних залежностей.

export const MIN_COMPARISON_VIDEOS = 8; // менше — висновки про хіти/провали нестійкі
export const MIN_DURATION_SEC = 180;    // коротше — це Shorts, не враховуємо
export const MAX_TRANSCRIPT_WPM = 220;  // вище — схоже на збій транскрипту

export const median = (arr) => {
  const a = (arr || []).map(Number).filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
};

export const mean = (arr) => {
  const a = (arr || []).map(Number).filter((n) => Number.isFinite(n));
  return a.length ? Math.round(a.reduce((s, n) => s + n, 0) / a.length) : 0;
};

export function formatNumber(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("uk-UA");
}

export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return "—";
  const s = Math.round(Number(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (x) => String(x).padStart(2, "0");
  return h ? h + ":" + pad(m) + ":" + pad(r) : m + ":" + pad(r);
}

/** Приводить дату (YYYYMMDD або ISO) до ISO-рядка; інакше null. */
export function toIsoDate(date) {
  if (!date) return null;
  const s = String(date);
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8) + "T00:00:00Z";
  const t = new Date(s);
  return Number.isFinite(t.getTime()) ? t.toISOString() : null;
}

/** Скільки днів минуло з дати публікації (формат YYYYMMDD або ISO). */
export function daysSince(date) {
  if (!date) return null;
  let t;
  const s = String(date);
  if (/^\d{8}$/.test(s)) t = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  else t = new Date(s).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(1, Math.round((Date.now() - t) / 86400000));
}

/** Швидкість: переглядів за добу. Це про швидкість набору, а не про якість. */
export function speed(video) {
  const d = daysSince(video?.date);
  if (d == null || video?.views == null) return null;
  return Math.round((video.views / d) * 10) / 10;
}

/**
 * Хіти та провали каналу. Правила, взяті з harvest.py:
 *  • набори хітів і провалів НІКОЛИ не перетинаються — інакше порівнюємо набір сам із собою;
 *  • метрика: швидкість (перегляди/добу), якщо дати надійні; інакше просто перегляди;
 *  • усе рахується відносно медіани каналу (x median);
 *  • справжні викиди — від 3× медіани, і лише коли даних достатньо.
 */
export function outliers(videos, { hits = 6, flops = 3, includeShorts = false } = {}) {
  const pool = (videos || []).filter((v) => v.views != null && (includeShorts || !v.isShort));
  for (const v of pool) v.speed = speed(v);

  const exact = pool.filter((v) => v.dateExact && v.speed != null);
  const withSpeed = pool.filter((v) => v.speed != null);

  let metric;
  let rankedPool = pool;
  if (exact.length === pool.length && pool.length >= 4) {
    metric = "перегляди за добу (усі дати точні)";
  } else if (exact.length >= MIN_COMPARISON_VIDEOS && exact.length >= pool.length * 0.5) {
    // точних дат меншість, але їх достатньо для чесного порівняння швидкостей —
    // рахуємо на точній підвибірці й прямо про це повідомляємо
    rankedPool = exact;
    metric = `перегляди за добу (точна підвибірка: ${exact.length} із ${pool.length} відео)`;
  } else if (withSpeed.length === pool.length && pool.length >= 4) {
    metric = "перегляди за добу (дати приблизні)";
  } else {
    metric = "перегляди (дати ненадійні)";
  }
  const useSpeed = metric.startsWith("перегляди за добу");
  for (const v of rankedPool) v._m = useSpeed ? v.speed : v.views;
  const poolForRanking = rankedPool;
  const conclusive = poolForRanking.length >= MIN_COMPARISON_VIDEOS;

  const notes = [];
  if (!poolForRanking.length) {
    return { metric, median: null, conclusive: false, hits: [], flops: [], trueOutliers: [], note: "Немає придатних відео" };
  }
  if (rankedPool !== pool) notes.push(`швидкість рахується на ${rankedPool.length} відео з точними датами`);

  const med = median(poolForRanking.map((v) => v._m));
  for (const v of poolForRanking) v.xMedian = med ? Math.round((v._m / med) * 100) / 100 : null;

  const ranked = [...poolForRanking].sort((a, b) => b._m - a._m);
  let h = Math.max(0, Math.floor(hits));
  let f = Math.max(0, Math.floor(flops));
  if (h + f > ranked.length) {
    h = Math.max(1, Math.floor((ranked.length + 1) / 2));
    f = Math.max(0, ranked.length - h);
    notes.push(`канал замалий для такого поділу: ${h} хітів / ${f} провалів із ${ranked.length} відео`);
  }
  if (!conclusive) {
    notes.push(`ВИСНОВОК НЕПЕВНИЙ: лише ${poolForRanking.length} придатних відео, потрібно щонайменше ${MIN_COMPARISON_VIDEOS} — рядки нижче описові, не доказові`);
  }

  return {
    metric,
    median: med,
    conclusive,
    hits: ranked.slice(0, h),
    flops: f > 0 ? ranked.slice(ranked.length - f).reverse() : [],
    trueOutliers: conclusive ? ranked.filter((v) => (v.xMedian || 0) >= 3) : [],
    note: notes.join(" | "),
  };
}

/** Статистика заголовків: довжина, повторювані зачини, слова-формули. */
export function titleStats(videos) {
  const titles = (videos || []).map((v) => v.title).filter(Boolean);
  if (!titles.length) return { count: 0, avgWords: 0, formulaWords: [], repeatedOpenings: [] };
  const wordCounts = titles.map((t) => t.trim().split(/\s+/).length);
  const openings = new Map();
  for (const t of titles) {
    const first = (t.trim().split(/\s+/)[0] || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (first.length < 2) continue; // «як», «чому» — короткі, але значущі зачини
    openings.set(first, (openings.get(first) || 0) + 1);
  }
  const repeated = [...openings.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([w, n]) => ({ word: w, count: n }));
  const formula = ["як", "чому", "що", "how", "why", "what", "секрет", "правда", "топ"].filter((w) =>
    titles.some((t) => t.toLowerCase().startsWith(w + " ") || t.toLowerCase().includes(" " + w + " ")));
  return {
    count: titles.length,
    avgWords: Math.round((wordCounts.reduce((s, n) => s + n, 0) / titles.length) * 10) / 10,
    formulaWords: formula,
    repeatedOpenings: repeated.slice(0, 6),
  };
}

/**
 * Чотири відео для глибокого читання: найсильніше, найслабше, типове й свіже.
 * Контраст дає повну картину, а «останні 4» — ні.
 */
export function referenceReadSet(videos, outl, { includeShorts = false } = {}) {
  const pool = (videos || []).filter((v) => v.views != null && (includeShorts || !v.isShort));
  if (!pool.length) return [];
  const chart = outl || outliers(pool);
  const med = chart.median;
  // «типове» порівнюємо ТІЄЮ САМОЮ метрикою, що й рейтинг (швидкість або перегляди),
  // інакше при метриці «перегляди за добу» типовим ставало найменш популярне відео
  const metricOf = (v) => (v._m != null ? v._m : (v.views || 0));
  const byMed = [...pool].sort((a, b) => Math.abs(metricOf(a) - med) - Math.abs(metricOf(b) - med));
  const byDate = [...pool].filter((v) => v.date).sort((a, b) => String(b.date).localeCompare(String(a.date)));

  // Кожна роль бере своє відео: якщо «найсвіжіше» вже використане як найсильніше,
  // беремо наступне найсвіже, щоб читати ЧОТИРИ РІЗНІ відео, а не одне двічі.
  const used = new Set();
  const pick = (list, role, reason) => {
    const v = list.find((x) => x && !used.has(x.id));
    if (!v) return null;
    used.add(v.id);
    return { role, video: v, reason };
  };
  const out = [
    pick(chart.hits, "strongest", "найсильніший результат за метрикою скану"),
    pick(chart.flops, "weakest", "найслабший результат — показує, що не працює"),
    pick(byMed, "typical", "типовий рівень каналу — базовий стандарт"),
    pick(byDate, "recent", "найсвіже — показує поточний напрямок"),
  ];
  return out.filter(Boolean);
}


/**
 * Прибирає прокрутку автозгенерованих субтитрів.
 * YouTube показує той самий рядок кілька разів, доки не додасть нові слова —
 * тому наївна сума слів дає приблизно вдвічі завищений темпоритм.
 * Тут шукаємо перекриття хвоста попереднього рядка з початком наступного
 * і беремо лише нову частину.
 */
export function dedupeRolling(cues) {
  const out = [];
  for (const c of cues || []) {
    const words = String(c.text || "").split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const prev = out[out.length - 1];
    let start = 0;
    if (prev) {
      const prevWords = prev.text.split(/\s+/).filter(Boolean);
      const max = Math.min(prevWords.length, words.length);
      for (let k = max; k > 0; k--) {
        if (prevWords.slice(-k).join(" ") === words.slice(0, k).join(" ")) { start = k; break; }
      }
    }
    const fresh = words.slice(start).join(" ");
    if (!fresh) { if (prev) prev.end = Math.max(prev.end, c.end); continue; }
    out.push({ start: c.start, end: c.end, text: fresh });
  }
  return out;
}

/** Темпоритм мовлення за субтитрами. */
export function measure(cues, durationSec) {
  const list = dedupeRolling((cues || []).filter((c) => c && c.text));
  if (!list.length) return { words: 0, wordsPerMinute: 0, longestPauseSec: 0, pauseCount: 0, avgCueLenSec: 0, warn: null };
  const words = list.reduce((s, c) => s + c.text.trim().split(/\s+/).filter(Boolean).length, 0);
  let longestPause = 0, pauses = 0;
  for (let i = 1; i < list.length; i++) {
    const gap = list[i].start - list[i - 1].end;
    if (gap > longestPause) longestPause = gap;
    if (gap > 1.5) pauses++;
  }
  const span = durationSec || (list[list.length - 1].end - list[0].start) || 1;
  const wpm = Math.round((words / Math.max(1, span)) * 60);
  return {
    words,
    wordsPerMinute: wpm,
    longestPauseSec: Math.round(longestPause * 10) / 10,
    pauseCount: pauses,
    avgCueLenSec: Math.round(((list[list.length - 1].end - list[0].start) / list.length) * 10) / 10,
    warn: wpm > MAX_TRANSCRIPT_WPM ? `темп понад ${MAX_TRANSCRIPT_WPM} слів/хв — перевірте якість транскрипту` : null,
  };
}

/** Чи можна довіряти транскрипту. */
export function transcriptQuality(cues, measured, durationSec) {
  const reasons = [];
  const list = cues || [];
  if (!list.length) return { ok: false, score: 0, reasons: ["субтитрів немає"] };
  const span = (list[list.length - 1].end - list[0].start) || 0;
  const coverage = durationSec ? span / durationSec : 1;
  if (coverage < 0.5) reasons.push(`субтитри покривають лише ${Math.round(coverage * 100)}% тривалості`);
  const words = measured?.words ?? list.reduce((s, c) => s + c.text.split(/\s+/).length, 0);
  if (words < 200) reasons.push("занадто мало слів для аналізу сценарію");
  if (measured?.warn) reasons.push(measured.warn);
  const score = Math.max(0, Math.min(1, Math.round((coverage * 0.6 + Math.min(1, words / 2000) * 0.4) * 100) / 100));
  return { ok: reasons.length === 0, score, reasons };
}

/**
 * Радар свіжих проривів: молоді канали, які щойно вирвалися за межі своєї аудиторії.
 * Фільтри та метрика взяті з harvest.py: вік відео, діапазон підписників,
 * коефіцієнт перегляди ÷ підписники.
 */
export function filterAndRankRadar(candidates, { maxAgeDays = 365, minSubs = 5000, maxSubs = 75000, minDurationSec = 60 } = {}) {
  const kept = [];
  for (const c of candidates || []) {
    if (!c || c.views == null) continue;
    if (c.duration != null && c.duration < minDurationSec) continue;
    const age = daysSince(c.publishedAt);
    if (age != null && age > maxAgeDays) continue;
    const subs = c.subscribers;
    if (subs != null && subs > 0) {
      if (minSubs && subs < minSubs) continue;
      if (maxSubs && subs > maxSubs) continue;
    } else if (minSubs) {
      // підписники приховані: приймаємо лише явно вибухові відео
      if ((c.views || 0) < 50000) continue;
    }
    const velocity = age ? Math.round(c.views / age) : null;
    const outlierRatio = subs && subs > 0 ? Math.round((c.views / subs) * 100) / 100 : null;
    kept.push({ ...c, ageDays: age, velocity, outlierRatio, publishedAt: toIsoDate(c.publishedAt) });
  }

  const breakouts = [...kept].sort((a, b) => (b.outlierRatio || 0) - (a.outlierRatio || 0) || (b.velocity || 0) - (a.velocity || 0));

  const byChannel = new Map();
  for (const v of kept) {
    const key = v.channelId || v.channel || "?";
    const cur = byChannel.get(key) || {
      channel: v.channel || "(без назви)", url: v.channelUrl || null, subscribers: v.subscribers ?? null,
      peakViews: 0, maxVelocity: 0, bestOutlierRatio: null, videosCount: 0,
    };
    cur.videosCount++;
    if ((v.views || 0) > cur.peakViews) cur.peakViews = v.views || 0;
    if ((v.velocity || 0) > cur.maxVelocity) cur.maxVelocity = v.velocity || 0;
    if (v.outlierRatio != null && (cur.bestOutlierRatio == null || v.outlierRatio > cur.bestOutlierRatio)) cur.bestOutlierRatio = v.outlierRatio;
    if (!cur.subscribers && v.subscribers) cur.subscribers = v.subscribers;
    byChannel.set(key, cur);
  }
  const competitors = [...byChannel.values()].sort((a, b) => (b.bestOutlierRatio || 0) - (a.bestOutlierRatio || 0));
  return { breakouts, competitors };
}

/**
 * Крива утримання аудиторії (поле heatmap із yt-dlp).
 * Це офіційна крива YouTube — те, що зазвичай недоступне для чужих каналів.
 */
/**
 * Крива уваги аудиторії (поле heatmap із yt-dlp).
 *
 * ВАЖЛИВО про природу даних: YouTube віддає не абсолютний відсоток утримання,
 * а інтенсивність, нормовану до НАЙВИЩОЇ точки відео (максимум = 1).
 * Тому тут ми не вдаємо «утримання у відсотках» — ми показуємо ФОРМУ:
 * де увага сягає піку, де провалюється відносно піку і наскільки рівно тримається.
 */
export function retentionFromHeatmap(heatmap) {
  const pts = (heatmap || []).filter((p) => Number.isFinite(p?.value) && Number.isFinite(p?.start_time));
  if (pts.length < 5) return { ok: false, reason: "крива уваги недоступна для цього відео" };
  const sorted = [...pts].sort((a, b) => a.start_time - b.start_time);
  const duration = sorted[sorted.length - 1].end_time || sorted[sorted.length - 1].start_time || 1;
  const peak = Math.max(...sorted.map((p) => p.value), 0.0001);
  const at = (sec) => {
    let best = sorted[0];
    for (const p of sorted) if (p.start_time <= sec) best = p;
    return best.value / peak;
  };
  let peakAt = sorted[0];
  for (const p of sorted) if (p.value > peakAt.value) peakAt = p;

  let biggestDrop = null;
  for (let i = 1; i < sorted.length; i++) {
    const drop = (sorted[i - 1].value - sorted[i].value) / peak;
    if (drop > 0 && (!biggestDrop || drop > biggestDrop.drop)) {
      biggestDrop = { fromSec: sorted[i - 1].start_time, toSec: sorted[i].end_time, drop: Math.round(drop * 1000) / 1000 };
    }
  }
  const values = sorted.map((p) => p.value / peak);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  // наскільки рівно тримається увага: 1 — ідеально рівно, 0 — усе стрибає
  const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;
  const steadiness = Math.max(0, Math.min(1, Math.round((1 - Math.sqrt(variance) / Math.max(0.001, avg)) * 100) / 100));

  return {
    ok: true,
    normalized: true,
    basis: "відносна інтенсивність уваги, нормована до піку відео (не відсоток утримання)",
    points: sorted.length,
    durationSec: duration,
    peakAtSec: peakAt.start_time,
    peakAtShare: Math.round((peakAt.start_time / duration) * 100) / 100,
    startVsPeak: Math.round(at(0) * 1000) / 1000,
    midVsPeak: Math.round(at(duration * 0.5) * 1000) / 1000,
    endVsPeak: Math.round(at(duration * 0.98) * 1000) / 1000,
    quarterVsPeak: Math.round(at(duration * 0.25) * 1000) / 1000,
    steadiness,
    biggestDrop,
    // для сумісності зі старим інтерфейсом
    hookRetention: Math.round(at(Math.min(30, duration)) * 1000) / 1000,
    retentionAt25pct: Math.round(at(duration * 0.25) * 1000) / 1000,
    retentionAt50pct: Math.round(at(duration * 0.5) * 1000) / 1000,
    retentionAt75pct: Math.round(at(duration * 0.75) * 1000) / 1000,
    endRetention: Math.round(at(duration * 0.98) * 1000) / 1000,
    avgRetention: Math.round(avg * 1000) / 1000,
    curve: sorted.map((p) => ({ t: Math.round((p.start_time / duration) * 1000) / 1000, value: Math.round((p.value / peak) * 1000) / 1000 })),
  };
}

/**
 * Оцінка «здоров'я» ніші за реальними даними: попит, насиченість, можливість.
 * Формули такі самі, як в основному русі застосунку — щоб оцінки були порівнювані.
 */
export function nicheHealth(videos, channels) {
  const views = (videos || []).map((v) => v.views).filter(Number.isFinite);
  const med = median(views);
  const subs = (channels || []).map((c) => c.subs || 0).filter((n) => n > 0);
  const small = subs.filter((s) => s < 50000).length;
  const smallShare = subs.length ? small / subs.length : 0;
  const demandIndex = Math.min(10, Math.round((Math.log10(Math.max(1, med)) / 6) * 100) / 10);
  const saturationIndex = Math.max(0, Math.min(10, Math.round((1 - smallShare) * 100) / 10));
  const opportunity = Math.max(0, Math.min(10, Math.round((demandIndex * 0.5 + (10 - saturationIndex) * 0.3 + smallShare * 10 * 0.2) * 10) / 10));
  return { medianViews: med, demandIndex, saturationIndex, opportunityIndex: opportunity, smallChannelShare: Math.round(smallShare * 100) };
}
