// lib/engine.mjs — конвеєри: полювання на ніші, аналіз каналу, gap-сканер, розбір відео
import { chatJSON } from "./llm.mjs";
import { resolveProvider } from "./providers.mjs";
import { pool } from "./jobs.mjs";
import * as YT from "./youtube.mjs";
import * as P from "./prompts.mjs";

const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const tokens = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 3));
function similar(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const j = inter / (A.size + B.size - inter);
  return j > 0.6 || norm(a) === norm(b);
}

/** Прев'ю-лаб: vision-модель дивиться реальні прев'ю й пропонує кращі. */
export async function runThumbnailLab(cfg, params, job) {
  const input = String(params.channel || params.input || "").trim();
  if (!input) throw new Error("Вкажіть канал, нішу або посилання");
  const useYT = YT.ytEnabled(cfg);
  if (!useYT && resolveProvider(cfg, params.provider || "")?.apiStyle !== "mock") {
    throw new Error("Для аналізу прев'ю потрібен ключ YouTube Data API (Налаштування → Дані YouTube) — або демо-рушій");
  }
  const route = pickRoute(cfg, "vision", params);
  const outLang = params.outputLang || cfg.markets?.outputLang || "uk";

  job.emit({ t: "stage", stage: "fetch", label: "Збираю найпопулярніші відео та їхні прев'ю", route });
  let videos = [];
  let reality = null;
  if (!useYT) {
    videos = Array.from({ length: 4 }, (_, i) => ({ title: `Демо-відео №${i + 1}: ${input}`, views: 250000 - i * 40000, videoId: "demo" + i, thumbnail: null }));
    job.emit({ t: "log", level: "warn", msg: "YouTube API вимкнено — працюю на демо-даних" });
  } else if (/youtu\.?be|youtube\.com|^@|^UC[\w-]{20,}$/i.test(input)) {
    reality = await YT.analyzeChannelReality(cfg, input);
    videos = reality.topThumbnails || [];
  } else {
    const found = await YT.searchVideos(cfg, { q: input, maxResults: 12, order: "viewCount" });
    videos = (await YT.getVideos(cfg, found.map((v) => v.videoId)))
      .map((v) => ({ title: v.title, views: v.views, videoId: v.videoId, thumbnail: v.thumbnail }))
      .sort((a, b) => b.views - a.views).slice(0, 6);
  }
  if (!videos.length) throw new Error("Не вдалося знайти відео з прев'ю");

  const images = useYT ? await YT.fetchThumbnails(videos.map((v) => v.thumbnail), Math.min(6, params.limit || 6)) : [];
  if (useYT && !images.length) throw new Error("Не вдалося завантажити зображення прев'ю");
  job.emit({ t: "log", msg: `Завантажено ${images.length} прев'ю — передаю vision-моделі (${route.providerId}/${route.model})` });

  const blocks = [
    { type: "text", text: `Прев'ю №1..${images.length} по порядку:\n${videos.slice(0, images.length).map((v, i) => `№${i + 1}: "${v.title}" — ${v.views} переглядів`).join("\n")}` },
    ...images.map((img) => ({ type: "image", mimeType: img.mimeType, base64: img.base64 })),
  ];

  job.emit({ t: "stage", stage: "vision", label: "Vision-модель аналізує упаковку" });
  const res = await chatJSON(cfg, {
    providerId: route.providerId, model: route.model,
    messages: [P.thumbnailPrompt({ input, count: images.length, outputLang: outLang }), { role: "user", content: blocks }],
    temperature: 0.75, maxTokens: 5000, signal: job.controller.signal, job, seed: input + "thumbs",
  });
  return {
    summary: { input, model: res.model, thumbnails: images.length, costUsd: res.costUsd },
    analysis: res.data,
    thumbnails: videos.slice(0, images.length).map((v, i) => ({ ...v, imageUrl: images[i]?.url })),
    reality: reality ? { channel: reality.channel, stats: reality.stats } : null,
  };
}

