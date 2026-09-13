// lib/llm.mjs — уніфікований виклик LLM: стрім, ретраї, облік токенів і вартості
import { resolveProvider, buildRequest, parseChunk } from "./providers.mjs";
import { mockStream } from "./mock.mjs";

// Орієнтовні ціни, USD за 1M токенів [вхід, вихід]. Невідомі моделі — 0 (не блокуємо роботу).
const PRICES = [
  [/gpt-5-mini/i, [0.25, 2]], [/gpt-5/i, [1.25, 10]], [/gpt-4\.1-mini/i, [0.4, 1.6]], [/gpt-4\.1/i, [2, 8]],
  [/gpt-4o-mini/i, [0.15, 0.6]], [/gpt-4o/i, [2.5, 10]], [/o4-mini/i, [1.1, 4.4]],
  [/claude-opus/i, [15, 75]], [/claude-sonnet/i, [3, 15]], [/claude-haiku/i, [1, 5]], [/claude-3-7-sonnet/i, [3, 15]],
  [/gemini-2\.5-pro/i, [1.25, 10]], [/gemini-2\.5-flash-lite/i, [0.1, 0.4]], [/gemini-2\.5-flash/i, [0.3, 2.5]], [/gemini-2\.0-flash/i, [0.1, 0.4]],
  [/deepseek-reasoner/i, [0.55, 2.19]], [/deepseek/i, [0.27, 1.1]],
  [/grok-4/i, [3, 15]], [/grok-3-mini/i, [0.3, 0.5]], [/grok/i, [3, 15]],
  [/mistral-large/i, [2, 6]], [/mistral-medium/i, [0.4, 2]], [/magistral/i, [2, 5]], [/mistral-small/i, [0.2, 0.6]],
  [/llama-3\.3-70b/i, [0.59, 0.79]], [/llama3\.1-8b/i, [0.05, 0.08]],
  [/qwen3-max/i, [1.2, 6]], [/qwen3-235b/i, [0.2, 0.6]], [/qwen/i, [0.2, 0.6]],
  [/glm-4\.5-air/i, [0.2, 1.1]], [/glm-4\.6/i, [0.6, 2.2]], [/glm/i, [0.6, 2.2]],
  [/kimi-k2/i, [0.6, 2.5]], [/sonar-pro/i, [3, 15]], [/sonar/i, [1, 1]],
  [/command-a/i, [2.5, 10]], [/minimax-m2/i, [0.3, 1.2]],
];

export function priceOf(model) {
  for (const [re, p] of PRICES) if (re.test(model || "")) return p;
  return [0, 0];
}

export function costOf(model, usage) {
  if (!usage) return 0;
  const [pin, pout] = priceOf(model);
  return ((usage.promptTokens || 0) / 1e6) * pin + ((usage.completionTokens || 0) / 1e6) * pout;
}

export function hasUsableProvider(cfg, id) {
  const p = resolveProvider(cfg, id);
  if (!p) return { ok: false, reason: `Провайдера «${id}» не знайдено` };
  if (p.apiStyle === "mock") return { ok: true, provider: p };
  if (!p.baseURL) return { ok: false, reason: "Не вказано base URL" };
  if (p.keyRequired && !p.apiKey) return { ok: false, reason: `Немає API-ключа для ${p.name}` };
  return { ok: true, provider: p };
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("Скасовано")); }, { once: true });
});

/**
 * Один виклик моделі. Повертає { text, usage, costUsd, ms, attempts, model, providerId }.
 * onToken(text) викликається на кожен чанк (для живого стріму в UI).
 */
