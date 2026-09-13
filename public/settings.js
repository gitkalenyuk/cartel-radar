// public/settings.js — маршрутизація, ваги, персони, YouTube, параметри запуску
import { state, api, toast, refreshProviders, fillProviderSelect } from "./core.js";
import { esc, num, LABELS } from "./ui.js";
import { renderPersonas } from "./hunt.js";

const TASKS = [
  ["discovery", "Розвідка ніш", "генерація ідей (масово, дешева модель)"],
  ["screening", "Скринінг", "оцінка кожного кандидата"],
  ["deepdive", "Глибокі досьє", "найрозумніша модель для синтезу"],
  ["copy", "Копірайтинг", "заголовки й тексти"],
  ["vision", "Прев'ю / vision", "модель із підтримкою зображень"],
];

const WEIGHT_HINTS = {
  demand: "Наскільки важливий обсяг попиту",
  competition: "Наскільки караємо жорстку конкуренцію",
  monetization: "Вага доходу (RPM, продукти)",
  novelty: "Вага свіжості кута",
  evergreen: "Чи має ніша жити роками",
  growth: "Швидкість зростання попиту",
  faceless: "Можливість працювати без обличчя",
  aiProducible: "Можливість автоматизувати продакшн",
  ease: "Легкість старту для новачка",
};

export function initSettings() {
  document.getElementById("btnSaveSettings").addEventListener("click", saveSettings);
  document.getElementById("btnReset").addEventListener("click", async () => {
    if (!confirm("Скинути всі налаштування до типових?")) return;
    await api.post("/api/config/reset");
    location.reload();
  });
  document.getElementById("btnClearNiches").addEventListener("click", async () => {
    if (!confirm("Видалити всі ніші з пайплайну?")) return;
    const { niches } = await api.get("/api/niches");
    for (const n of niches) await api.del("/api/niches/" + n.id);
    const r = await api.get("/api/niches");
    state.niches = r.niches;
    toast("Пайплайн очищено", "ok");
  });
  document.getElementById("btnYtQuota").addEventListener("click", async () => {
    const q = await api.get("/api/youtube/quota");
    document.getElementById("ytQuotaInfo").textContent = q.enabled
      ? `використано ${q.used} з ${q.dailyLimit} юнітів`
      : "YouTube API вимкнено";
  });

  // ---- джерело реальних даних: yt-dlp / API / гібрид ----
  document.getElementById("btnSrcUpdate")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "Оновлюю…";
    try {
      const r = await api.post("/api/sources/update", {});
      toast(r.ok ? "yt-dlp оновлено" : "Не вдалося оновити: " + (r.error || ""), r.ok ? "ok" : "error");
    } catch (err) { toast("Помилка оновлення: " + err.message, "error"); }
    btn.disabled = false; btn.textContent = "Оновити yt-dlp";
    await refreshSources();
  });

  document.getElementById("btnSrcCache")?.addEventListener("click", async () => {
    if (!confirm("Очистити кеш зібраних даних YouTube?")) return;
    const r = await api.post("/api/sources/clear-cache", {});
    toast(`Кеш очищено: видалено ${r.removed} файлів`, "ok");
    await refreshSources();
  });

  document.getElementById("ytMode")?.addEventListener("change", async (e) => {
    const mode = e.target.value;
    try {
      await api.post("/api/sources/mode", { mode });
      toast("Джерело даних: " + modeLabel(mode), "ok");
    } catch (err) { toast("Не вдалося змінити джерело: " + err.message, "error"); }
    await refreshSources();
  });
  const presets = {
    btnPresetFaceless: { faceless: 14, aiProducible: 12, ease: 10, demand: 16, competition: 14, monetization: 12, novelty: 10, evergreen: 8, growth: 6 },
    btnPresetHighRpm: { monetization: 24, demand: 18, competition: 14, evergreen: 12, novelty: 8, growth: 8, ease: 6, faceless: 6, aiProducible: 4 },
    btnPresetBeginner: { ease: 20, competition: 18, demand: 16, novelty: 12, monetization: 10, evergreen: 10, growth: 6, faceless: 4, aiProducible: 4 },
  };
  Object.entries(presets).forEach(([id, w]) => {
    document.getElementById(id)?.addEventListener("click", () => {
      drawWeights(w);
      toast("Пресет застосовано — не забудьте зберегти", "ok");
    });
  });
  renderSettings();
}

