// server.mjs — локальний сервер Cartel Radar: статика, API, стрім подій, життєвий цикл
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, patchConfig, defaultConfig, ensureDataDir, migrateLegacyData, DATA_DIR } from "./lib/config.mjs";
import { listProviders, resolveProvider, PROVIDER_PRESETS } from "./lib/providers.mjs";
import { testProvider, listModels, pickDefaultModel } from "./lib/llm.mjs";
import { createJob, getJob, listJobs, subscribe, finishJob, failJob, cancelJob, pool } from "./lib/jobs.mjs";
import { runHunt, runChannelAnalysis, runGapScan, runVideoLab, runThumbnailLab } from "./lib/engine.mjs";
import { listNiches, addNiche, updateNiche, deleteNiche, listRuns, getRun, toMarkdown, toCSV } from "./lib/store.mjs";
import { quotaState } from "./lib/youtube.mjs";
import * as REALS from "./lib/realsource.mjs";
import * as YD from "./lib/ytdlp.mjs";
import * as AN from "./lib/analytics.mjs";
import * as MOD from "./lib/modules.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const DOCS = path.join(__dirname, "docs");
const HOST = "127.0.0.1";

// Версію беремо з package.json, а не пишемо руками: інакше вона розходиться
// з тим, що фактично зібрано (саме так і сталося між 1.0.0 і 1.0.1).
const VERSION = await (async () => {
  try {
    return JSON.parse(await fs.readFile(path.join(__dirname, "package.json"), "utf8")).version || "0.0.0";
  } catch { return "0.0.0"; }
})();

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2", ".md": "text/markdown; charset=utf-8",
};

function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(payload);
}

const sendErr = (res, status, msg, extra = {}) => send(res, status, { error: String(msg && msg.message ? msg.message : msg), ...extra });
const safeErr = (res, e) => send(res, 400, { error: String(e?.message || e) });

async function readBody(req, limit = 60 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("Тіло запиту завелике");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); } catch { throw new Error("Некоректний JSON у тілі запиту"); }
}

