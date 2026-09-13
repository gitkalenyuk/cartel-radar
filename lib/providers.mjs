// lib/providers.mjs — адаптери шести стилів API + розв'язання провайдера з конфігу
import { PRESET_BY_ID, PROVIDER_PRESETS } from "./presets.mjs";
export { PROVIDER_PRESETS, PRESET_BY_ID };

export function substituteTemplate(str, fields = {}) {
  return String(str || "").replace(/\{(\w+)\}/g, (_, k) => fields[k] ?? "");
}

export function allProviderDefs(cfg) {
  const custom = (cfg?.customProviders || []).map((c) => ({ ...c, custom: true }));
  return [...PROVIDER_PRESETS, ...custom];
}

export function findDef(cfg, id) {
  return allProviderDefs(cfg).find((p) => p.id === id) || null;
}

/**
 * Об'єднаний опис провайдера: пресет + збережені налаштування користувача.
 * apiKey/baseURL/models можна перевизначити в UI.
 */
export function resolveProvider(cfg, id) {
  const def = findDef(cfg, id);
  if (!def) return null;
  const saved = cfg?.providers?.[id] || {};
  const fields = { ...(def.fields ? Object.fromEntries(def.fields.map((f) => [f.key, f.default || ""])) : {}), ...(saved.fields || {}) };
  const baseURL = substituteTemplate(saved.baseURL || def.baseURL, fields);
  return {
    ...def,
    fields,
    baseURL,
    apiKey: saved.apiKey || "",
    models: (saved.models && saved.models.length ? saved.models : def.models) || [],
    defaultModel: saved.defaultModel || (saved.models && saved.models[0]) || (def.models || [])[0] || "",
    enabled: saved.enabled !== false,
    extraHeaders: { ...(def.extraHeaders || {}), ...(saved.extraHeaders || {}) },
    maxTokensField: saved.maxTokensField || def.maxTokensField,
    apiVersion: saved.apiVersion || def.apiVersion || "",
  };
}

export function listProviders(cfg) {
  return allProviderDefs(cfg).map((def) => {
    const saved = cfg?.providers?.[def.id] || null;
    const p = resolveProvider(cfg, def.id);
    return {
      id: p.id, name: p.name, category: p.category, apiStyle: p.apiStyle, baseURL: p.baseURL,
      keyRequired: p.keyRequired && p.authStyle !== "none", keyUrl: p.keyUrl, docs: p.docs,
      notes: p.notes, warn: p.warn || null, custom: !!p.custom, enabled: p.enabled,
      fields: p.fields || {}, apiVersion: p.apiVersion, extraHeaders: p.extraHeaders || {},
      hasKey: !!p.apiKey, models: p.models || [], defaultModel: p.defaultModel,
      // «налаштований» = є ключ АБО моделі АБО користувач явно зберігав картку.
      // Інакше локальні сервери (Ollama тощо) показувались як «готові», ще не існуючи.
      userConfigured: !!saved,
      testOk: saved?.testOk,
      testError: saved?.testError,
      testedAt: saved?.testedAt,
      configured: !!saved && !!(p.baseURL && (!p.keyRequired || p.apiKey)),
      ready: !!saved && !!(p.baseURL && (!p.keyRequired || p.apiKey)),
    };
  });
}

const isLocal = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)/.test(u || "");

function authHeaders(p) {
  const h = {};
  const key = p.apiKey || "";
  switch (p.authStyle) {
    case "bearer": h["Authorization"] = `Bearer ${key}`; break;
    case "x-api-key": h["x-api-key"] = key; break;
    case "api-key": h["api-key"] = key; break;
    case "none": break;
    default: if (key) h["Authorization"] = `Bearer ${key}`;
  }
  return h;
}

/**
 * Канонічний формат вмісту повідомлення:
 *   рядок  — звичайний текст
 *   масив  — [{ type:'text', text } | { type:'image', mimeType, base64 }]
 * Кожен адаптер конвертує його у свій формат.
 */
export function normalizeContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? { type: "text", text: b } : b));
  }
  return [{ type: "text", text: String(content ?? "") }];
}

const textOf = (content) => normalizeContent(content).filter((b) => b.type === "text").map((b) => b.text).join("\n");
const imagesOf = (content) => normalizeContent(content).filter((b) => b.type === "image");

function toOpenAIContent(content) {
  const blocks = normalizeContent(content);
  if (!blocks.some((b) => b.type === "image")) return blocks.map((b) => b.text).join("\n");
  return blocks.map((b) => b.type === "image"
    ? { type: "image_url", image_url: { url: `data:${b.mimeType};base64,${b.base64}` } }
    : { type: "text", text: b.text });
}