export async function chat(cfg, opts) {
  const {
    providerId, model, messages, temperature = 0.8, maxTokens = 4096,
    json = false, signal = null, onToken = null, timeoutMs = 180000,
    retries = 2, job = null,
  } = opts;

  const res = hasUsableProvider(cfg, providerId);
  if (!res.ok) throw new Error(res.reason);
  const p = res.provider;
  const useModel = model || p.defaultModel;
  if (!useModel && p.apiStyle !== "mock") throw new Error(`Не вибрано модель для ${p.name}`);

  const started = Date.now();
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal) { if (signal.aborted) throw new Error("Скасовано"); signal.addEventListener("abort", onAbort, { once: true }); }
    const timer = setTimeout(() => ac.abort(new Error("Таймаут запиту")), timeoutMs);
    let text = "";
    let reasoning = "";
    let usage = null;
    try {
      if (p.apiStyle === "mock") {
        for await (const ch of mockStream(messages, { seed: opts.seed })) {
          if (ch.text) { text += ch.text; onToken?.(ch.text); }
          if (ch.usage) usage = ch.usage;
          if (signal?.aborted) throw new Error("Скасовано");
        }
      } else {
        const req = buildRequest(p, { model: useModel, messages, temperature, maxTokens, json, stream: true });
        const resp = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: ac.signal });
        if (!resp.ok) {
          const bodyText = await resp.text().catch(() => "");
          const hint = resp.status === 404
            ? " ⇢ Схоже, назва моделі або шлях ендпоінта невірні. Натисніть «Підтягнути моделі» у картці провайдера."
            : resp.status === 401 || resp.status === 403
              ? " ⇢ Перевірте API-ключ у картці провайдера (кнопка «Тест»)."
              : "";
          const err = new Error(`${p.name}: HTTP ${resp.status} — ${bodyText.slice(0, 300)}${hint}`);
          err.status = resp.status;
          err.retryAfter = Number(resp.headers.get("retry-after")) || 0;
          throw err;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let done = false;
        while (!done) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();
          for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith(":")) continue;
            const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
            if (payload === "[DONE]") { done = true; continue; }
            let obj; try { obj = JSON.parse(payload); } catch { continue; }
            const chunk = parseChunk(req.style, obj);
            if (chunk.error) throw new Error(`${p.name}: ${chunk.error}`);
            if (chunk.text) { text += chunk.text; onToken?.(chunk.text); }
            if (chunk.reasoning) reasoning += chunk.reasoning;
            if (chunk.usage) usage = { ...(usage || {}), ...chunk.usage };
            if (chunk.done) done = true;
          }
        }
      }
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!usage) usage = { promptTokens: Math.ceil(messages.reduce((n, m) => n + String(m.content).length, 0) / 4), completionTokens: Math.ceil(text.length / 4) };
      const costUsd = costOf(useModel, usage);
      if (job) { job.stats.calls++; job.stats.promptTokens += usage.promptTokens || 0; job.stats.completionTokens += usage.completionTokens || 0; job.stats.costUsd += costUsd; }
      // reasoning-модель могла витратити весь ліміт на «думки» й не дійти до відповіді —
      // це не помилка з'єднання, тож віддаємо те, що є, і позначаємо це прапорцем
      let usedReasoning = false;
      if (!text.trim() && reasoning.trim()) {
        text = reasoning;
        usedReasoning = true;
        job?.emit({ t: "log", level: "warn", msg: `${p.name}: модель повернула лише міркування (вичерпано ліміт токенів) — підвищте «Макс. токенів» або візьміть не-reasoning модель` });
      }
      if (!text.trim()) throw new Error(`${p.name}: порожня відповідь моделі. ${reasoning ? "Модель витратила ліміт на міркування — підвищте «Макс. токенів»." : "Перевірте модель і ключ."}`);
      return { text, usage, costUsd, ms: Date.now() - started, attempts: attempt + 1, model: useModel, providerId: p.id, usedReasoning };
    } catch (e) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      lastErr = e;
      if (signal?.aborted) throw new Error("Скасовано");
      const retryable = !e.status || e.status === 429 || e.status >= 500 || /fetch failed|ECONN|timeout|Таймаут|aborted/i.test(e.message || "");
      if (attempt < retries && retryable) {
        const wait = e.retryAfter ? e.retryAfter * 1000 : Math.min(8000, 700 * Math.pow(2, attempt)) + Math.random() * 400;
        job?.emit({ t: "log", level: "warn", msg: `Повтор ${attempt + 2}/${retries + 1} для ${p.name} через ${Math.round(wait)} мс (${String(e.message).slice(0, 120)})` });
        await sleep(wait, signal);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("Невідома помилка виклику моделі");
}

/** Витягує перший коректний JSON-об'єкт/масив із тексту моделі. */
export function extractJSON(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/gi, "").trim();
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const direct = tryParse(cleaned);
  if (direct) return direct;
  const starts = [cleaned.indexOf("{"), cleaned.indexOf("[")].filter((i) => i >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const open = cleaned[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return tryParse(cleaned.slice(start, i + 1)); }
  }
  const tail = cleaned.slice(start);
  return tryParse(tail) || tryParse(tail.replace(/,\s*$/, "") + close) || null;
}