const modeLabel = (m) => ({ auto: "автоматично", ytdlp: "yt-dlp (без ключа)", api: "YouTube API", both: "гібрид yt-dlp + API", off: "вимкнено" }[m] || m);

/** Показує стан джерела реальних даних: наявність yt-dlp, кеш, квоту API. */
export async function refreshSources() {
  try {
    const s = await api.get("/api/sources");
    state.sources = s;
    const ytdlp = document.getElementById("srcYtdlp");
    if (ytdlp) {
      ytdlp.textContent = s.ytdlp ? `готовий (v${s.ytdlpVersion || "?"})` : "не знайдено";
      ytdlp.style.color = s.ytdlp ? "#35e08a" : "#ffb84d";
    }
    const cache = document.getElementById("srcCache");
    if (cache) cache.textContent = s.cache ? `${s.cache.files} файлів, ${(s.cache.bytes / 1048576).toFixed(1)} МБ` : "—";
    const quota = document.getElementById("srcQuota");
    if (quota) {
      quota.textContent = s.api
        ? `ключ є, використано ${s.quota?.used ?? 0} з ${s.quota?.dailyLimit ?? 10000}`
        : "ключа немає";
    }
  } catch { /* стан джерела не критичний для роботи */ }
}

export function renderSettings() {
  const cfg = state.config;
  if (!cfg) return;
  const sel = document.getElementById("huntProvider");
  fillProviderSelect(sel, { value: cfg.routing?.discovery?.provider || "" });

  document.getElementById("rtAuto").checked = cfg.routing?.auto !== false;
  document.getElementById("routingBox").innerHTML = TASKS.map(([id, name, hint]) => `
    <div style="border:1px solid var(--stroke);border-radius:11px;padding:11px">
      <div class="row" style="justify-content:space-between"><b style="font-size:13px">${esc(name)}</b><span class="tiny">${esc(hint)}</span></div>
      <div class="row" style="margin-top:8px;gap:8px">
        <select data-route-provider="${id}" style="flex:1.4"></select>
        <input data-route-model="${id}" placeholder="модель" style="flex:1" value="${esc(cfg.routing?.[id]?.model || "")}">
      </div>
    </div>`).join("");
  document.querySelectorAll("[data-route-provider]").forEach((s) =>
    fillProviderSelect(s, { value: cfg.routing?.[s.dataset.routeProvider]?.provider || "" }));

  const yt = cfg.youtube || {};
  // старі збірки писали "on" — тепер це режим «YouTube API»
  document.getElementById("ytMode").value = yt.mode === "on" ? "api" : (yt.mode || "auto");
  refreshSources();
  document.getElementById("ytKey").value = yt.apiKey || "";
  document.getElementById("ytRegion").value = yt.region || "US";
  document.getElementById("ytHl").value = yt.hl || "en";
  document.getElementById("ytSample").value = yt.sampleSize || 12;

  const run = cfg.run || {};
  const runFields = [
    ["concurrency", "Паралельність", 1, 16, 1], ["maxCandidates", "Кандидатів у роботі", 10, 300, 10],
    ["deepDiveCount", "Глибоких досьє", 1, 20, 1], ["breadthAgents", "Агентів розвідки", 1, 12, 1],
    ["temperature", "Температура", 0, 1.4, 0.05], ["maxTokens", "Ліміт токенів відповіді", 500, 32000, 500],
    ["costCapUsd", "Стоп-ліміт витрат ($)", 0, 100, 0.5], ["retries", "Повторів при помилці", 0, 5, 1],
  ];
  document.getElementById("runParams").innerHTML = runFields.map(([k, label, min, max, step]) => `
    <div><label>${esc(label)}</label><input type="number" data-run="${k}" min="${min}" max="${max}" step="${step}" value="${run[k] ?? ""}"></div>`).join("");

  drawWeights(cfg.scoring?.weights || {});
  renderPersonasEditor();
}

function drawWeights(weights) {
  const box = document.getElementById("weightsBox");
  box.innerHTML = Object.keys(LABELS).map((k) => `
    <div><label>${esc(LABELS[k])} · <b data-wv="${k}">${weights[k] ?? 0}</b></label>
      <input type="range" min="0" max="25" step="1" data-weight="${k}" value="${weights[k] ?? 0}">
      <div class="tiny">${esc(WEIGHT_HINTS[k] || "")}</div></div>`).join("");
  box.querySelectorAll("[data-weight]").forEach((r) =>
    r.addEventListener("input", () => { const b = box.querySelector(`[data-wv="${r.dataset.weight}"]`); if (b) b.textContent = r.value; }));
}

