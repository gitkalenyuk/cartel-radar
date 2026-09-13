// public/hunt.js — полювання: конфіг запуску, живий стрім, ранжування
import { state, api, runJob, toast, fillProviderSelect, resumeJob } from "./core.js";
import { esc, num, ring, badge, nicheCard, usd, radar, factorBars } from "./ui.js";
import { LANGUAGES, REGIONS } from "./data/markets.js";
import { openNicheModal } from "./detail.js";

const STAGES = [
  ["breadth", "Розвідка", "агенти пропонують ніші"],
  ["screening", "Скринінг", "паралельні оцінки"],
  ["reality", "Перевірка", "реальні дані YouTube"],
  ["deepdive", "Досьє", "глибокий аналіз"],
  ["done", "Ранжування", "готовий список"],
];

let activeRun = null;
const pickedLangs = new Set(["en"]);
const pickedRegions = new Set(["US", "GB", "DE"]);

export const ranking = { data: [], sort: "score", filter: "" };

export function initHunt() {
  // мови
  const langBox = document.getElementById("huntLangs");
  const renderLangs = () => {
    langBox.innerHTML = LANGUAGES.map(([c, n]) =>
      `<div class="chip ${pickedLangs.has(c) ? "on" : ""}" data-lang="${c}">${esc(n)}</div>`).join("");
  };
  langBox.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-lang]");
    if (!chip) return;
    const c = chip.dataset.lang;
    if (pickedLangs.has(c)) pickedLangs.delete(c); else pickedLangs.add(c);
    if (!pickedLangs.size) pickedLangs.add("en");
    renderLangs();
    syncSearch();
  });
  renderLangs();
  document.getElementById("btnAllLangs")?.addEventListener("click", () => { LANGUAGES.forEach(([c]) => pickedLangs.add(c)); renderLangs(); });

  // країни
  const regBox = document.getElementById("huntRegions");
  const renderRegions = () => {
    const show = [...REGIONS].slice(0, 24);
    regBox.innerHTML = show.map(([c, n]) =>
      `<div class="chip ${pickedRegions.has(c) ? "on" : ""}" data-region="${c}" title="${esc(n)}">${c}</div>`).join("") +
      (REGIONS.length > 24 ? `<div class="chip" id="moreRegions">+${REGIONS.length - 24} ще…</div>` : "");
  };
  regBox.addEventListener("click", (e) => {
    if (e.target.id === "moreRegions") {
      regBox.innerHTML = REGIONS.map(([c, n]) => `<div class="chip ${pickedRegions.has(c) ? "on" : ""}" data-region="${c}" title="${esc(n)}">${c}</div>`).join("");
      return;
    }
    const chip = e.target.closest("[data-region]");
    if (!chip) return;
    const c = chip.dataset.region;
    if (pickedRegions.has(c)) pickedRegions.delete(c); else pickedRegions.add(c);
    if (!pickedRegions.size) pickedRegions.add("US");
    renderRegions();
    syncSearch();
  });
  renderRegions();
  document.getElementById("btnAllRegions").addEventListener("click", () => { REGIONS.forEach(([c]) => pickedRegions.add(c)); renderRegions(); syncSearch(); });
  document.getElementById("btnTopRegions").addEventListener("click", () => { pickedRegions.clear(); ["US", "GB", "DE", "CA", "AU"].forEach((c) => pickedRegions.add(c)); renderRegions(); syncSearch(); });
  document.getElementById("btnClearRegions").addEventListener("click", () => { pickedRegions.clear(); pickedRegions.add("US"); renderRegions(); syncSearch(); });

  // персони
  renderPersonas();
  // повзунки
  const bind = (id, label, fmt = (v) => v) => {
    const el = document.getElementById(id);
    el.addEventListener("input", () => { document.getElementById(label).textContent = fmt(el.value); });
    document.getElementById(label).textContent = fmt(el.value);
  };
  bind("huntCount", "lblCount");
  bind("huntDeep", "lblDeep");
  bind("huntConc", "lblConc");
  bind("huntReal", "lblReal");

  document.getElementById("btnHunt").addEventListener("click", startHunt);
  document.getElementById("btnCancel").addEventListener("click", () => { activeRun?.cancel(); toast("Скасування надіслано", "warn"); });

  document.getElementById("rankSort").addEventListener("change", (e) => { ranking.sort = e.target.value; renderRanking(); });
  document.getElementById("rankFilter").addEventListener("input", (e) => { ranking.filter = e.target.value.toLowerCase(); renderRanking(); });
  document.getElementById("btnSaveAll").addEventListener("click", async () => {
    let added = 0;
    for (const n of ranking.data.slice(0, 40)) {
      try { const r = await api.post("/api/niches", n); if (!r.duplicate) added++; } catch {}
    }
    await api.get("/api/niches").then(({ niches }) => { state.niches = niches; });
    toast(`Додано в пайплайн: ${added}`, "ok");
  });
  document.getElementById("rankList").addEventListener("click", (e) => {
    const card = e.target.closest("[data-niche]");
    if (card) {
      const item = ranking.data.find((n) => n.niche === card.dataset.niche);
      if (item) openNicheModal(item);
    }
  });
}