/** Виклик із гарантованим JSON-результатом: парсинг + один ремонтний запит. */
export async function chatJSON(cfg, opts) {
  const first = await chat(cfg, { ...opts, json: true });
  let parsed = extractJSON(first.text);
  if (parsed) return { ...first, data: parsed };
  const repair = await chat(cfg, {
    ...opts,
    json: true,
    messages: [
      ...opts.messages,
      { role: "assistant", content: first.text.slice(0, 4000) },
      { role: "user", content: "Твоя попередня відповідь не була валідним JSON. Поверни ЛИШЕ валідний JSON без пояснень і без markdown-обгортки." },
    ],
  });
  parsed = extractJSON(repair.text);
  if (!parsed) throw new Error(`Модель ${first.model} не повернула валідний JSON`);
  return { ...repair, data: parsed, repaired: true };
}

/** Список моделей провайдера (кнопка «Підтягнути моделі»). */
export async function listModels(cfg, providerId) {
  const res = hasUsableProvider(cfg, providerId);
  if (!res.ok) throw new Error(res.reason);
  const p = res.provider;
  if (p.apiStyle === "mock") return p.models;
  const base = String(p.baseURL).replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };
  if (p.authStyle === "bearer" && p.apiKey) headers["Authorization"] = `Bearer ${p.apiKey}`;
  if (p.authStyle === "x-api-key" && p.apiKey) headers["x-api-key"] = p.apiKey;
  if (p.authStyle === "api-key" && p.apiKey) headers["api-key"] = p.apiKey;
  Object.assign(headers, p.extraHeaders || {});
  let url = `${base}/models`;
  if (p.apiStyle === "gemini") url += `?key=${encodeURIComponent(p.apiKey)}`;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const arr = data?.data || data?.models || [];
  const ids = arr.map((m) => m.id || m.name?.replace(/^models\//, "")).filter(Boolean);
  return [...new Set(ids)].sort();
}

// «Підтягнути моделі» віддавав 400+ назв, і типовою ставала перша за алфавітом —
// часто це embedding, tts чи veo. Тепер обираємо справжню чат-модель.
const NOT_CHAT = /embedding|embed|tts|image|veo|lyria|transcribe|audio|aqa|robotics|computer-use|deep-research|nano-banana|omni|whisper|dall|sora|moderation|guard|rerank|clip|voice|imagen/i;
const GOOD_CHAT = /gpt-5|gpt-4|(^|\/)o[34]|claude.*(sonnet|opus|haiku)|gemini.*(flash|pro)|deepseek-(chat|v3|v4|flash|reasoner)|qwen.*(plus|max|instruct)|llama.*(70|8|3\.1|4)|mistral-(large|medium|small)|grok|command-r|glm-4|kimi|minimax|sonnet|chat|instruct|turbo/i;

/** Найрозумніша типова модель зі списку провайдера. */
export function pickDefaultModel(models) {
  const list = (models || []).filter((m) => typeof m === "string" && m);
  if (!list.length) return "";
  const chat = list.filter((m) => !NOT_CHAT.test(m));
  const pool = chat.length ? chat : list;
  const preferred = pool.filter((m) => GOOD_CHAT.test(m));
  const rank = (m) => {
    const s = m.toLowerCase();
    const toks = s.split(/[^a-z0-9.]+/).filter(Boolean);
    const has = (...t) => t.some((x) => toks.includes(x));
    let v = 0;
    if (has("flash", "mini", "haiku", "nano", "tiny", "small")) v += 30;
    if (has("sonnet", "opus", "pro", "large", "max", "plus", "ultra")) v += 20;
    if (has("preview", "experimental", "beta", "latest", "exp")) v -= 25;
    if (has("reasoning", "reasoner", "thinking")) v -= 10;
    const ver = s.match(/(\d+)(?:\.(\d+))?/);
    v += Math.min(ver ? Number(ver[1]) + (Number(ver[2]) || 0) / 10 : 0, 9);
    return v - s.length / 100;
  };
  return (preferred.length ? preferred : pool).slice().sort((a, b) => rank(b) - rank(a))[0] || list[0];
}

/** Швидкий тест з'єднання. */
export async function testProvider(cfg, providerId) {
  const t0 = Date.now();
  const res = await chat(cfg, {
    providerId,
    model: resolveProvider(cfg, providerId)?.defaultModel,
    messages: [
      { role: "system", content: "Ти тестовий асистент. Відповідай дуже коротко." },
      { role: "user", content: "Відповідай одним словом: працює" },
    ],
    maxTokens: 700, temperature: 0, retries: 0, timeoutMs: 60000,
  });
  return {
    ok: true, ms: Date.now() - t0, model: res.model,
    sample: res.text.trim().replace(/\s+/g, " ").slice(0, 120),
    reasoningOnly: !!res.usedReasoning,
    usage: res.usage,
  };
}