/** Вибір маршруту (провайдер+модель) для задачі. */
export function pickRoute(cfg, task, params = {}) {
  const route = cfg.routing?.[task] || {};
  const providerId = params.provider || route.provider || "";
  if (providerId) {
    const p = resolveProvider(cfg, providerId);
    if (!p) throw new Error(`Провайдера «${providerId}» не знайдено`);
    return { providerId, model: params.model || route.model || p.defaultModel };
  }
  if (cfg.routing?.auto !== false) {
    const order = ["openrouter", "openai", "anthropic", "gemini", "deepseek", "groq", "xai", "mistral", "zai", "moonshot", "siliconflow", "together", "fireworks", "dashscope", "cerebras", "novita", "deepinfra", "nvidia", "github", "aimlapi", "ollama", "lmstudio", "vllm", "llamacpp", "litellm"];
    const isLocal = (u) => /127\.0\.0\.1|localhost/.test(u || "");
    const candidates = [];
    for (const id of order) {
      const p = resolveProvider(cfg, id);
      if (!p || !p.baseURL) continue;
      if (p.keyRequired && !p.apiKey) continue;
      // локальний сервер беремо в автовибір лише якщо користувач його явно налаштував
      if (isLocal(p.baseURL) && !cfg.providers?.[id]) continue;
      const testOk = cfg.providers?.[id]?.testOk;
      // провайдер не пройшов «Перевірити з'єднання» — не витрачаємо на нього запуск
      if (testOk === false) continue;
      // спершу ті, чиє з'єднання вже підтверджено, далі неперевірені
      candidates.push({ id, p, rank: testOk === true ? 0 : 1 });
    }
    candidates.sort((a, b) => a.rank - b.rank);
    if (candidates.length) {
      const { id, p } = candidates[0];
      return { providerId: id, model: route.model || p.defaultModel };
    }
    for (const def of (cfg.customProviders || [])) {
      const p = resolveProvider(cfg, def.id);
      if (p && p.baseURL && (!p.keyRequired || p.apiKey) && cfg.providers?.[def.id]?.testOk !== false) return { providerId: def.id, model: route.model || p.defaultModel };
    }
  }
  if (cfg.providers?.mock?.enabled !== false) return { providerId: "mock", model: "mock-analyst" };
  throw new Error(`Немає налаштованого провайдера для задачі «${task}». Відкрийте вкладку «Провайдери».`);
}

export function computeScore(a, weights, reality = null) {
  const w = weights || {};
  const inv = (v) => 10 - (Number(v) || 0);
  const parts = {
    demand: Number(a.demandScore) || 0,
    competition: inv(a.competitionScore),
    saturation: inv(a.saturationScore),
    monetization: Number(a.monetizationScore) || 0,
    novelty: Number(a.noveltyScore) || 0,
    evergreen: Number(a.evergreenScore) || 0,
    growth: Number(a.growthScore) || 0,
    faceless: Number(a.facelessScore) || 0,
    aiProducible: Number(a.aiProducibleScore) || 0,
    ease: Number(a.easeScore) || 0,
  };
  const map = { demand: "demand", competition: "competition", saturation: "saturation", monetization: "monetization", novelty: "novelty", evergreen: "evergreen", growth: "growth", faceless: "faceless", aiProducible: "aiProducible", ease: "ease" };
  let sum = 0, total = 0;
  for (const [k, weight] of Object.entries(w)) {
    const key = map[k] || k;
    if (!(key in parts)) continue;
    sum += parts[key] * (Number(weight) || 0);
    total += Number(weight) || 0;
  }
  let score = total ? (sum / total) : 0;
  if (reality?.opportunityIndex != null) score = score * 0.65 + reality.opportunityIndex * 0.35;
  const confidence = Number(a.confidence) || 5;
  return {
    score: Math.round(score * 100) / 100,
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 10) / 10])),
    confidence: Math.round(confidence * 10) / 10,
    // легкий штраф за низьку впевненість моделі — не спотворює порядок рейтингу
    riskAdjusted: Math.round((score - (10 - confidence) * 0.12) * 100) / 100,
  };
}

