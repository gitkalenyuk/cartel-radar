// lib/ytdlp.mjs — двигун реальних даних YouTube через локальний yt-dlp.
// Ключа не потрібно, добової квоти немає. Використовується як гібрид разом із
// офіційним YouTube Data API: користувач сам вибирає джерело в налаштуваннях.
//
// Головні принципи:
//  1. Ніколи не падаємо мовчки — кожна відмова має зрозумілу причину українською.
//  2. Усе кешується на диск, щоб повторні запуски не били по YouTube.
//  3. Обмежуємо паралелізм, бо YouTube відповідає 429 при частих запитах.

import { dedupeRolling } from "./analytics.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./config.mjs";

const CACHE_DIR = path.join(DATA_DIR, "cache", "ytdlp");
const BIN_DIRS = ["bin", "resources/bin", "vendor"];
const MAX_PARALLEL = 3;
const DEFAULT_TIMEOUT_MS = 180000;
const ATTEMPTS = 3;

// ── пошук бінарника ───────────────────────────────────────────────────────
let cachedPath;
let cachedVersion;

export function appRoot() {
  // server.mjs лежить у корені застосунку; модуль — у lib/
  // fileURLToPath, а не url.pathname: шлях може містити пробіли й кирилицю
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function ytdlpPath({ refresh = false } = {}) {
  if (cachedPath !== undefined && !refresh) return cachedPath;
  const names = process.platform === "win32" ? ["yt-dlp.exe", "yt-dlp"] : ["yt-dlp", "yt-dlp_macos"];

  if (process.env.NICHE_RADAR_YTDLP && fs.existsSync(process.env.NICHE_RADAR_YTDLP)) {
    cachedPath = process.env.NICHE_RADAR_YTDLP;
    return cachedPath;
  }

  for (const dir of BIN_DIRS) {
    for (const name of names) {
      const p = path.join(appRoot(), dir, name);
      if (fs.existsSync(p)) { cachedPath = p; return cachedPath; }
    }
  }

  const extraDirs = [
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    path.join(os.homedir(), "bin"),
  ];
  const envPath = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of [...extraDirs, ...envPath]) {
    for (const name of names) {
      const p = path.join(dir, name);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) { cachedPath = p; return cachedPath; } } catch {}
    }
  }
  cachedPath = null;
  return null;
}

export function ytdlpInfo() {
  const p = ytdlpPath();
  return { available: !!p, path: p, version: cachedVersion || null, platform: process.platform };
}

// ── обмежувач паралелізму ─────────────────────────────────────────────────
let running = 0;
const queue = [];
function acquire() {
  if (running < MAX_PARALLEL) { running++; return Promise.resolve(); }
  return new Promise((resolve) => queue.push(resolve));
}
function release() {
  running--;
  const next = queue.shift();
  if (next) { running++; next(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── запуск yt-dlp ─────────────────────────────────────────────────────────
export class YtdlpError extends Error {
  constructor(message, { code, rateLimited } = {}) {
    super(message);
    this.name = "YtdlpError";
    this.code = code;
    this.rateLimited = !!rateLimited;
  }
}

function looksRateLimited(text) {
  return /429|Too Many Requests|rate.?limit/i.test(text || "");
}

function lastErrorLine(stderr) {
  const lines = String(stderr || "").split("\n").map((l) => l.replace(/^\s*ERROR:\s*/i, "").trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : "";
}

function explainFailure(stderr, code) {
  const s = String(stderr || "");
  const tail = lastErrorLine(s);
  const withTail = (msg) => (tail ? msg + " Деталі: " + tail : msg);
  if (looksRateLimited(s)) return "YouTube тимчасово обмежив кількість запитів (429). Зачекайте кілька хвилин або виберіть джерело «YouTube API».";
  if (/does not have a videos tab/i.test(s)) return withTail("У цього каналу немає вкладки з відео — перевірте посилання.");
  if (/does not exist|404|not found/i.test(s)) return withTail("Канал або відео не знайдено. Перевірте посилання.");
  if (/Sign in to confirm|not a bot|consent/i.test(s)) return "YouTube просить підтвердити, що запит не від бота. Спробуйте за кілька хвилин.";
  if (/Unable to download webpage|Failed to resolve|getaddrinfo|ENOTFOUND|timed out|Network is unreachable/i.test(s)) return "Немає зв'язку з YouTube. Перевірте інтернет.";
  if (/This video is unavailable|Private video|Video unavailable|members-only/i.test(s)) return "Відео недоступне (приватне, видалене або для учасників).";
  if (/not available in your country|blocked/i.test(s)) return withTail("Відео заблоковане у вашому регіоні.");
  if (/HTTP Error 4\d\d|HTTP Error 5\d\d/i.test(s)) return withTail("YouTube повернув помилку " + (s.match(/HTTP Error \d+/)?.[0] || ""));
  return withTail("yt-dlp завершився з кодом " + code + ".");
}

export async function runYtdlp(args, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = ATTEMPTS } = {}) {
  const bin = ytdlpPath();
  if (!bin) {
    throw new YtdlpError("yt-dlp не знайдено. Встановіть його у теці застосунку (bin/yt-dlp) або виберіть джерело «YouTube API».", { code: "no-binary" });
  }
  await acquire();
  try {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      const res = await new Promise((resolve) => {
        const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { err += d; });
        child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message), timedOut: false }); });
        child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, timedOut }); });
      });

      if (res.code === 0) return res.out;
      lastErr = res;
      const fatal = /This video is unavailable|Private video|Video unavailable|no such file/i.test(res.err || "");
      if (fatal || attempt === retries) break;
      // при 429 чекаємо довше, інакше коротка пауза зі зростанням
      const wait = looksRateLimited(res.err) ? 8000 * attempt : 1200 * attempt * attempt;
      await sleep(wait);
    }
    throw new YtdlpError(
      lastErr?.timedOut
        ? "yt-dlp не встиг завершити за " + Math.round(timeoutMs / 1000) + " с. Спробуйте менший обсяг."
        : explainFailure(lastErr?.err, lastErr?.code),
      { code: lastErr?.code, rateLimited: looksRateLimited(lastErr?.err) },
    );
  } finally {
    release();
  }
}

