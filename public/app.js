// public/app.js — роутер, завантаження стану, дашборд
import { state, api, toast, closeModal, refreshProviders, refreshNiches, timeAgo, refreshProviderSelects } from "./core.js";
import { esc, num, ring, badge, usd } from "./ui.js";
import { LANGUAGES, REGIONS } from "./data/markets.js";
import { initHunt, renderRanking, setRankingData } from "./hunt.js";
import { initAnalysis } from "./analysis.js";
import { initPipeline, renderPipeline, renderHistory } from "./pipeline.js";
import { initProviders, renderProviders } from "./providers.js";
import { initRadar, renderRadarResults } from "./radar.js";
import { initSettings } from "./settings.js";

const VIEWS = {
  dashboard: renderDashboard,
  hunt: () => {},
  ranking: renderRanking,
  channel: () => {},
  gap: () => {},
  radar: () => {},
  video: () => {},
  pipeline: renderPipeline,
  history: renderHistory,
  providers: renderProviders,
  settings: () => {},
};

export function goto(view) {
  if (!VIEWS[view]) view = "dashboard";
  state.view = view;
  if (location.hash.slice(1) !== view) history.replaceState(null, "", "#" + view);
  document.querySelectorAll(".nav-item[data-view]").forEach((n) => n.classList.toggle("active", n.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
  try { VIEWS[view]?.(); } catch (e) { console.error(e); toast(e.message, "error"); }
  document.querySelector("main").scrollTop = 0;
}

// ---------------------------------------------------------------- ДАШБОРД
function statCard(value, label, hint = "") {
  return `<div class="stat"><b>${value}</b><span>${esc(label)}</span>${hint ? `<div class="tiny" style="margin-top:6px">${esc(hint)}</div>` : ""}</div>`;
}

async function renderDashboard() {
  const cfg = state.config || {};
  const ready = state.providers.filter((p) => p.configured && p.apiStyle !== "mock");
  const ytOn = !!state.sources && state.sources.mode !== "off";
  document.getElementById("dashStats").innerHTML =
    statCard(state.providers.length, "Провайдерів у каталозі", ready.length + " налаштовано") +
    statCard(state.niches.length, "Ніш у пайплайні", state.niches.filter((n) => n.status === "greenlit").length + " затверджено") +
    statCard(state.runs.length, "Запусків в історії") +
    statCard(ytOn ? "Увімкнено" : "Вимкнено", "Реальні дані YouTube", state.sources ? state.sources.label : "працює LLM-режим");

  const runs = state.runs.slice(0, 6);
  document.getElementById("dashRuns").innerHTML = runs.length ? runs.map((r) => `
    <div class="card hover" style="padding:12px;cursor:pointer" data-run="${esc(r.id)}">
      <div class="row" style="justify-content:space-between">
        <b style="font-size:13px">${esc(r.params?.seeds || r.params?.channel || r.params?.seed || r.params?.url || "автопошук")}</b>
        ${badge(r.status === "done" ? "готово" : r.status === "error" ? "помилка" : r.status, r.status === "done" ? "b-ok" : "b-warn")}
      </div>
      <div class="tiny" style="margin-top:6px">${timeAgo(r.createdAt)} · ${esc(r.type)} · ${usd(r.stats?.costUsd)} · ${num(r.stats?.calls)} викликів</div>
      ${r.summary?.best ? `<div class="muted" style="margin-top:7px">Топ: <b>${esc(r.summary.best)}</b></div>` : ""}
    </div>`).join("") : `<div class="muted">Ще немає запусків. Натисніть «Запустити полювання».</div>`;

  const best = [...state.niches].sort((a, b) => (b.riskAdjusted ?? b.score ?? 0) - (a.riskAdjusted ?? a.score ?? 0)).slice(0, 5);
  document.getElementById("dashNiches").innerHTML = best.length ? best.map((n) => `
    <div class="card hover" style="padding:12px;cursor:pointer;display:flex;gap:11px;align-items:center" data-open-niche="${esc(n.id)}">
      ${ring(n.riskAdjusted ?? n.score ?? 0, 44, 4)}
      <div><b style="font-size:13px">${esc(n.niche)}</b><div class="tiny">${esc(n.status)} · ${n.rpmEstimateUsd ? "RPM ~$" + num(n.rpmEstimateUsd, 1) : ""}</div></div>
    </div>`).join("") : `<div class="muted">Пайплайн порожній. Додайте ніші з ранжування.</div>`;
}

// ---------------------------------------------------------------- BOOT
async function boot() {
  // пункти з data-view перемикають екран; «Інфо» — звичайне посилання на сторінку довідки
  document.querySelectorAll(".nav-item[data-view]").forEach((n) => n.addEventListener("click", () => goto(n.dataset.view)));
  document.addEventListener("click", (e) => {
    const g = e.target.closest("[data-goto]");
    if (g) goto(g.dataset.goto);
  });
  document.getElementById("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  document.getElementById("btnShutdown").addEventListener("click", async () => {
    if (!confirm("Зупинити сервер Niche Radar?")) return;
    try { await api.post("/api/shutdown"); } catch {}
    document.body.innerHTML = '<div style="display:grid;place-items:center;height:100vh;font-family:-apple-system,sans-serif;color:#8b98b8;text-align:center;gap:12px"><div><h1 style="color:#eaf0ff">Niche Radar зупинено</h1><p>Вікно можна закрити. Запуск — ярлик «Niche Radar» на Робочому столі.</p></div></div>';
  });

  try {
    const [{ config, presets }, { providers }, sources] = await Promise.all([
      api.get("/api/config"), api.get("/api/providers"), api.get("/api/sources").catch(() => null),
    ]);
    state.config = config; state.presets = presets; state.providers = providers;
    state.sources = sources;
  } catch (e) { toast("Не вдалося завантажити конфіг: " + e.message, "error"); }

  const sel = document.getElementById("huntOutputLang");
  sel.innerHTML = LANGUAGES.map(([c, n]) => `<option value="${c}">${esc(n)} (${c})</option>`).join("");
  sel.value = state.config?.markets?.outputLang || "uk";

  document.getElementById("ytRegion").innerHTML = REGIONS.map(([c, n]) => `<option value="${c}">${esc(n)} (${c})</option>`).join("");
  document.getElementById("ytHl").innerHTML = LANGUAGES.map(([c, n]) => `<option value="${c}">${esc(n)} (${c})</option>`).join("");

  initHunt();
  initAnalysis();
  initPipeline();
  initProviders();
  initRadar();
  initSettings();
  refreshProviderSelects(); // списки провайдерів + підказки моделей (після initSettings, щоб покрити й матрицю маршрутів)
  renderProviders();
  await Promise.all([refreshNiches(), loadRuns()]);
  await renderDashboard();
  updateStatus();
  setInterval(updateStatus, 30000);
  window.addEventListener("hashchange", () => goto(location.hash.slice(1) || "dashboard"));
  await goto(location.hash.slice(1) || "dashboard");
}

async function loadRuns() {
  try { const { history } = await api.get("/api/runs"); state.runs = history || []; } catch { state.runs = []; }
}

export async function updateStatus() {
  try {
    const [health, q] = await Promise.all([api.get("/api/health"), api.get("/api/youtube/quota")]);
    document.getElementById("statusDot").className = "dot";
    const ready = state.providers.filter((p) => p.configured && p.apiStyle !== "mock").length;
    document.getElementById("statusText").textContent = ready
      ? (ready === 1 ? "1 провайдер готовий" : `${ready} провайдерів готові`)
      : "демо-режим (без ключів)";
    document.getElementById("quotaPill").textContent = q.enabled ? `YT-квота: ${q.used}/${q.dailyLimit}` : "YT: вимкнено";
  } catch {
    document.getElementById("statusDot").className = "dot off";
    document.getElementById("statusText").textContent = "сервер недоступний";
  }
}

export { loadRuns };
window.__nr = { state, goto, loadRuns };
boot();