export function renderPersonas() {
  const box = document.getElementById("huntPersonas");
  if (!box || !state.config) return;
  box.innerHTML = (state.config.personas || []).map((p, i) => `
    <label class="switch" style="justify-content:space-between">
      <span><b style="font-size:12.5px">${esc(p.name)}</b><div class="tiny" style="max-width:430px;margin-top:3px">${esc(p.brief)}</div></span>
      <input type="checkbox" data-persona="${i}" ${p.on !== false ? "checked" : ""}><span class="track"></span>
    </label>`).join("");
  box.querySelectorAll("[data-persona]").forEach((cb) => cb.addEventListener("change", async () => {
    const idx = Number(cb.dataset.persona);
    state.config.personas[idx].on = cb.checked;
    try { await api.post("/api/config", { personas: state.config.personas }); }
    catch (e) { toast("Не зберігається: " + e.message, "error"); }
  }));
}

function syncSearch() {
  const first = document.getElementById("chInput");
  void first;
}

function setSteps(stage) {
  const order = STAGES.map((s) => s[0]);
  const current = order.indexOf(stage);
  document.getElementById("huntSteps").innerHTML = STAGES.map(([id, name, hint], i) => `
    <div class="step ${i < current ? "done" : i === current ? "active" : ""}">
      <b>${esc(name)}</b><span class="tiny">${esc(hint)}</span>
    </div>`).join("");
}

function logLine(ev) {
  const box = document.getElementById("huntConsole");
  const cls = ev.level === "warn" ? "warn" : ev.level === "err" ? "err" : ev.level === "ok" ? "ok" : "info";
  const line = document.createElement("div");
  line.className = "l";
  line.innerHTML = `<span class="ts">${new Date(ev.ts || Date.now()).toLocaleTimeString("uk-UA")}</span><span class="${cls}">${esc(ev.msg)}</span>`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 400) box.removeChild(box.firstChild);
}

export async function startHunt() {
  const params = {
    seeds: document.getElementById("huntSeeds").value,
    langs: [...pickedLangs],
    regions: [...pickedRegions],
    outputLang: document.getElementById("huntOutputLang").value,
    provider: document.getElementById("huntProvider").value || undefined,
    model: document.getElementById("huntModel").value || undefined,
    maxCandidates: Number(document.getElementById("huntCount").value),
    deepDiveCount: Number(document.getElementById("huntDeep").value),
    concurrency: Number(document.getElementById("huntConc").value),
    realityChecks: Number(document.getElementById("huntReal").value),
  };
  state.hunt = { candidates: [], byName: new Map(), events: [] };
  ranking.data = [];
  document.getElementById("huntRun").style.display = "block";
  document.getElementById("huntConsole").innerHTML = "";
  document.getElementById("huntStream").innerHTML = "";
  document.getElementById("huntSummary").innerHTML = '<div class="muted">Запуск виконується…</div>';
  document.getElementById("btnHunt").disabled = true;
  document.getElementById("btnCancel").style.display = "inline-flex";
  document.getElementById("huntStatus").textContent = "працюю…";
  setSteps("breadth");

  try {
    activeRun = await runJob("hunt", params, handleHuntEvent);
    state.currentRun = activeRun.jobId;
  } catch (e) {
    toast("Не вдалося запустити: " + e.message, "error");
    document.getElementById("btnHunt").disabled = false;
    document.getElementById("btnCancel").style.display = "none";
  }
}

function streamCard(c, kind = "new") {
  const el = document.createElement("div");
  el.className = "card";
  el.style.padding = "9px 11px";
  el.style.cursor = "pointer";
  el.dataset.niche = c.niche;
  const score = c.riskAdjusted ?? c.score;
  el.innerHTML = `<div class="row" style="justify-content:space-between;gap:10px">
      <span style="font-size:12.5px;line-height:1.35">${esc(c.niche)}</span>
      <span style="flex:0 0 auto">${score != null ? `<b style="color:#b6ff3d;font-family:var(--mono)">${Number(score).toFixed(1)}</b>` : `<span class="tiny">${kind === "dossier" ? "досьє" : "новий"}</span>`}</span>
    </div>`;
  el.addEventListener("click", () => openNicheModal(state.hunt.byName.get(c.niche) || c));
  return el;
}