export async function ytdlpVersion() {
  if (cachedVersion) return cachedVersion;
  if (!ytdlpPath()) return null;
  try {
    const out = await runYtdlp(["--version"], { timeoutMs: 20000, retries: 1 });
    cachedVersion = out.trim().split("\n")[0];
  } catch { cachedVersion = null; }
  return cachedVersion;
}

// ── кеш ───────────────────────────────────────────────────────────────────
function cacheKey(kind, payload) {
  return createHash("sha1").update(kind + "|" + JSON.stringify(payload)).digest("hex").slice(0, 24);
}

function cacheGet(key, ttlMs) {
  try {
    const file = path.join(CACHE_DIR, key + ".json");
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Date.now() - parsed.at > ttlMs) return null;
    return parsed.data;
  } catch { return null; }
}

function cacheSet(key, data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, key + ".json"), JSON.stringify({ at: Date.now(), data }));
  } catch {}
}

export function clearYtdlpCache() {
  try {
    if (fs.existsSync(CACHE_DIR)) {
      let n = 0;
      for (const f of fs.readdirSync(CACHE_DIR)) { fs.unlinkSync(path.join(CACHE_DIR, f)); n++; }
      return n;
    }
  } catch {}
  return 0;
}

export function cacheStats() {
  try {
    const files = fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR) : [];
    let bytes = 0;
    for (const f of files) { try { bytes += fs.statSync(path.join(CACHE_DIR, f)).size; } catch {} }
    return { files: files.length, bytes, dir: CACHE_DIR };
  } catch { return { files: 0, bytes: 0, dir: CACHE_DIR }; }
}

const HOUR = 3600000;
const DAY = 24 * HOUR;

// ── нормалізація відео ────────────────────────────────────────────────────
function normalizeVideo(j) {
  const uploadDate = j.upload_date ? String(j.upload_date)
    : (j.timestamp ? new Date(j.timestamp * 1000).toISOString().slice(0, 10).replace(/-/g, "") : null);
  const duration = j.duration ?? null;
  return {
    id: j.id,
    title: j.title || "(без назви)",
    url: j.webpage_url || ("https://www.youtube.com/watch?v=" + j.id),
    views: j.view_count ?? null,
    likes: j.like_count ?? null,
    comments: j.comment_count ?? null,
    duration,
    isShort: duration != null && duration > 0 && duration <= 60,
    date: uploadDate,
    dateExact: !!j.upload_date,
    channel: j.channel || j.uploader || null,
    channelId: j.channel_id || null,
    subscribers: j.channel_follower_count ?? null,
    channelUrl: j.channel_url || (j.channel_id ? "https://www.youtube.com/channel/" + j.channel_id : null),
    tags: j.tags || [],
    heatmap: Array.isArray(j.heatmap) ? j.heatmap : null,
  };
}

function parseJsonLines(out) {
  const rows = [];
  for (const line of String(out).split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try { rows.push(JSON.parse(t)); } catch {}
  }
  return rows;
}