function renderPersonasEditor() {
  const box = document.getElementById("personaBox");
  box.innerHTML = (state.config.personas || []).map((p, i) => `
    <div style="border:1px solid var(--stroke);border-radius:11px;padding:11px">
      <div class="row" style="gap:10px">
        <input data-pname="${i}" value="${esc(p.name)}" style="flex:1">
        <label class="switch" style="margin:0"><input type="checkbox" data-pon="${i}" ${p.on !== false ? "checked" : ""}><span class="track"></span></label>
        <button class="btn-sm btn-danger" data-pdel="${i}">×</button>
      </div>
      <textarea data-pbrief="${i}" style="margin-top:9px;min-height:52px">${esc(p.brief)}</textarea>
    </div>`).join("") +
    `<button class="btn-sm" id="btnAddPersona">+ Додати персону</button>`;

  box.querySelectorAll("[data-pdel]").forEach((b) => b.addEventListener("click", () => {
    state.config.personas.splice(Number(b.dataset.pdel), 1);
    renderPersonasEditor();
  }));
  box.querySelectorAll("[data-pname],[data-pbrief]").forEach((i) => i.addEventListener("input", () => {
    const i2 = Number(i.dataset.pname ?? i.dataset.pbrief);
    if (i.dataset.pname != null) state.config.personas[i2].name = i.value;
    else state.config.personas[i2].brief = i.value;
  }));
  box.querySelectorAll("[data-pon]").forEach((c) => c.addEventListener("change", () => {
    state.config.personas[Number(c.dataset.pon)].on = c.checked;
  }));
  document.getElementById("btnAddPersona")?.addEventListener("click", () => {
    state.config.personas.push({ id: "custom" + Date.now(), name: "Нова персона", on: true, brief: "Опишіть, які ніші шукати." });
    renderPersonasEditor();
  });
}

function collectSettings() {
  const cfg = state.config;
  const routing = { ...(cfg.routing || {}), auto: document.getElementById("rtAuto").checked };
  document.querySelectorAll("[data-route-provider]").forEach((s) => {
    const id = s.dataset.routeProvider;
    routing[id] = { provider: s.value, model: document.querySelector(`[data-route-model="${id}"]`).value.trim() };
  });
  const run = {};
  document.querySelectorAll("[data-run]").forEach((i) => { const v = Number(i.value); if (!isNaN(v)) run[i.dataset.run] = v; });
  const weights = {};
  document.querySelectorAll("[data-weight]").forEach((r) => { weights[r.dataset.weight] = Number(r.value); });
  const youtube = {
    // "on" лишаємо для сумісності зі старими налаштуваннями
    mode: (() => { const m = document.getElementById("ytMode").value; return m === "on" ? "api" : m; })(),
    apiKey: document.getElementById("ytKey").value.trim(),
    region: document.getElementById("ytRegion").value,
    hl: document.getElementById("ytHl").value,
    sampleSize: Number(document.getElementById("ytSample").value) || 12,
  };
  const personas = (cfg.personas || []).map((p, i) => ({
    ...p,
    name: document.querySelector(`[data-pname="${i}"]`)?.value || p.name,
    brief: document.querySelector(`[data-pbrief="${i}"]`)?.value || p.brief,
    on: document.querySelector(`[data-pon="${i}"]`)?.checked ?? p.on,
  }));
  return { routing, run, scoring: { weights }, youtube, personas };
}

async function saveSettings() {
  const status = document.getElementById("settingsStatus");
  status.textContent = "зберігаю…";
  try {
    const patch = collectSettings();
    const { config } = await api.post("/api/config", patch);
    state.config = config;
    await refreshProviders();
    ["huntProvider", "chProvider", "gapProvider", "vidProvider", "thProvider"].forEach((id) => fillProviderSelect(document.getElementById(id)));
    renderPersonas();
    status.textContent = "збережено ✓";
    toast("Налаштування збережено", "ok");
    setTimeout(() => { status.textContent = ""; }, 3000);
  } catch (e) {
    status.textContent = "";
    toast("Помилка збереження: " + e.message, "error");
  }
}