function handleHuntEvent(ev) {
  switch (ev.t) {
    case "stage":
      setSteps(ev.stage);
      logLine({ msg: ev.label + (ev.route ? ` · ${ev.route.providerId}/${ev.route.model}` : ""), level: "ok", ts: ev.ts });
      break;
    case "log": logLine(ev); break;
    case "candidate_new": {
      const box = document.getElementById("huntStream");
      const card = streamCard(ev.candidate, "new");
      box.appendChild(card);
      box.scrollTop = box.scrollHeight;
      while (box.children.length > 220) box.removeChild(box.firstChild);
      break;
    }
    case "candidate_scored": {
      state.hunt.byName.set(ev.candidate.niche, ev.candidate);
      const box = document.getElementById("huntStream");
      const old = [...box.children].find((c) => c.dataset.niche === ev.candidate.niche);
      const fresh = streamCard(ev.candidate);
      if (old) box.replaceChild(fresh, old); else box.appendChild(fresh);
      if (box.children.length > 220) box.removeChild(box.firstChild);
      break;
    }
    case "candidate_dossier": {
      state.hunt.byName.set(ev.candidate.niche, ev.candidate);
      const box = document.getElementById("huntStream");
      const old = [...box.children].find((c) => c.dataset.niche === ev.candidate.niche);
      const fresh = streamCard(ev.candidate, "dossier");
      if (old) box.replaceChild(fresh, old);
      break;
    }
    case "progress":
      document.getElementById("statCost").textContent = usd(ev.stats?.costUsd);
      document.getElementById("statCalls").textContent = num(ev.stats?.calls) + " викликів";
      document.getElementById("statTokens").textContent = num((ev.stats?.promptTokens || 0) + (ev.stats?.completionTokens || 0)) + " токенів";
      if (ev.done != null && ev.total) document.getElementById("huntStatus").textContent = `скринінг ${ev.done}/${ev.total}…`;
      break;
    case "summary":
      renderSummary(ev.summary);
      break;
    case "result": {
      const list = ev.result?.niches || [];
      ranking.data = list;
      state.hunt.results = list;
      logLine({ msg: `Готово: ${list.length} ніш у ранжуванні`, level: "ok", ts: ev.ts });
      renderRanking();
      break;
    }
    case "error":
      logLine({ msg: ev.msg, level: "err", ts: ev.ts });
      toast("Помилка запуску: " + ev.msg, "error", 8000);
      break;
    case "end":
      document.getElementById("btnHunt").disabled = false;
      document.getElementById("btnCancel").style.display = "none";
      document.getElementById("huntStatus").textContent = ev.status === "done" ? "завершено" : ev.status === "cancelled" ? "скасовано" : "помилка";
      document.getElementById("statCost").textContent = usd(ev.stats?.costUsd);
      import("./app.js").then((m) => m.loadRuns());
      break;
  }
}

function renderSummary(s) {
  if (!s) return;
  document.getElementById("huntSummary").innerHTML = `
    <div class="grid g4">
      <div class="stat"><b>${num(s.totalCandidates)}</b><span>кандидатів знайдено</span></div>
      <div class="stat"><b>${num(s.screened)}</b><span>оцінено</span></div>
      <div class="stat"><b>${num(s.withReality)}</b><span>перевірено по YouTube</span></div>
      <div class="stat"><b>${usd(s.costUsd)}</b><span>вартість запуску</span></div>
    </div>
    ${s.top?.length ? `<h3 style="margin-top:16px">Топ-3 ніші</h3><ul class="tight">${s.top.map((t, i) => `<li><b>${i + 1}. ${esc(t.niche)}</b> — оцінка ${t.score}${t.rpm ? ` · RPM ~$${t.rpm}` : ""}</li>`).join("")}</ul>` : ""}
    ${s.youtubeQuota ? `<div class="tiny" style="margin-top:8px">Квота YouTube використана: ${s.youtubeQuota.used}/${s.youtubeQuota.dailyLimit}</div>` : ""}`;
}

// ---------------------------------------------------------------- РАНЖУВАННЯ
export function setRankingData(list) { ranking.data = list || []; }

let rankingLoaded = false;

export async function renderRanking() {
  const box = document.getElementById("rankList");
  if (!box) return;
  if (!ranking.data.length && !rankingLoaded) {
    rankingLoaded = true;
    try {
      const { history } = await api.get("/api/runs");
      const last = (history || []).find((r) => r.type === "hunt" && r.status === "done");
      if (last) {
        const { job } = await api.get("/api/runs/" + last.id);
        if (job?.result?.niches?.length) {
          ranking.data = job.result.niches;
          box.innerHTML = `<div class="card muted">Показано результат останнього полювання (${new Date(last.createdAt).toLocaleString("uk-UA")}). Запустіть нове — і список оновиться.</div>`;
        }
      }
    } catch {}
  }
  const sortKey = ranking.sort;
  const invert = sortKey === "competitionScore";
  let list = [...ranking.data];
  if (ranking.filter) list = list.filter((n) => JSON.stringify(n).toLowerCase().includes(ranking.filter));
  list.sort((a, b) => {
    const va = a[sortKey] ?? a.parts?.[sortKey] ?? 0, vb = b[sortKey] ?? b.parts?.[sortKey] ?? 0;
    return invert ? va - vb : vb - va;
  });
  document.getElementById("rankCount").textContent = list.length ? `${list.length} ніш` : "";
  box.innerHTML = list.length
    ? list.map((n, i) => nicheCard(n, i + 1)).join("")
    : `<div class="card muted">Тут з'являться результати після полювання. Перейдіть у вкладку «Полювання».</div>`;
}