function toAnthropicContent(content) {
  const blocks = normalizeContent(content);
  if (!blocks.some((b) => b.type === "image")) return blocks.map((b) => b.text).join("\n");
  return blocks.map((b) => b.type === "image"
    ? { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.base64 } }
    : { type: "text", text: b.text });
}

// ── параметри, які приймають не всі моделі ────────────────────────────────
//
// Різні моделі відкидають різні параметри запиту. Нові моделі Moonshot (Kimi)
// вимагають temperature рівно 1 і відповідають HTTP 400 «invalid temperature:
// only 1 is allowed for this model». Reasoning-моделі OpenAI не знають
// max_tokens і хочуть max_completion_tokens.
//
// Замість того щоб змушувати користувача вгадувати налаштування, застосунок
// запам'ятовує таку відмову й повторює запит без проблемного параметра.
// Вивчене живе до перезапуску; сталі правила для відомих моделей задані
// прямо в пресетах провайдерів (paramRules).
const PARAM_TWEAKS = new Map();

export function tweakKey(providerId, model) { return `${providerId}|${model || ""}`; }

/** Вивчені правила для конкретної моделі. */
export function getTweaks(providerId, model) { return PARAM_TWEAKS.get(tweakKey(providerId, model)) || {}; }

export function setTweaks(providerId, model, patch) {
  const k = tweakKey(providerId, model);
  const next = { ...(PARAM_TWEAKS.get(k) || {}), ...patch };
  PARAM_TWEAKS.set(k, next);
  return next;
}

export function allTweaks() { return Object.fromEntries(PARAM_TWEAKS); }
export function clearTweaks() { PARAM_TWEAKS.clear(); }

/** Сталі правила з опису провайдера: paramRules: [{ match: "kimi", omitTemperature: true }] */
function rulesFor(p, model) {
  const m = String(model || "").toLowerCase();
  const out = {};
  for (const rule of p?.paramRules || []) {
    if (!rule?.match || m.includes(String(rule.match).toLowerCase())) Object.assign(out, rule);
  }
  delete out.match;
  return out;
}

/** Підсумкові правила: те, що задано в пресеті, плюс те, що застосунок вивчив. */
export function tweaksFor(p, model) {
  return { ...rulesFor(p, model), ...getTweaks(p?.id, model) };
}

/**
 * Розпізнає у відповіді сервера відмову прийняти параметр і каже, що змінити.
 * Повертає null, якщо це звичайна помилка — тоді її показуємо користувачу як є.
 */
export function tweakForError(bodyText) {
  const t = String(bodyText || "");
  if (/invalid[_ ]temperature|temperature[^.]{0,40}(only|must be|allowed)[^.]{0,20}1|unsupported[^.]{0,20}temperature|temperature[^.]{0,30}not supported/i.test(t)) {
    return { omitTemperature: true };
  }
  if (/max_tokens[^.]{0,60}not supported|use[^.]{0,30}max_completion_tokens|unsupported parameter[^.]{0,20}max_tokens/i.test(t)) {
    return { maxTokensField: "max_completion_tokens" };
  }
  return null;
}