function channelVideosUrl(url) {
  const u = String(url || "").trim();
  if (!u) return u;
  if (/\/(videos|streams|shorts|playlist)\b/.test(u)) return u;
  return u.replace(/\/+$/, "") + "/videos";
}

// ── каталог каналу (швидкий) ──────────────────────────────────────────────
export async function channelCatalog(url, { limit = 100, includeShorts = false, ttlMs = 6 * HOUR, refresh = false } = {}) {
  const key = cacheKey("catalog", { url, limit, includeShorts });
  if (!refresh) {
    const hit = cacheGet(key, ttlMs);
    if (hit) return { ...hit, cached: true };
  }
  const base = ["--flat-playlist", "--skip-download", "--dump-json", "--ignore-errors", "--no-warnings", "--no-progress", "--playlist-end", String(limit)];
  let out;
  try {
    out = await runYtdlp([...base, channelVideosUrl(url)]);
  } catch (e) {
    // частина каналів не має вкладки /videos (наприклад, лише стріми або лише shorts):
    // пробуємо інші вкладки, перш ніж здатися
    let last = e;
    for (const tab of ["/streams", "/shorts", ""]) {
      try {
        out = await runYtdlp([...base, String(url).replace(/\/+$/, "") + tab]);
        last = null;
        break;
      } catch (err) { last = err; }
    }
    if (last) throw last;
  }
  const rows = parseJsonLines(out).map(normalizeVideo).filter((v) => v.id);
  const videos = includeShorts ? rows : rows.filter((v) => !v.isShort);
  const data = {
    url, videos, total: rows.length,
    shortsFiltered: rows.length - videos.length,
    fetchedAt: Date.now(), cached: false,
  };
  cacheSet(key, data);
  return data;
}

// ── точні дані для вибраних відео ─────────────────────────────────────────
export async function videoDetails(ids, { ttlMs = 6 * HOUR, refresh = false } = {}) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return [];
  const out = [];
  const missing = [];
  for (const id of list) {
    const key = cacheKey("video", { id });
    const hit = refresh ? null : cacheGet(key, ttlMs);
    if (hit) out.push({ ...hit, cached: true });
    else missing.push(id);
  }
  if (missing.length) {
    const urls = missing.map((id) => "https://www.youtube.com/watch?v=" + id);
    const raw = await runYtdlp(["--skip-download", "--dump-json", "--ignore-errors", "--no-warnings", "--no-progress", ...urls]);
    for (const j of parseJsonLines(raw)) {
      const v = normalizeVideo(j);
      cacheSet(cacheKey("video", { id: v.id }), v);
      out.push(v);
    }
  }
  return out;
}

// ── інформація про канал ──────────────────────────────────────────────────
export async function channelInfo(url, { ttlMs = 6 * HOUR, refresh = false } = {}) {
  const key = cacheKey("channel", { url });
  if (!refresh) {
    const hit = cacheGet(key, ttlMs);
    if (hit) return { ...hit, cached: true };
  }
  const out = await runYtdlp([
    "--flat-playlist", "--skip-download", "--dump-json", "--playlist-end", "1",
    "--no-warnings", "--no-progress", channelVideosUrl(url),
  ]);
  const rows = parseJsonLines(out);
  if (!rows.length) throw new YtdlpError("Канал порожній або недоступний: " + url);
  const first = rows[0];
  const data = {
    url: first.channel_url || url,
    name: first.channel || first.uploader || null,
    id: first.channel_id || null,
    subscribers: first.channel_follower_count ?? null,
    videoCount: first.playlist_count ?? null,
    description: first.description || null,
  };
  cacheSet(key, data);
  return data;
}

// ── пошук ─────────────────────────────────────────────────────────────────
export async function searchVideos(query, limit = 10, { ttlMs = HOUR, refresh = false } = {}) {
  const key = cacheKey("search", { query, limit });
  if (!refresh) {
    const hit = cacheGet(key, ttlMs);
    if (hit) return { ...hit, cached: true };
  }
  const out = await runYtdlp([
    "--flat-playlist", "--skip-download", "--dump-json", "--ignore-errors",
    "--no-warnings", "--no-progress", "--playlist-end", String(limit),
    "ytsearch" + limit + ":" + query,
  ]);
  const data = { query, videos: parseJsonLines(out).map(normalizeVideo).filter((v) => v.id), fetchedAt: Date.now() };
  cacheSet(key, data);
  return data;
}