function guardCost(cfg, job) {
  const cap = Number(cfg.run?.costCapUsd || 0);
  if (cap > 0 && job.stats.costUsd > cap) throw new Error(`Досягнуто ліміт витрат на запуск (${cap} $). Зупинено.`);
}

// ------------------------------------------------------------------ ПОЛЮВАННЯ
export async function runHunt(cfg, params, job) {
  const run = cfg.run || {};
  const outLang = params.outputLang || cfg.markets?.outputLang || "uk";
  const market = { langs: params.langs || cfg.markets?.langs || ["en"], regions: params.regions || cfg.markets?.regions || ["US"] };
  const seeds = (params.seeds || "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const personas = (cfg.personas || []).filter((p) => p.on !== false);
  if (!personas.length) throw new Error("Увімкніть хоча б одну персону-агента в налаштуваннях");

  const breadthRoute = pickRoute(cfg, "discovery", params);
  const screenRoute = pickRoute(cfg, "screening", params);
  const deepRoute = pickRoute(cfg, "deepdive", params);
  const useYT = YT.ytEnabled(cfg);

  job.emit({ t: "stage", stage: "breadth", label: "Стадія 1/5 · Розвідка ніш", route: breadthRoute, personas: personas.map((p) => p.name), useYT });

  const perAgent = Math.max(4, Math.min(20, params.perAgent || 10));
  const batchesPerAgent = Math.max(1, Math.min(6, params.batches || 2));
  const tasks = [];
  for (const persona of personas) for (let b = 0; b < batchesPerAgent; b++) tasks.push({ persona, batch: b });

  const breadthResults = await pool(tasks, Math.max(1, Math.min(params.concurrency || run.concurrency || 6, 8)), async ({ persona, batch }) => {
    guardCost(cfg, job);
    const prompt = P.discoveryPrompt({
      persona, seed: seeds.join(", ") || "автоматичний пошук", market, batchIndex: batch,
      perAgent, outputLang: outLang, avoid: job.__seenNames || [],
    });
    const userMsg = seeds.length
      ? `Орієнтуйся на ці напрямки та сусідні з ними: ${seeds.join("; ")}. Запропонуй ${perAgent} ніш.`
      : `Знайди ${perAgent} найперспективніших ніш на ринках ${market.regions.join(", ")}. Ніяких очевидних тем.`;
    const res = await chatJSON(cfg, {
      providerId: breadthRoute.providerId, model: breadthRoute.model,
      messages: [prompt, { role: "user", content: userMsg }],
      temperature: params.temperature ?? run.temperature ?? 0.85,
      maxTokens: Math.min(8000, params.maxTokens || run.maxTokens || 6000),
      signal: job.controller.signal, job,
      seed: `${persona.id}-${batch}`,
    });
    const list = Array.isArray(res.data?.candidates) ? res.data.candidates : (Array.isArray(res.data) ? res.data : []);
    job.emit({ t: "log", msg: `${persona.name} (партія ${batch + 1}): ${list.length} кандидатів (${res.model})` });
    for (const c of list) if (c?.niche) job.emit({ t: "candidate_new", candidate: { ...c, persona: persona.name } });
    return list;
  }, { signal: job.controller.signal });

  const all = [];
  const seen = [];
  for (const r of breadthResults) {
    if (r?.__error) { job.emit({ t: "log", level: "warn", msg: "Агент розвідки не відповів: " + r.__error }); continue; }
    for (const c of r) {
      if (!c?.niche) continue;
      if (seen.some((s) => similar(s, c.niche))) continue;
      seen.push(c.niche); all.push(c);
    }
  }
  job.__seenNames = seen;
  const maxCandidates = Math.max(5, Math.min(300, params.maxCandidates || run.maxCandidates || 90));
  let candidates = all.slice(0, maxCandidates);
  job.stats.total = candidates.length;
  job.emit({ t: "log", msg: `Розвідка завершена: ${all.length} унікальних ніш, у роботу беру ${candidates.length}` });
  job.progress({ stage: "breadth" });
  if (!candidates.length) throw new Error("Розвідка не дала кандидатів. Спробуйте інші сіди або іншу модель.");

  // --- Стадія 2: скринінг
  job.emit({ t: "stage", stage: "screening", label: `Стадія 2/5 · Паралельний скринінг (${candidates.length} ніш)`, route: screenRoute });
  let doneCount = 0;
  const screened = await pool(candidates, Math.max(1, Math.min(params.concurrency || run.concurrency || 6, 16)), async (c) => {
    guardCost(cfg, job);
    const prompt = P.screeningPrompt({ candidate: c, market, outputLang: outLang, weights: cfg.scoring?.weights });
    try {
      const res = await chatJSON(cfg, {
        providerId: screenRoute.providerId, model: screenRoute.model,
        messages: [prompt, { role: "user", content: "Дай оцінки для КАНДИДАТА вище." }],
        temperature: Math.min(0.6, run.temperature ?? 0.6), maxTokens: 2200,
        signal: job.controller.signal, job, seed: c.niche,
      });
      const a = { ...res.data, niche: res.data?.niche || c.niche, _source: c };
      const scored = { ...a, ...computeScore(a, cfg.scoring?.weights) };
      job.stats.done++;
      job.emit({ t: "candidate_scored", candidate: scored });
      return scored;
    } catch (e) {
      job.stats.failed++;
      job.emit({ t: "log", level: "warn", msg: `Скринінг «${c.niche}» не вдався: ${e.message}` });
      return { niche: c.niche, _source: c, __error: e.message, demandScore: 0, score: 0 };
    } finally {
      doneCount++;
      job.emit({ t: "progress", stage: "screening", done: doneCount, total: candidates.length, stats: { ...job.stats } });
    }
  }, { signal: job.controller.signal });

  const ok = screened.filter((s) => !s.__error).sort((a, b) => b.score - a.score);
  job.emit({ t: "log", msg: `Скринінг: ${ok.length} з ${candidates.length} успішно оцінено` });

  // --- Стадія 3: перевірка реальністю (YouTube)
  let withReality = ok;
  if (useYT) {
    const checkCount = Math.min(ok.length, Math.max(6, Math.min(40, params.realityChecks || 24)));
    job.emit({ t: "stage", stage: "reality", label: `Стадія 3/5 · Перевірка реальними даними YouTube (${checkCount} ніш)`, quota: YT.quotaState() });
    const top = ok.slice(0, checkCount);
    const rest = ok.slice(checkCount);
    withReality = await pool(top, 3, async (s) => {
      try {
        const r = await YT.nicheRealityCheck(cfg, s.niche, { maxResults: cfg.youtube?.sampleSize || 12 });
        const merged = { ...s, reality: r, ...computeScore(s, cfg.scoring?.weights, r) };
        job.emit({ t: "candidate_scored", candidate: merged, reality: true });
        return merged;
      } catch (e) {
        job.emit({ t: "log", level: "warn", msg: `YouTube-перевірка «${s.niche}»: ${e.message}` });
        return s;
      }
    }, { signal: job.controller.signal });
    withReality = [...withReality.filter(Boolean), ...rest];
  } else {
    job.emit({ t: "log", msg: "YouTube API вимкнено — працюю в LLM-режимі (увімкнути можна в Налаштуваннях)" });
  }

  withReality.sort((a, b) => (b.riskAdjusted ?? b.score) - (a.riskAdjusted ?? a.score));

  // --- Стадія 4: глибокі досьє
  const deepCount = Math.max(1, Math.min(20, params.deepDiveCount ?? run.deepDiveCount ?? 6));
  const targets = withReality.slice(0, deepCount);
  job.emit({ t: "stage", stage: "deepdive", label: `Стадія 4/5 · Досьє по ${targets.length} фіналістах`, route: deepRoute });
  const dossiers = await pool(targets, Math.max(1, Math.min(3, params.concurrency || 3)), async (s) => {
    guardCost(cfg, job);
    try {
      const prompt = P.deepDivePrompt({ candidate: s, analysis: s, market, outputLang: outLang, reality: s.reality || null });
      const res = await chatJSON(cfg, {
        providerId: deepRoute.providerId, model: deepRoute.model,
        messages: [prompt, { role: "user", content: "Склади досьє для кандидата вище." }],
        temperature: 0.9, maxTokens: Math.min(12000, params.maxTokens || run.maxTokens || 6000),
        signal: job.controller.signal, job, seed: s.niche + "dossier",
      });
      const full = { ...s, dossier: res.data?.dossier || res.data };
      job.emit({ t: "candidate_dossier", candidate: full });
      return full;
    } catch (e) {
      job.emit({ t: "log", level: "warn", msg: `Досьє «${s.niche}»: ${e.message}` });
      return s;
    }
  }, { signal: job.controller.signal });

  const finalList = withReality.map((s) => dossiers.find((d) => d.niche === s.niche) || s);
  finalList.sort((a, b) => (b.riskAdjusted ?? b.score) - (a.riskAdjusted ?? a.score));

  // --- Стадія 5: підсумок
  job.emit({ t: "stage", stage: "done", label: "Стадія 5/5 · Ранжування готове" });
  const summary = {
    seed: seeds.join(", ") || "автопошук",
    totalCandidates: all.length,
    screened: ok.length,
    withReality: useYT ? withReality.filter((s) => s.reality).length : 0,
    dossiers: dossiers.filter((d) => d.dossier).length,
    top: finalList.slice(0, 3).map((s) => ({ niche: s.niche, score: s.score, rpm: s.rpmEstimateUsd })),
    best: finalList[0]?.niche || null,
    costUsd: Math.round(job.stats.costUsd * 10000) / 10000,
    youtubeQuota: useYT ? YT.quotaState() : null,
  };
  job.emit({ t: "summary", summary });
  return { summary, niches: finalList, market, route: breadthRoute };
}

// ------------------------------------------------------------------ АНАЛІЗ КАНАЛУ
export async function runChannelAnalysis(cfg, params, job) {
  const input = String(params.channel || "").trim();
  if (!input) throw new Error("Вкажіть канал: @handle, URL або ID");
  const route = pickRoute(cfg, "screening", params);
  const outLang = params.outputLang || cfg.markets?.outputLang || "uk";
  let reality = null;
  if (YT.ytEnabled(cfg)) {
    job.emit({ t: "stage", stage: "reality", label: "Збір реальних даних каналу з YouTube", quota: YT.quotaState() });
    try { reality = await YT.analyzeChannelReality(cfg, input); job.emit({ t: "log", msg: `Канал: ${reality.channel.title}, ${reality.channel.subs} підписників, вибірка ${reality.stats.sampleSize} відео` }); }
    catch (e) { job.emit({ t: "log", level: "warn", msg: "YouTube: " + e.message }); }
  } else {
    job.emit({ t: "log", level: "warn", msg: "YouTube API вимкнено — аналіз буде якісним, але без реальних цифр" });
  }
  job.emit({ t: "stage", stage: "analysis", label: "Модель аналізує канал", route });
  const res = await chatJSON(cfg, {
    providerId: route.providerId, model: route.model,
    messages: [P.channelPrompt({ input, reality, outputLang: outLang }), { role: "user", content: "Проаналізуй канал вище." }],
    temperature: 0.7, maxTokens: 6000, signal: job.controller.signal, job, seed: input,
  });
  const analysis = res.data || {};
  if (reality) {
    analysis.reality = {
      channel: reality.channel, stats: reality.stats,
      outliers: reality.outliers, uploadsByMonth: reality.uploadsByMonth,
      gaps: reality.gaps, recentVideos: reality.recentVideos,
    };
  }
  return { summary: { channel: input, model: res.model, costUsd: res.costUsd }, analysis };
}

// ------------------------------------------------------------------ GAP-СКАНЕР
export async function runGapScan(cfg, params, job) {
  const seed = String(params.seed || "").trim();
  if (!seed) throw new Error("Вкажіть тему для сканування");
  const route = pickRoute(cfg, "screening", params);
  const outLang = params.outputLang || cfg.markets?.outputLang || "uk";
  const market = { langs: params.langs || cfg.markets?.langs, regions: params.regions || cfg.markets?.regions };
  const tasks = [0, 1, 2].map((i) => i);
  job.emit({ t: "stage", stage: "gap", label: "Три паралельні агенти розкладають тему на кластери", route });
  const results = await pool(tasks, 3, async (i) => {
    const angle = ["загальний попит і конкуренція", "проблеми та болі аудиторії", "порівняння, ціни й альтернативи"][i];
    const res = await chatJSON(cfg, {
      providerId: route.providerId, model: route.model,
      messages: [
        P.gapPrompt({ seed: `${seed} (${angle})`, market, outputLang: outLang }),
        { role: "user", content: `Розклади тему «${seed}» з фокусом на: ${angle}` },
      ],
      temperature: 0.8, maxTokens: 4000, signal: job.controller.signal, job, seed: seed + i,
    });
    return res.data || {};
  }, { signal: job.controller.signal });

  const clusters = results.flatMap((r) => r.clusters || []);
  for (const c of clusters) c.opportunity = Math.round(((Number(c.demand) || 0) * 0.6 + (10 - (Number(c.competition) || 0)) * 0.4) * 10) / 10;
  clusters.sort((a, b) => (b.opportunity || 0) - (a.opportunity || 0));

  let reality = null;
  if (YT.ytEnabled(cfg) && params.checkTop !== false) {
    const top = clusters.slice(0, Math.min(6, clusters.length));
    job.emit({ t: "stage", stage: "reality", label: `Перевірка ${top.length} кластерів реальними даними YouTube`, quota: YT.quotaState() });
    await pool(top, 2, async (c) => {
      try { c.reality = await YT.nicheRealityCheck(cfg, (c.keywords || [])[0] || c.cluster, { maxResults: 10 }); }
      catch (e) { job.emit({ t: "log", level: "warn", msg: e.message }); }
    }, { signal: job.controller.signal });
    reality = top.map((c) => ({ cluster: c.cluster, opportunityIndex: c.reality?.opportunityIndex, medianViews: c.reality?.medianViews }));
  }
  return { summary: { seed, clusters: clusters.length, best: clusters[0]?.cluster || null }, clusters, reality, notes: results.map((r) => r.note).filter(Boolean) };
}

// ------------------------------------------------------------------ РОЗБІР ВІДЕО
export async function runVideoLab(cfg, params, job) {
  const url = String(params.url || "").trim();
  if (!url) throw new Error("Вставте посилання на відео");
  const route = pickRoute(cfg, "screening", params);
  const outLang = params.outputLang || cfg.markets?.outputLang || "uk";
  let reality = null;
  const idMatch = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{6,})/);
  if (YT.ytEnabled(cfg) && idMatch) {
    try {
      const [v] = await YT.getVideos(cfg, [idMatch[1]]);
      if (v) { const ch = await YT.getChannelStats(cfg, [v.channelId]); reality = { video: v, channel: ch[0] || null }; }
      job.emit({ t: "log", msg: reality ? `Реальні дані: ${reality.video.views} переглядів` : "Даних про відео немає" });
    } catch (e) { job.emit({ t: "log", level: "warn", msg: "YouTube: " + e.message }); }
  }
  job.emit({ t: "stage", stage: "video", label: "Розбір упаковки відео", route });
  const res = await chatJSON(cfg, {
    providerId: route.providerId, model: route.model,
    messages: [P.videoPrompt({ url, reality, outputLang: outLang }), { role: "user", content: "Розбери відео вище." }],
    temperature: 0.8, maxTokens: 4000, signal: job.controller.signal, job, seed: url,
  });
  return { summary: { url, model: res.model }, analysis: res.data, reality };
}