export function buildRequest(p, opts) {
  const { model, messages, temperature = 0.8, maxTokens = 4096, json = false, stream = true } = opts;
  const tw = opts.tweaks || tweaksFor(p, model);
  // Порожній обʼєкт замість temperature = параметр не надсилається взагалі,
  // і тоді модель застосовує своє власне значення за замовчуванням.
  const tempField = tw.omitTemperature ? {} : { temperature };
  const maxField = tw.maxTokensField || p.maxTokensField || "max_tokens";
  const headers = { "Content-Type": "application/json", ...authHeaders(p), ...(p.extraHeaders || {}) };
  const base = String(p.baseURL || "").replace(/\/+$/, "");
  let url = base;
  let body = {};

  switch (p.apiStyle) {
    case "anthropic": {
      url = `${base}/messages`;
      const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n\n");
      const rest = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: toAnthropicContent(m.content) }));
      body = { model, system: system || undefined, messages: rest, max_tokens: maxTokens, ...tempField, stream };
      headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
      break;
    }
    case "gemini": {
      const key = p.apiKey || "";
      const action = stream ? "streamGenerateContent" : "generateContent";
      url = `${base}/models/${encodeURIComponent(model)}:${action}`;
      if (stream) url += "?alt=sse";
      if (p.authStyle === "query" && key) url += (url.includes("?") ? "&" : "?") + `${p.authParam || "key"}=${encodeURIComponent(key)}`;
      const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n\n");
      const contents = messages.filter((m) => m.role !== "system").map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: normalizeContent(m.content).map((b) => (b.type === "image"
          ? { inline_data: { mime_type: b.mimeType, data: b.base64 } }
          : { text: b.text })),
      }));
      body = {
        contents,
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        generationConfig: { ...tempField, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: "application/json" } : {}) },
      };
      delete headers["Authorization"]; delete headers["x-api-key"];
      break;
    }
    case "cohere": {
      url = `${base}/v2/chat`;
      body = {
        model, stream,
        messages: messages.map((m) => ({ role: m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user", content: toOpenAIContent(m.content) })),
        ...tempField, max_tokens: maxTokens,
        ...(json ? { response_format: { type: "json_object" } } : {}),
      };
      break;
    }
    case "azure": {
      const apiVersion = p.apiVersion || "2024-10-21";
      url = `${base}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
      body = { messages, ...tempField, max_tokens: maxTokens, stream, ...(json ? { response_format: { type: "json_object" } } : {}) };
      break;
    }
    case "mock": {
      url = "local://mock";
      body = { model, messages, temperature, maxTokens, json, stream };
      break;
    }
    default: { // openai
      url = `${base}/chat/completions`;
      body = {
        model,
        messages: messages.map((m) => ({ ...m, content: m.role === "system" ? textOf(m.content) : toOpenAIContent(m.content) })),
        ...tempField, stream,
        [maxField]: maxTokens,
        ...(json ? { response_format: { type: "json_object" } } : {}),
      };
      break;
    }
  }
  return { url, headers, body, style: p.apiStyle, local: isLocal(url) };
}

/** Витягує текст із SSE-чанка конкретного стилю API. */
export function parseChunk(style, obj, state = {}) {
  const out = { text: "", reasoning: "", done: false, usage: null, error: null };
  try {
    switch (style) {
      case "anthropic": {
        if (obj.type === "content_block_delta" && obj.delta?.text) out.text = obj.delta.text;
        if (obj.type === "content_block_delta" && obj.delta?.thinking) out.reasoning = obj.delta.thinking;
        if (obj.type === "message_delta" && obj.usage) out.usage = { completionTokens: obj.usage.output_tokens };
        if (obj.type === "message_start" && obj.message?.usage) out.usage = { promptTokens: obj.message.usage.input_tokens, ...(out.usage || {}) };
        if (obj.type === "message_stop") out.done = true;
        if (obj.type === "error") out.error = obj.error?.message || "anthropic error";
        break;
      }
      case "gemini": {
        const cand = obj.candidates?.[0];
        const parts = cand?.content?.parts || [];
        out.text = parts.filter((x) => !x.thought).map((x) => x.text || "").join("");
        out.reasoning = parts.filter((x) => x.thought).map((x) => x.text || "").join("");
        if (obj.usageMetadata) out.usage = { promptTokens: obj.usageMetadata.promptTokenCount, completionTokens: obj.usageMetadata.candidatesTokenCount };
        if (cand?.finishReason) out.done = true;
        break;
      }
      case "cohere": {
        if (obj.type === "content-delta") out.text = obj.delta?.message?.content?.text || "";
        if (obj.type === "message-end") {
          out.done = true;
          const u = obj.delta?.usage?.tokens;
          if (u) out.usage = { promptTokens: u.input_tokens, completionTokens: u.output_tokens };
        }
        break;
      }
      default: { // openai-сумісні (у т.ч. azure)
        const d = obj.choices?.[0];
        if (d?.delta?.content) out.text = d.delta.content;
        if (d?.message?.content && !d?.delta) out.text = d.message.content;
        // reasoning-моделі (DeepSeek, Qwen, GLM, o-серія): спершу «думки», потім відповідь
        out.reasoning = d?.delta?.reasoning_content || d?.delta?.reasoning || d?.message?.reasoning_content || d?.message?.reasoning || "";
        if (d?.finish_reason) out.done = true;
        if (obj.usage) out.usage = { promptTokens: obj.usage.prompt_tokens, completionTokens: obj.usage.completion_tokens };
        if (obj.error) out.error = obj.error.message || "provider error";
      }
    }
  } catch (e) { out.error = e.message; }
  return out;
}

export const PROVIDER_COUNT = PROVIDER_PRESETS.length;