// ── субтитри ──────────────────────────────────────────────────────────────
export function parseVtt(text) {
  const cues = [];
  const blocks = String(text || "").split(/\r?\n\r?\n/);
  let lastText = "";
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const m = timeLine.match(/(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{3})/);
    if (!m) continue;
    const toSec = (h, mm, ss, ms) => (h ? parseInt(h, 10) : 0) * 3600 + parseInt(mm, 10) * 60 + parseInt(ss, 10) + parseInt(ms, 10) / 1000;
    const start = toSec(m[1], m[2], m[3], m[4]);
    const end = toSec(m[5], m[6], m[7], m[8]);
    const textLines = lines.slice(lines.indexOf(timeLine) + 1)
      .map((l) => l.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean);
    const joined = textLines.join(" ").replace(/\s+/g, " ").trim();
    if (!joined) continue;
    // автозгенеровані субтитри прокручуються: рядок часто повторює попередній
    if (joined === lastText) continue;
    if (lastText && joined.startsWith(lastText)) {
      cues.push({ start, end, text: joined.slice(lastText.length).trim() });
      lastText = joined;
      continue;
    }
    cues.push({ start, end, text: joined });
    lastText = joined;
  }
  // прибираємо порожні після обрізання дублів, потім знімаємо прокрутку автозвіту:
  // без цього сума слів виходить приблизно вдвічі більшою, а темпоритм — фальшивим
  return dedupeRolling(cues.filter((c) => c.text.length > 1));
}

export async function fetchTranscript(videoId, { lang = "en", ttlMs = 30 * DAY, refresh = false } = {}) {
  const key = cacheKey("transcript", { videoId, lang });
  if (!refresh) {
    const hit = cacheGet(key, ttlMs);
    if (hit) return { ...hit, cached: true };
  }
  const dir = path.join(CACHE_DIR, "work");
  fs.mkdirSync(dir, { recursive: true });
  const outBase = path.join(dir, videoId + "-" + Date.now());
  try {
    await runYtdlp([
      "--skip-download", "--write-auto-subs", "--write-subs",
      "--sub-langs", lang + ".*," + lang,
      "--sub-format", "vtt", "--no-warnings", "--no-progress",
      "-o", outBase, "https://www.youtube.com/watch?v=" + videoId,
    ], { timeoutMs: 90000, retries: 2 });
  } catch (e) {
    // 429 на субтитрах не має валити весь аналіз
    if (!e.rateLimited) throw e;
  }
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(path.basename(outBase)) && f.endsWith(".vtt")) : [];
  if (!files.length) {
    const data = { videoId, lang, available: false, cueCount: 0, cues: [], note: "Субтитри для цього відео недоступні." };
    cacheSet(key, data);
    return data;
  }
  // віддаємо перевагу «origin» (ручні) над автозгенерованими варіантами з перекладом
  files.sort((a, b) => (a.includes("-orig.") ? -1 : 0) - (b.includes("-orig.") ? -1 : 0));
  const raw = fs.readFileSync(path.join(dir, files[0]), "utf8");
  const cues = parseVtt(raw);
  for (const f of files) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  const data = { videoId, lang, available: cues.length > 0, cueCount: cues.length, cues, file: files[0] };
  cacheSet(key, data);
  return data;
}

// ── коментарі ─────────────────────────────────────────────────────────────
export async function fetchComments(videoId, max = 50, { ttlMs = 12 * HOUR, refresh = false } = {}) {
  const key = cacheKey("comments", { videoId, max });
  if (!refresh) {
    const hit = cacheGet(key, ttlMs);
    if (hit) return { ...hit, cached: true };
  }
  const out = await runYtdlp([
    "--skip-download", "--write-comments", "--extractor-args",
    "youtube:max_comments=" + max + ",all,0,0", "--dump-json",
    "--no-warnings", "--no-progress", "https://www.youtube.com/watch?v=" + videoId,
  ], { timeoutMs: 120000, retries: 2 });
  const rows = parseJsonLines(out);
  const j = rows[0] || {};
  const comments = (j.comments || []).slice(0, max).map((c) => ({
    text: c.text || "",
    likes: c.like_count ?? 0,
    author: c.author || null,
    isReply: !!c.parent,
  })).filter((c) => c.text);
  const data = { videoId, comments, count: comments.length, total: j.comment_count ?? null };
  cacheSet(key, data);
  return data;
}

// ── оновлення самого yt-dlp ───────────────────────────────────────────────
export async function selfUpdate() {
  const bin = ytdlpPath();
  if (!bin) throw new YtdlpError("yt-dlp не знайдено — оновлювати нічого.");
  const out = await runYtdlp(["-U"], { timeoutMs: 180000, retries: 1 });
  cachedVersion = null;
  return { ok: true, output: out.trim().slice(-800) };
}
