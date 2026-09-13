// public/providers.js — каталог провайдерів: акордеон, чернетки значень, точкові оновлення
import { state, api, toast, refreshProviders, openModal, closeModal } from "./core.js";
import { esc, badge } from "./ui.js";

let filter = { q: "", cat: "", onlyReady: false };
let openId = null;                 // який провайдер розгорнуто
const drafts = new Map();          // id -> { key, base, models, fields, apiVersion } — не втрачаємо введене

const STYLE_LABEL = { openai: "OpenAI-сумісний", anthropic: "Anthropic", gemini: "Gemini", cohere: "Cohere", azure: "Azure", mock: "Демо-рушій" };

export function initProviders() {
  const search = document.getElementById("provSearch");
  let t = null;
  search.addEventListener("input", (e) => {
    clearTimeout(t);
    const v = e.target.value.toLowerCase();
    t = setTimeout(() => { filter.q = v; renderProviders(); }, 200);   // без перемальовування на кожну літеру
  });
  document.getElementById("provCat").addEventListener("change", (e) => { filter.cat = e.target.value; renderProviders(); });
  document.getElementById("provOnlyReady").addEventListener("change", (e) => { filter.onlyReady = e.target.checked; renderProviders(); });
  document.getElementById("btnAddProvider").addEventListener("click", openCustomProvider);

  // одна делегована обробка на весь список — жодних повторних навішувань
  document.getElementById("provList").addEventListener("click", (e) => {
    const head = e.target.closest("[data-head]");
    if (!head) return;
    if (e.target.closest(".switch")) return;
    const id = head.closest("[data-prov]").dataset.prov;
    openId = openId === id ? null : id;
    renderProviders();
  });
}

function catOptions() {
  const sel = document.getElementById("provCat");
  const cats = [...new Set(state.providers.map((p) => p.category))];
  sel.innerHTML = '<option value="">Усі категорії</option>' + cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
}

function visibleList() {
  let list = state.providers;
  if (filter.q) list = list.filter((p) => (p.name + p.id + p.baseURL).toLowerCase().includes(filter.q));
  if (filter.cat) list = list.filter((p) => p.category === filter.cat);
  if (filter.onlyReady) list = list.filter((p) => p.configured && p.apiStyle !== "mock");
  return list;
}

export function renderProviders() {
  const box = document.getElementById("provList");
  if (!box || !state.providers.length) return;
  if (!document.getElementById("provCat").options.length) catOptions();
  const list = visibleList();
  document.getElementById("provCount").textContent = `${list.length} з ${state.providers.length}`;
  box.innerHTML = list.map(cardHTML).join("");
  const opened = box.querySelector(`[data-prov="${openId}"] .prov-body input`);
  if (opened) opened.focus({ preventScroll: true });
}

function valueOf(p, field) {
  const d = drafts.get(p.id);
  if (d && d[field] !== undefined) return d[field];
  if (field === "key") return p.hasKey ? "••••••••••••" : "";
  if (field === "base") return p.baseURL || "";
  if (field === "models") return (p.models || []).join(", ");
  if (field === "apiVersion") return p.apiVersion || "";
  return "";
}

function draft(p, field, value) {
  const d = drafts.get(p.id) || {};
  d[field] = value;
  drafts.set(p.id, d);
}