const RUNNERS = {
  hunt: runHunt,
  channel: runChannelAnalysis,
  gap: runGapScan,
  video: runVideoLab,
  thumbs: runThumbnailLab,
};

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || HOST}`);
    const p = url.pathname;
    if (process.env.CARTEL_RADAR_LOG || process.env.NICHE_RADAR_LOG) console.log(new Date().toISOString().slice(11, 19), req.method, p);
    try {
      // Захист від DNS-rebinding: приймаємо лише локальні хости
      const host = String(req.headers.host || "").split(":")[0];
      if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) return sendErr(res, 403, "Доступ лише з локального хоста");

      // ---------------- API ----------------
      if (p === "/api/health") return send(res, 200, { ok: true, name: "Cartel Radar", version: VERSION, pid: process.pid, uptime: Math.round(process.uptime()) });

      if (p === "/api/config" && req.method === "GET") return send(res, 200, { config: await loadConfig(), presets: PROVIDER_PRESETS });
      if (p === "/api/config" && req.method === "POST") {
        const body = await readBody(req);
        const cfg = await patchConfig(body || {});
        return send(res, 200, { ok: true, config: cfg });
      }
      if (p === "/api/config/reset" && req.method === "POST") {
        const cfg = await patchConfig(defaultConfig());
        return send(res, 200, { ok: true, config: cfg });
      }

      if (p === "/api/providers" && req.method === "GET") {
        const cfg = await loadConfig();
        return send(res, 200, { providers: listProviders(cfg), count: PROVIDER_PRESETS.length });
      }
      if (p === "/api/providers/save" && req.method === "POST") {
        const body = await readBody(req);
        if (!body?.id) return sendErr(res, 400, "Не вказано id провайдера");
        const cfg = await loadConfig();
        if (body.custom && !cfg.customProviders.some((c) => c.id === body.id)) {
          cfg.customProviders.push({
            id: body.id, name: body.name || body.id, category: body.category || "Свої",
            apiStyle: body.apiStyle || "openai", baseURL: body.baseURL || "", authStyle: body.authStyle || "bearer",
            keyRequired: body.keyRequired !== false, keyUrl: body.keyUrl || "", docs: body.docs || "",
            models: body.models || [], notes: body.notes || "Власний провайдер", custom: true,
            extraHeaders: body.extraHeaders || {},
          });
        }
        cfg.providers[body.id] = { ...(cfg.providers[body.id] || {}), ...(body.settings || {}), savedAt: Date.now() };
        const { patchConfig: _pc } = await import("./lib/config.mjs");
        const saved = await _pc(cfg);
        return send(res, 200, { ok: true, config: saved });
      }
      if (p === "/api/providers/delete" && req.method === "POST") {
        const body = await readBody(req);
        const cfg = await loadConfig();
        cfg.customProviders = (cfg.customProviders || []).filter((c) => c.id !== body.id);
        delete cfg.providers[body.id];
        return send(res, 200, { ok: true, config: await patchConfig(cfg) });
      }
      if (p === "/api/providers/test" && req.method === "POST") {
        const body = await readBody(req);
        try {
          const result = await testProvider(await loadConfig(), body.id);
          await patchConfig({ providers: { [body.id]: { testOk: true, testedAt: Date.now() } } });
          return send(res, 200, result);
        } catch (e) {
          // запам'ятовуємо збій, щоб автовибір не брав провайдера, який не працює
          await patchConfig({ providers: { [body.id]: { testOk: false, testedAt: Date.now(), testError: String(e.message || e).slice(0, 200) } } }).catch(() => {});
          return send(res, 200, { ok: false, error: String(e.message || e) });
        }
      }
      if (p === "/api/providers/models" && req.method === "POST") {
        const body = await readBody(req);
        try {
          const models = await listModels(await loadConfig(), body.id);
          return send(res, 200, { ok: true, models, defaultModel: pickDefaultModel(models) });
        }
        catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
      }

      if (p === "/api/runs" && req.method === "POST") {
        const body = await readBody(req);
        const type = body.type || "hunt";
        const runner = RUNNERS[type];
        if (!runner) return sendErr(res, 400, `Невідомий тип запуску: ${type}`);
        const cfg = await loadConfig();
        const job = createJob(type, body.params || {});
        job.emit({ t: "start", type, at: job.createdAt, provider: body.params?.provider || cfg.routing?.["discovery"]?.provider || "auto" });
        (async () => {
          try { await finishJob(job, await runner(cfg, body.params || {}, job)); }
          catch (e) { await failJob(job, e); }
        })();
        return send(res, 200, { ok: true, jobId: job.id });
      }
      if (p === "/api/runs" && req.method === "GET") return send(res, 200, { running: listJobs(), history: await listRuns() });
      const cancelMatch = p.match(/^\/api\/runs\/([\w-]+)\/cancel$/);
      if (cancelMatch && req.method === "POST") return send(res, 200, { ok: cancelJob(cancelMatch[1]) });
      const eventsMatch = p.match(/^\/api\/runs\/([\w-]+)\/events$/);
      if (eventsMatch && req.method === "GET") {
        const job = getJob(eventsMatch[1]);
        if (!job) return sendErr(res, 404, "Запуск не знайдено");
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive", "X-Accel-Buffering": "no",
        });
        res.write(`: connected ${job.id}\n\n`);
        const write = (ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {} };
        const { buffered, unsubscribe } = subscribe(job, url.searchParams.get("from"), write);
        for (const ev of buffered) write(ev);
        if (job.status !== "running") { write({ t: "end", status: job.status, stats: job.stats, replay: true }); res.end(); return; }
        const keepAlive = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15000);
        req.on("close", () => { clearInterval(keepAlive); unsubscribe(); try { res.end(); } catch {} });
        return;
      }
      const runMatch = p.match(/^\/api\/runs\/([\w-]+)$/);
      if (runMatch && req.method === "GET") {
        const job = getJob(runMatch[1]);
        if (job) return send(res, 200, { job: { id: job.id, type: job.type, status: job.status, stats: job.stats, result: job.result, error: job.error, createdAt: job.createdAt } });
        const saved = await getRun(runMatch[1]);
        return saved ? send(res, 200, { job: saved, saved: true }) : sendErr(res, 404, "Не знайдено");
      }

      if (p === "/api/niches" && req.method === "GET") return send(res, 200, { niches: await listNiches() });
      if (p === "/api/niches" && req.method === "POST") return send(res, 200, await addNiche(await readBody(req)));
      const nicheMatch = p.match(/^\/api\/niches\/([\w-]+)$/);
      if (nicheMatch && req.method === "PATCH") return send(res, 200, { niche: await updateNiche(nicheMatch[1], await readBody(req)) });
      if (nicheMatch && req.method === "DELETE") return send(res, 200, await deleteNiche(nicheMatch[1]));

      if (p === "/api/export" && req.method === "GET") {
        const format = (url.searchParams.get("format") || "md").toLowerCase();
        const niches = await listNiches();
        const stamp = new Date().toISOString().slice(0, 10);
        if (format === "csv") return send(res, 200, "\uFEFF" + toCSV(niches), "text/csv; charset=utf-8", { "Content-Disposition": `attachment; filename="niche-radar-${stamp}.csv"` });
        if (format === "json") return send(res, 200, JSON.stringify({ exportedAt: Date.now(), niches }, null, 2), "application/json; charset=utf-8", { "Content-Disposition": `attachment; filename="niche-radar-${stamp}.json"` });
        return send(res, 200, toMarkdown(niches), "text/markdown; charset=utf-8", { "Content-Disposition": `attachment; filename="niche-radar-${stamp}.md"` });
      }
      if (p === "/api/youtube/quota" && req.method === "GET") {
        const cfg = await loadConfig();
        return send(res, 200, { ...quotaState(), enabled: cfg.youtube?.mode !== "off" && !!cfg.youtube?.apiKey });
      }

      // ---------------- джерела реальних даних ----------------
      if (p === "/api/sources" && req.method === "GET") {
        const cfg = await loadConfig();
        const info = REALS.sourceInfo(cfg);
        return send(res, 200, {
          ...info,
          modes: REALS.MODES,
          cache: YD.cacheStats(),
          quota: quotaState(),
          // якщо yt-dlp не знайдено — показуємо, де саме ми його шукали,
          // щоб причину було видно одразу, а не вгадувати
          ytdlpSearched: info.ytdlp ? undefined : YD.searchedBinPaths(),
          ytdlpDownloadURL: YD.ytdlpDownloadURL(),
        });
      }

      // запасний шлях: якщо yt-dlp не знайшовся (невдале завантаження під час
      // встановлення, антивірус, нова система) — тягнемо його самі
      if (p === "/api/sources/install-ytdlp" && req.method === "POST") {
        try {
          const result = await YD.installYtdlp();
          console.log("  yt-dlp завантажено:", result.path, result.version || "");
          return send(res, 200, { ok: true, ...result });
        } catch (e) {
          return send(res, 200, { ok: false, error: String(e.message || e) });
        }
      }

      // ── модульні оновлення ──────────────────────────────────────────────
      // Застосунок складається з модулів, і кожен можна оновити окремо, не
      // перевстановлюючи програму на 100 МБ.
      if (p === "/api/update/check" && (req.method === "GET" || req.method === "POST")) {
        try { return send(res, 200, await MOD.checkUpdates()); }
        catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
      }

      if (p === "/api/update/apply" && req.method === "POST") {
        try {
          const body = await readBody(req);
          if (body?.all) {
            // «оновити все застаріле» — самі рахуємо, що саме застаріло
            const st = await MOD.checkUpdates();
            const files = st.groups.flatMap((g) => g.files.filter((f) => f.status !== "current").map((f) => f.file));
            const out = await MOD.applyUpdates(files, { tag: st.release.tag });
            console.log(`  оновлено модулів: ${out.updated} (з ${files.length})`);
            return send(res, 200, out);
          }
          const out = await MOD.applyUpdates(body?.files, { tag: body?.tag });
          console.log(`  оновлено модулів: ${out.updated} (з ${(body?.files || []).length})`);
          return send(res, 200, out);
        } catch (e) {
          return send(res, 200, { ok: false, error: String(e.message || e) });
        }
      }

      if (p === "/api/update/state" && req.method === "GET") {
        return send(res, 200, { ok: true, state: await MOD.readUpdateState(), writable: await MOD.appDirWritable() });
      }

      if (p === "/api/sources/update" && req.method === "POST") {
        try { return send(res, 200, await YD.selfUpdate()); }
        catch (e) { return send(res, 200, { ok: false, error: String(e.message || e) }); }
      }

      if (p === "/api/sources/clear-cache" && req.method === "POST") {
        const removed = YD.clearYtdlpCache();
        return send(res, 200, { ok: true, removed, cache: YD.cacheStats() });
      }

      if (p === "/api/sources/mode" && req.method === "POST") {
        const body = await readBody(req);
        const allowed = REALS.MODES.map((m) => m.id);
        if (!allowed.includes(body.mode)) return sendErr(res, 400, "Невідомий режим джерела");
        const cfg = await patchConfig({ youtube: { mode: body.mode } });
        return send(res, 200, { ok: true, mode: cfg.youtube.mode, info: REALS.sourceInfo(cfg) });
      }

      // ---------------- прямі запити до yt-dlp ----------------
      if (p === "/api/yt/catalog" && req.method === "POST") {
        const body = await readBody(req);
        const cfg = await loadConfig();
        try {
          const cat = await REALS.catalog(cfg, body.url, { limit: Math.min(500, Number(body.limit) || 50) });
          // Плоский список не має дат, а без них не порахувати швидкість набору.
          // Тому уточнюємо точні дані для вибірки: найпопулярніші, найсвіжіші та середина.
          const exactTargets = (body.exact === false) ? [] : (() => {
            const byViews = [...cat.videos].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 10);
            const tail = cat.videos.slice(-6);
            const middle = cat.videos.slice(Math.floor(cat.videos.length / 2) - 3, Math.floor(cat.videos.length / 2) + 3);
            return [...new Set([...byViews, ...tail, ...middle].map((v) => v.id))].slice(0, Math.min(22, Number(body.exactCount) || 18));
          })();
          if (exactTargets.length) {
            try {
              const det = await YD.videoDetails(exactTargets);
              const map = new Map(det.map((d) => [d.id, d]));
              cat.videos = cat.videos.map((v) => {
                const d = map.get(v.id);
                return d ? { ...v, views: d.views ?? v.views, date: d.date, dateExact: !!d.date, likes: d.likes, comments: d.comments, duration: d.duration ?? v.duration, subscribers: d.subscribers ?? v.subscribers } : v;
              });
              cat.exactCount = det.length;
            } catch (e) { cat.exactError = String(e.message || e); }
          }
          const chart = AN.outliers(cat.videos, { hits: 8, flops: 4 });
          return send(res, 200, {
            ...cat,
            chart: {
              metric: chart.metric, median: chart.median, conclusive: chart.conclusive, note: chart.note,
              hits: chart.hits.map((v) => ({ videoId: v.id, title: v.title, views: v.views, multiple: v.xMedian, date: v.date, durationSec: v.duration })),
              flops: chart.flops.map((v) => ({ videoId: v.id, title: v.title, views: v.views, multiple: v.xMedian, date: v.date, durationSec: v.duration })),
              trueOutliers: chart.trueOutliers.map((v) => ({ videoId: v.id, title: v.title, multiple: v.xMedian, views: v.views })),
            },
            titles: AN.titleStats(cat.videos),
            readSet: AN.referenceReadSet(cat.videos, chart),
          });
        } catch (e) { return sendErr(res, 200, String(e.message || e)); }
      }

      if (p === "/api/yt/video" && req.method === "POST") {
        const body = await readBody(req);
        const cfg = await loadConfig();
        // Приймаємо і videoId, і повне посилання — інтерфейс надсилає те, що вставив користувач
        const id = String(body.videoId || "").trim() || String(body.url || "").match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/)?.[1] || "";
        if (!id) return sendErr(res, 400, "Не вказано посилання або videoId");
        try {
          const [details] = await YD.videoDetails([id]);
          if (!details) return sendErr(res, 404, "Відео не знайдено");
          const out = { video: details, retention: null, transcript: null, comments: null };
          if (details.heatmap) out.retention = AN.retentionFromHeatmap(details.heatmap);
          if (body.transcript !== false) {
            try {
              const tr = await REALS.transcript(cfg, id, body.lang || cfg.youtube?.hl || "en");
              out.transcript = {
                available: tr.available, cueCount: tr.cueCount,
                pacing: tr.available ? AN.measure(tr.cues, details.duration) : null,
                cues: (tr.cues || []).slice(0, 400),
              };
            } catch (e) { out.transcript = { available: false, note: String(e.message || e) }; }
          }
          if (body.comments) {
            try { out.comments = await REALS.comments(cfg, id, Math.min(200, Number(body.comments) || 30)); }
            catch (e) { out.comments = { comments: [], note: String(e.message || e) }; }
          }
          // Зручні псевдоніми, щоб інтерфейсу не доводилось копатися в вкладеності
          out.pacing = out.transcript?.pacing || null;
          out.topComments = out.comments?.comments || [];
          out.url = details.url || ("https://www.youtube.com/watch?v=" + id);
          return send(res, 200, out);
        } catch (e) { return sendErr(res, 200, String(e.message || e)); }
      }

      // радар свіжих проривів у ніші
      if (p === "/api/yt/radar" && req.method === "POST") {
        const body = await readBody(req);
        const cfg = await loadConfig();
        const queries = Array.isArray(body.queries) ? body.queries.filter(Boolean).slice(0, 8)
          : String(body.query || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8);
        if (!queries.length) return sendErr(res, 400, "Потрібен хоча б один пошуковий запит");
        const perQuery = Math.min(30, Number(body.perQuery) || 12);
        try {
          // Кілька запитів майже завжди перетинаються: те саме відео знаходиться
          // двічі-тричі. Спершу збираємо унікальні ідентифікатори (пам'ятаємо,
          // який запит знайшов відео першим), і лише потім тягнемо деталі —
          // пакетами, а не по одному відео за раз.
          const found = new Map();
          const failedQueries = [];
          for (const q of queries) {
            try {
              const res2 = await REALS.searchVideos(cfg, { q, maxResults: perQuery });
              for (const v of res2) {
                if (v.videoId && !found.has(v.videoId)) found.set(v.videoId, q);
              }
            } catch (e) { failedQueries.push({ query: q, error: String(e.message || e) }); }
          }

          const uniqueIds = [...found.keys()];
          const CHUNK = 12;
          const chunks = [];
          for (let i = 0; i < uniqueIds.length; i += CHUNK) chunks.push(uniqueIds.slice(i, i + CHUNK));
          const detailed = await pool(chunks, 3, async (chunk) => YD.videoDetails(chunk).catch(() => []));

          const candidates = [];
          const seenVideos = new Set();
          for (const batch of detailed) {
            for (const det of batch || []) {
              if (!det || !det.id || seenVideos.has(det.id)) continue;
              seenVideos.add(det.id);
              candidates.push({
                videoId: det.id, title: det.title, url: det.url, views: det.views, duration: det.duration,
                publishedAt: det.date, channel: det.channel, channelId: det.channelId,
                channelUrl: det.channelUrl, subscribers: det.subscribers, query: found.get(det.id) || "",
              });
            }
          }
          const { breakouts, competitors } = AN.filterAndRankRadar(candidates, {
            maxAgeDays: Number(body.maxAgeDays) || 365,
            minSubs: Number(body.minSubs) || 5000,
            maxSubs: Number(body.maxSubs) || 75000,
          });
          return send(res, 200, { ok: true, queries, found: uniqueIds.length, candidates: candidates.length, breakouts, competitors, failedQueries });
        } catch (e) { return sendErr(res, 200, String(e.message || e)); }
      }

      if (p === "/api/shutdown" && req.method === "POST") {
        send(res, 200, { ok: true, message: "Сервер зупиняється…" });
        setTimeout(() => { console.log("\n  Cartel Radar зупинено. До зустрічі!"); process.exit(0); }, 250);
        return;
      }

      // ---------------- статика ----------------
      if (req.method !== "GET" && req.method !== "HEAD") return sendErr(res, 405, "Метод не підтримується");
      const decoded = decodeURIComponent(p);
      // довідка лежить у теці docs/ репозиторію — вона ж є сайтом документації
      if (decoded === "/docs" || decoded.startsWith("/docs/")) {
        const rel = decoded.replace(/^\/docs\/?/, "") || "index.html";
        let docPath = path.join(DOCS, rel);
        if (!docPath.startsWith(DOCS)) return sendErr(res, 403, "Заборонено");
        try {
          const st = await fs.stat(docPath);
          if (st.isDirectory()) docPath = path.join(docPath, "index.html");
          const data = await fs.readFile(docPath);
          return send(res, 200, data, MIME[path.extname(docPath)] || "application/octet-stream");
        } catch { return sendErr(res, 404, "Сторінку довідки не знайдено"); }
      }
      const relPublic = p === "/" ? "index.html" : decoded.replace(/^\/+/, "");
      // Спершу дивимось в оновлені модулі: якщо застосунок стоїть там, де писати
      // не можна, оновлення лягають у теку даних і мають пріоритет.
      for (const candidate of [path.join(MOD.overlayDir(), "public", relPublic), path.join(PUBLIC, relPublic)]) {
        const safe = path.resolve(candidate);
        if (!safe.startsWith(path.resolve(MOD.overlayDir())) && !safe.startsWith(PUBLIC)) continue;
        try {
          let target = safe;
          const stat = await fs.stat(target);
          if (stat.isDirectory()) target = path.join(target, "index.html");
          const data = await fs.readFile(target);
          return send(res, 200, data, MIME[path.extname(target)] || "application/octet-stream");
        } catch { /* пробуємо наступний варіант */ }
      }
      let filePath = path.join(PUBLIC, p === "/" ? "index.html" : decoded);
      if (!filePath.startsWith(PUBLIC)) return sendErr(res, 403, "Заборонено");
      try {
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
        const data = await fs.readFile(filePath);
        return send(res, 200, data, MIME[path.extname(filePath)] || "application/octet-stream");
      } catch {
        try {
          const data = await fs.readFile(path.join(PUBLIC, "index.html"));
          return send(res, 200, data, MIME[".html"]);
        } catch { return sendErr(res, 404, "Файл не знайдено"); }
      }
    } catch (e) {
      console.error("Помилка обробки запиту:", e);
      return sendErr(res, 500, e);
    }
  });
}

const PORT_ARG = (() => {
  const i = process.argv.indexOf("--port");
  if (i > -1 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  const eq = process.argv.find((a) => a.startsWith("--port="));
  return eq ? Number(eq.split("=")[1]) : Number(process.env.CARTEL_RADAR_PORT || process.env.NICHE_RADAR_PORT || 8787);
})();

async function listenWithFallback(server, port, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    const tryPort = port + i;
    try {
      await new Promise((resolve, reject) => {
        const onError = (e) => { server.off("listening", onOk); reject(e); };
        const onOk = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onOk);
        server.listen(tryPort, HOST);
      });
      return tryPort;
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
      console.log(`  Порт ${tryPort} зайнятий, пробую ${tryPort + 1}…`);
    }
  }
  throw new Error("Не вдалося знайти вільний порт");
}

/**
 * Чи запущено цей файл напряму (а не імпортовано).
 *
 * Порівнювати шляхи «як є» не можна: якщо шлях проходить через символічне
 * посилання (на macOS /tmp — це посилання на /private/tmp, у збірках Electron
 * буває те саме), то fileURLToPath віддає вже розв'язаний шлях, а
 * path.resolve(process.argv[1]) — ні. Вони не збігаються, сервер мовчки
 * завершується з кодом 0 і не робить нічого: вікно відкривається, а
 * застосунок порожній. Тому зводимо обидва шляхи до справжніх.
 */
const isMain = await (async () => {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const entry = path.resolve(process.argv[1]);
  if (self === entry) return true;
  const real = async (p) => { try { return await fs.realpath(p); } catch { return p; } };
  return (await real(self)) === (await real(entry));
})();

if (isMain) {
  await ensureDataDir();
  // Версію yt-dlp з’ясовуємо одразу — інакше інтерфейс показує «?» до першого пошуку
  try { await YD.ytdlpVersion(); } catch { /* yt-dlp може бути відсутній */ }
  const migrated = await migrateLegacyData();
  if (migrated) console.log("  Дані перенесено з " + migrated + " → " + DATA_DIR);
  const server = createServer();
  server.on("clientError", (err, socket) => { try { socket.destroy(); } catch {} });
  const port = await listenWithFallback(server, PORT_ARG || 8787);
  const link = `http://${HOST}:${port}`;
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║            C A R T E L   R A D A R             ║
  ╚══════════════════════════════════════════════╝

   Сервер працює:  ${link}
   Зупинити:       кнопка «Вимкнути» в інтерфейсі
                   або закрити це вікно термінала (Ctrl+C)

`);
  if (process.argv.includes("--open")) {
    const { spawn } = await import("node:child_process");
    spawn("open", [link], { detached: true, stdio: "ignore" }).unref();
  }
  const shutdown = () => { console.log("\n  Зупиняю сервер…"); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1200); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Сторож: якщо сервер запущений застосунком і той зник (навіть kill -9),
  // сервер зупиняється сам, щоб не лишати зайнятий порт.
  const parentPid = Number(process.env.CARTEL_RADAR_PARENT_PID || process.env.NICHE_RADAR_PARENT_PID || 0);
  if (parentPid > 0) {
    const watchdog = setInterval(() => {
      try { process.kill(parentPid, 0); }
      catch {
        console.log("\n  Застосунок закрито — зупиняю сервер.");
        clearInterval(watchdog);
        shutdown();
      }
    }, 3000);
    watchdog.unref?.();
  }
}
