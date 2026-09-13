// public/core.js — стан, API-клієнт, тости, модалка, запуск завдань зі стрімом
import { esc } from "./ui.js";

export const state = {
  config: null, presets: [], providers: [], niches: [], runs: [], currentRun: null,
  hunt: { candidates: [], byName: new Map(), events: [] },
  settings: {}, view: "dashboard",
};

async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  get: (u) => req("GET", u),
  post: (u, b) => req("POST", u, b ?? {}),
  patch: (u, b) => req("PATCH", u, b ?? {}),
  del: (u) => req("DELETE", u),
};

// ---------------------------------------------------------------- тости
export function toast(msg, kind = "info", ms = 4200) {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = "toast " + (kind === "error" ? "err" : kind === "warn" ? "warn" : kind === "ok" ? "ok" : "");
  el.innerHTML = esc(msg);
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateX(20px)"; el.style.transition = ".3s"; setTimeout(() => el.remove(), 320); }, ms);
}

// ---------------------------------------------------------------- модалка
export function openModal(html) {
  document.getElementById("modalBody").innerHTML = html;
  document.getElementById("modal").classList.add("on");
}
export function closeModal() { document.getElementById("modal").classList.remove("on"); }

// ---------------------------------------------------------------- запуск завдань
/**
 * Запускає серверне завдання й підписується на стрім подій.
 * onEvent(ev) викликається на кожну подію; повертає {jobId, cancel}.
 */
export async function runJob(type, params, onEvent) {
  const { jobId } = await api.post("/api/runs", { type, params });
  const es = new EventSource(`/api/runs/${jobId}/events`);
  let finished = false;
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    try { onEvent?.(ev); } catch (e) { console.error(e); }
    if (ev.t === "end") { finished = true; es.close(); }
  };
  es.onerror = () => { if (!finished) { /* стрім закрився — історія доступна через /api/runs */ } };
  return { jobId, cancel: () => api.post(`/api/runs/${jobId}/cancel`), close: () => es.close() };
}

export async function resumeJob(jobId, onEvent) {
  const es = new EventSource(`/api/runs/${jobId}/events`);
  es.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } onEvent?.(ev); if (ev.t === "end") es.close(); };
  return { jobId, close: () => es.close() };
}

// ---------------------------------------------------------------- довідники
export function fillProviderSelect(select, { includeAuto = true, value } = {}) {
  if (!select) return;
  const ready = state.providers.filter((p) => p.configured);
  const others = state.providers.filter((p) => !p.configured);
  select.innerHTML =
    (includeAuto ? `<option value="">Авто (${esc(state.config?.routing?.auto === false ? "як у налаштуваннях" : "перший налаштований")})</option>` : "") +
    ready.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.defaultModel || "—")}</option>`).join("") +
    others.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (не налаштовано)</option>`).join("");
  // помічаємо тих, чия перевірка з'єднання провалилась
  select.querySelectorAll("option").forEach((o) => {
    const prov = state.providers.find((x) => x.id === o.value);
    if (prov && prov.testOk === false) o.textContent += " · не відповідає";
  });
  if (value) select.value = value;
  else if (!select.value && ready.length) select.value = "";
}

export function providerById(id) { return state.providers.find((p) => p.id === id) || null; }

export function timeAgo(ts) {
  if (!ts) return "—";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "щойно";
  if (s < 3600) return Math.floor(s / 60) + " хв тому";
  if (s < 86400) return Math.floor(s / 3600) + " год тому";
  return new Date(ts).toLocaleDateString("uk-UA");
}

export function download(filename, text, type = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const PROVIDER_SELECTS = [["huntProvider", "huntModel"], ["chProvider", "chModel"], ["gapProvider", "gapModel"], ["thProvider", "thModel"], ["vidProvider", "vidModel"]];

/** Дропдаун + поле моделі: моделі підставляються з картки провайдера. */
export function syncModelPicker(select, input) {
  if (!select || !input) return;
  const dlId = "dl-" + input.id;
  let dl = document.getElementById(dlId);
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = dlId;
    document.body.appendChild(dl);
  }
  const prov = select.value ? providerById(select.value) : state.providers.find((p) => p.ready);
  const models = (prov?.models || []).filter(Boolean);
  dl.innerHTML = models.map((m) => `<option value="${esc(m)}"></option>`).join("");
  input.setAttribute("list", dlId);
  if (prov?.defaultModel && models.includes(prov.defaultModel)) {
    input.placeholder = "Авто: " + prov.defaultModel;
  } else if (models.length) {
    input.placeholder = "модель (" + models.length + " варіантів)";
  } else {
    input.placeholder = "модель (необовʼязково)";
  }
  if (!select.dataset.pickerWired) {
    select.dataset.pickerWired = "1";
    select.addEventListener("change", () => {
      input.value = "";
      syncModelPicker(select, input);
    });
  }
}

/** Перемальовує кожен список провайдерів (раніше вони лишались застарілими з моменту старту). */
export function refreshProviderSelects() {
  for (const [sid, mid] of PROVIDER_SELECTS) {
    const s = document.getElementById(sid);
    if (!s) continue;
    fillProviderSelect(s, { value: s.value });
    syncModelPicker(s, document.getElementById(mid));
  }
  document.querySelectorAll("[data-route-provider]").forEach((s) => {
    fillProviderSelect(s, { value: s.value });
    syncModelPicker(s, document.querySelector(`[data-route-model="${s.dataset.routeProvider}"]`));
  });
}

export async function refreshProviders() {
  const { providers } = await api.get("/api/providers");
  state.providers = providers;
  refreshProviderSelects();
  return providers;
}

export async function refreshNiches() {
  const { niches } = await api.get("/api/niches");
  state.niches = niches;
  return niches;
}