function cardHTML(p) {
  const open = p.id === openId;
  const dirty = drafts.has(p.id);
  return `
  <div class="card prov ${p.configured ? "glow" : ""} ${open ? "is-open" : ""}" data-prov="${esc(p.id)}">
    <div class="prov-head" data-head>
      <div class="prov-title">
        <b>${esc(p.name)}</b>
        <div class="row" style="gap:6px;margin-top:6px">
          ${badge(p.category, "b-mute")}
          ${badge(STYLE_LABEL[p.apiStyle] || p.apiStyle, "b-info")}
          ${p.ready ? badge("готовий до роботи", "b-ok") : p.hasKey ? badge("ключ є", "b-ok") : badge(p.keyRequired ? "потрібен ключ" : "без ключа", "b-warn")}
          ${p.warn ? badge(p.warn, "b-warn") : ""}
          ${dirty ? badge("не збережено", "b-warn") : ""}
        </div>
      </div>
      <div class="row" style="gap:10px;flex-wrap:nowrap">
        <label class="switch" title="Увімкнено/вимкнено"><input type="checkbox" data-toggle ${p.enabled ? "checked" : ""}><span class="track"></span></label>
        <span class="chev">${open ? "▲" : "▼"}</span>
      </div>
    </div>
    ${open ? `
    <div class="prov-body">
      ${p.notes ? `<div class="tiny" style="margin:0 0 12px;line-height:1.5">${esc(p.notes)}</div>` : ""}
      <div class="grid g2" style="gap:11px">
        <div class="field"><label>API-ключ${p.keyUrl ? ` · <a href="${esc(p.keyUrl)}" target="_blank" style="color:#9be9f6">взяти ключ</a>` : ""}${p.hasKey ? ` · <span class="tiny" style="color:#35e08a">збережено</span> · <a href="#" data-clearkey style="color:#ffb3c1">прибрати</a>` : ""}</label>
          <input type="password" data-key autocomplete="off" spellcheck="false" placeholder="${p.keyRequired ? "вставте ключ сюди" : "не потрібен"}" value="${esc(valueOf(p, "key"))}" ${p.hasKey ? 'data-masked="1"' : ""}></div>
        <div class="field"><label>Base URL</label><input data-base value="${esc(valueOf(p, "base"))}"></div>
        ${Object.entries(p.fields || {}).map(([k, v]) => `<div class="field"><label>${esc(k)}</label><input data-field="${esc(k)}" value="${esc((drafts.get(p.id)?.fields?.[k]) ?? v)}"></div>`).join("")}
        ${p.apiStyle === "azure" ? `<div class="field"><label>api-version</label><input data-apiversion value="${esc(valueOf(p, "apiVersion"))}"></div>` : ""}
        <div class="field" style="grid-column:1/-1"><label>Моделі (через кому; перша — типова) · <span class="tiny">тисніть «Підтягнути моделі», щоб отримати актуальні</span></label><input data-models value="${esc(valueOf(p, "models"))}"></div>
      </div>
      <div class="row" style="gap:7px;flex-wrap:wrap;margin-top:12px">
        <button class="btn-sm btn-primary" data-save>Зберегти</button>
        <button class="btn-sm" data-test>Перевірити з'єднання</button>
        <button class="btn-sm" data-fetch>Підтягнути моделі</button>
        ${p.docs ? `<a class="btn btn-sm" href="${esc(p.docs)}" target="_blank" style="text-decoration:none">Доки</a>` : ""}
        ${p.custom ? `<button class="btn-sm btn-danger" data-del>Видалити</button>` : ""}
      </div>
      <div class="tiny" data-result style="margin-top:9px"></div>
    </div>` : ""}
  </div>`;
}

// ---------- події всередині відкритої картки (делеговано, без перемальовування) ----------
document.addEventListener("focusin", (e) => {
  // збережений ключ показуємо маскою і ВИДІЛЯЄМО: набраний текст одразу його замінить,
  // а сам ключ більше не «зникає» (раніше поле просто очищалось і здавалось, що його стерли)
  if (e.target.matches?.(".prov [data-key][data-masked]")) e.target.select();
});

document.addEventListener("keydown", (e) => {
  const el = e.target;
  if (!el.matches?.(".prov [data-key][data-masked]")) return;
  const printable = e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;
  if (printable) { el.value = ""; el.removeAttribute("data-masked"); }
});

document.addEventListener("input", (e) => {
  const card = e.target.closest?.(".prov.is-open[data-prov]");
  if (!card) return;
  const p = state.providers.find((x) => x.id === card.dataset.prov);
  if (!p) return;
  if (e.target.matches("[data-key]")) draft(p, "key", e.target.value.replace(/•+/g, ""));
  else if (e.target.matches("[data-base]")) draft(p, "base", e.target.value);
  else if (e.target.matches("[data-models]")) draft(p, "models", e.target.value);
  else if (e.target.matches("[data-apiversion]")) draft(p, "apiVersion", e.target.value);
  else if (e.target.matches("[data-field]")) {
    const d = drafts.get(p.id) || { fields: {} };
    d.fields = { ...(d.fields || {}), [e.target.dataset.field]: e.target.value };
    drafts.set(p.id, d);
  }
});

document.addEventListener("change", async (e) => {
  if (!e.target.matches(".prov [data-toggle]")) return;
  const card = e.target.closest("[data-prov]");
  const id = card.dataset.prov;
  try {
    await api.post("/api/providers/save", { id, settings: { enabled: e.target.checked } });
    const p = state.providers.find((x) => x.id === id);
    if (p) p.enabled = e.target.checked;
  } catch (err) { toast(err.message, "error"); e.target.checked = !e.target.checked; }
});

document.addEventListener("click", async (e) => {
  const card = e.target.closest(".prov[data-prov]");
  if (!card) return;
  const id = card.dataset.prov;
  const p = state.providers.find((x) => x.id === id);
  if (!p) return;
  const out = (msg, ok) => { const el = card.querySelector("[data-result]"); if (el) el.innerHTML = ok ? `<span style="color:#35e08a">${esc(msg)}</span>` : `<span style="color:#ff8fa3">${esc(msg)}</span>`; };

  const collect = () => {
    const rawKey = card.querySelector("[data-key]").value.trim();
    const fields = {};
    card.querySelectorAll("[data-field]").forEach((i) => { fields[i.dataset.field] = i.value; });
    return {
      // маска або порожнє поле = «залишити наявний ключ як є»
      apiKey: (rawKey.includes("••") || rawKey === "") ? undefined : rawKey,
      baseURL: card.querySelector("[data-base]").value.trim(),
      models: card.querySelector("[data-models]").value.split(",").map((s) => s.trim()).filter(Boolean),
      fields,
      apiVersion: card.querySelector("[data-apiversion]")?.value.trim(),
      enabled: card.querySelector("[data-toggle]").checked,
    };
  };

  // ЗБЕРЕГТИ
  const saveBtn = e.target.closest("[data-save]");
  if (saveBtn) {
    const v = collect();
    const settings = { baseURL: v.baseURL, models: v.models, defaultModel: v.models[0] || "", enabled: v.enabled, fields: v.fields };
    if (v.apiKey !== undefined) settings.apiKey = v.apiKey;
    if (v.apiVersion) settings.apiVersion = v.apiVersion;
    try {
      await api.post("/api/providers/save", { id, settings });
      drafts.delete(id);
      await refreshProviders();
      const node = document.querySelector(`.prov[data-prov="${id}"]`);
      const fresh = state.providers.find((x) => x.id === id);
      if (node && fresh) node.outerHTML = cardHTML(fresh);   // оновлюємо РІВНО одну картку, решта не рухається
      toast("Збережено: " + p.name, "ok");
    } catch (err) { out(err.message, false); }
    return;
  }

  // ПЕРЕВІРИТИ
  const testBtn = e.target.closest("[data-test]");
  if (testBtn) {
    testBtn.disabled = true; const label = testBtn.textContent; testBtn.textContent = "Перевіряю…";
    out("надсилаю тестовий запит…", true);
    try {
      const v = collect();
      const settings = { baseURL: v.baseURL, models: v.models, defaultModel: v.models[0] || "", fields: v.fields };
      if (v.apiKey !== undefined) settings.apiKey = v.apiKey;
      await api.post("/api/providers/save", { id, settings });
      drafts.delete(id);
      await refreshProviders();
      const res = await api.post("/api/providers/test", { id });
      if (res.ok) { out(`Працює ✓ ${res.model} · ${res.ms} мс · «${res.sample}»`, true); toast("З'єднання працює: " + p.name, "ok"); }
      else out("Помилка: " + res.error, false);
      const node = document.querySelector(`.prov[data-prov="${id}"]`);
      const fresh = state.providers.find((x) => x.id === id);
      if (node && fresh && !node.classList.contains("is-open")) node.outerHTML = cardHTML(fresh);
    } catch (err) { out(err.message, false); }
    testBtn.disabled = false; testBtn.textContent = label;
    return;
  }

  // ПІДТЯГНУТИ МОДЕЛІ
  const fetchBtn = e.target.closest("[data-fetch]");
  if (fetchBtn) {
    fetchBtn.disabled = true; const label = fetchBtn.textContent; fetchBtn.textContent = "Тягну…";
    try {
      const v = collect();
      const settings = { baseURL: v.baseURL, fields: v.fields };
      if (v.apiKey !== undefined) settings.apiKey = v.apiKey;
      await api.post("/api/providers/save", { id, settings });
      await refreshProviders();
      const res = await api.post("/api/providers/models", { id });
      if (res.ok) {
        card.querySelector("[data-models]").value = res.models.slice(0, 80).join(", ");
        draft(p, "models", card.querySelector("[data-models]").value);
        out(`Знайдено ${res.models.length} моделей — натисніть «Зберегти»`, true);
      } else out("Помилка: " + res.error, false);
    } catch (err) { out(err.message, false); }
    fetchBtn.disabled = false; fetchBtn.textContent = label;
    return;
  }

  // ПРИБРАТИ КЛЮЧ
  if (e.target.closest("[data-clearkey]")) {
    e.preventDefault();
    if (!confirm("Прибрати збережений ключ цього провайдера?")) return;
    try {
      await api.post("/api/providers/save", { id, settings: { apiKey: "" } });
      drafts.delete(id);
      await refreshProviders();
      const node = document.querySelector(`.prov[data-prov="${id}"]`);
      const fresh = state.providers.find((x) => x.id === id);
      if (node && fresh) node.outerHTML = cardHTML(fresh);
      toast("Ключ прибрано", "ok");
    } catch (err) { out(err.message, false); }
    return;
  }

  // ВИДАЛИТИ
  const delBtn = e.target.closest("[data-del]");
  if (delBtn) {
    if (!confirm("Видалити цього провайдера?")) return;
    try {
      await api.post("/api/providers/delete", { id });
      await refreshProviders();
      drafts.delete(id);
      if (openId === id) openId = null;
      card.remove();                                  // прибираємо лише цю картку
      document.getElementById("provCount").textContent = `${visibleList().length} з ${state.providers.length}`;
    } catch (err) { out(err.message, false); }
  }
});

function openCustomProvider() {
  openModal(`
    <h2 style="font-size:20px;margin-bottom:14px">Свій провайдер</h2>
    <div class="grid g2" style="gap:14px">
      <div class="field"><label>Назва</label><input id="cpName" placeholder="Мій сервер"></div>
      <div class="field"><label>ID (латиниця, без пробілів)</label><input id="cpId" placeholder="my-server"></div>
      <div class="field"><label>Стиль API</label><select id="cpStyle">
        <option value="openai">OpenAI-сумісний (/chat/completions)</option>
        <option value="anthropic">Anthropic Messages</option>
        <option value="gemini">Google Gemini</option>
        <option value="cohere">Cohere v2</option>
        <option value="azure">Azure OpenAI</option>
        <option value="mock">Демо-рушій</option>
      </select></div>
      <div class="field"><label>Авторизація</label><select id="cpAuth">
        <option value="bearer">Bearer (Authorization)</option>
        <option value="x-api-key">x-api-key</option>
        <option value="api-key">api-key</option>
        <option value="none">Без ключа</option>
      </select></div>
      <div class="field"><label>Base URL</label><input id="cpBase" placeholder="https://api.example.com/v1"></div>
      <div class="field"><label>Моделі (через кому)</label><input id="cpModels" placeholder="model-a, model-b"></div>
    </div>
    <div class="field"><label>Додаткові заголовки (JSON)</label><input id="cpHeaders" placeholder='{"X-Custom":"1"}'></div>
    <div class="row"><button class="btn-primary" id="cpSave">Додати провайдера</button></div>`);

  document.getElementById("cpSave").addEventListener("click", async () => {
    const name = document.getElementById("cpName").value.trim();
    const id = document.getElementById("cpId").value.trim().replace(/[^\w-]/g, "-");
    const baseURL = document.getElementById("cpBase").value.trim();
    if (!name || !id || !baseURL) return toast("Заповніть назву, ID і Base URL", "warn");
    let extraHeaders = {};
    const hj = document.getElementById("cpHeaders").value.trim();
    if (hj) { try { extraHeaders = JSON.parse(hj); } catch { return toast("Заголовки: некоректний JSON", "warn"); } }
    const models = document.getElementById("cpModels").value.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      await api.post("/api/providers/save", {
        id, custom: true, name, baseURL, models, extraHeaders,
        apiStyle: document.getElementById("cpStyle").value,
        authStyle: document.getElementById("cpAuth").value,
        keyRequired: document.getElementById("cpAuth").value !== "none",
      });
      await refreshProviders();
      openId = id;
      renderProviders();
      closeModal();
      toast("Провайдера додано — вставте ключ", "ok");
    } catch (e) { toast(e.message, "error"); }
  });
}
