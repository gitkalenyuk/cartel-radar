// public/radar.js — «Радар ніш»: пошук свіжих проривів у ніші.
// Працює на локальному yt-dlp: без ключа й без квоти.

import { api, toast } from "./core.js";
import { esc, num } from "./ui.js";

// Читаємо ЗНАЧЕННЯ поля, а не сам елемент: інакше .split() падає,
// а Number(input) дає NaN і числові налаштування тихо ігноруються.
const val = (id) => document.getElementById(id)?.value ?? "";
const numv = (id, dflt) => { const n = Number(String(val(id)).replace(",", ".")); return Number.isFinite(n) && n >= 0 ? n : dflt; };
let lastData = null;

export function initRadar() {
  const btn = document.getElementById("btnRadarRun");
  if (btn) btn.addEventListener("click", run);
  const input = document.getElementById("rdQuery");
  if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
}

function setStatus(html) {
  const el = document.getElementById("rdStatus");
  if (el) el.innerHTML = html;
}
function setProgress(html) {
  const el = document.getElementById("rdProgress");
  if (el) el.innerHTML = html;
}

function buildQueries() {
  const custom = val("rdQueries").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  if (custom.length) return custom.slice(0, 6);
  const base = val("rdQuery").trim();
  if (!base) return [];
  if (/^https?:\/\//.test(base) || base.startsWith("@")) return [base];
  const words = base.split(/\s+/).filter(Boolean);
  const out = [base];
  if (words.length > 1) out.push(base + " 2026", base + " огляд", "як " + base);
  return [...new Set(out)].slice(0, 4);
}

async function run() {
  const queries = buildQueries();
  if (!queries.length) return toast("Впишіть нішу або ключові слова", "error");
  const body = {
    queries,
    maxAgeDays: numv("rdAge", 365),
    minSubs: numv("rdMinSubs", 0),
    maxSubs: numv("rdMaxSubs", 75000),
    perQuery: numv("rdPerQuery", 12),
  };
  const btn = document.getElementById("btnRadarRun");
  btn.disabled = true;
  btn.textContent = "Шукаю…";
  setProgress("");
  setStatus(`<div class="muted">Шукаю за запитами: ${queries.map((q) => "«" + esc(q) + "»").join(", ")}</div>
    <div class="muted" style="margin-top:8px">Це займає час: для кожного знайденого відео збираються точні дані.</div>`);
  const t0 = Date.now();
  try {
    const data = await api.post("/api/yt/radar", body);
    lastData = data;
    const secs = Math.round((Date.now() - t0) / 1000);
    setStatus(`<b style="color:#35e08a">Готово за ${secs} с.</b> Переглянуто ${data.candidates} відео, пройшли фільтр ${(data.breakouts || []).length}.`);
    if (data.failedQueries?.length) {
      setProgress(`<div class="muted" style="color:#ffb84d">Частину запитів не вдалося обробити: ${data.failedQueries.map((f) => esc(f.query)).join(", ")}</div>`);
    }
    renderRadarResults(data);
  } catch (e) {
    setStatus(`<b style="color:#ff6b6b">Не вдалося виконати пошук.</b> <span class="muted">${esc(e.message)}</span>`);
    toast("Радар: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Запустити радар";
  }
}

function ratioBadge(ratio) {
  if (ratio == null) return '<span class="muted">—</span>';
  const cls = ratio >= 3 ? "ratio-hot" : ratio >= 1.5 ? "ratio-good" : "ratio-cold";
  return `<span class="ratio ${cls}">${ratio.toFixed(2)}×</span>`;
}

export function renderRadarResults(data) {
  const host = document.getElementById("rdResults");
  if (!host) return;
  const breakouts = data.breakouts || [];
  const competitors = data.competitors || [];

  if (!breakouts.length) {
    host.innerHTML = `<div class="card"><h2>Нічого не пройшло фільтр</h2>
      <p class="muted" style="line-height:1.6">За цими запитами не знайшлося відео від каналів потрібного розміру й віку.
      Спробуйте: ширші ключові слова, більший вік відео (наприклад 730 днів), ширший діапазон підписників
      (наприклад 1000–150000) або власні пошукові запити.</p></div>`;
    return;
  }

  const rows = breakouts.map((b) => `
    <tr>
      <td class="rd-title"><a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.title)}</a>
        <div class="muted" style="font-size:11.5px;margin-top:3px">${esc((b.channel || "").slice(0, 40))} · ${b.publishedAt ? new Date(b.publishedAt).toLocaleDateString("uk-UA") : "дата невідома"} · ${b.duration ? Math.round(b.duration / 60) + " хв" : "—"}</div>
      </td>
      <td class="num">${b.subscribers ? num(b.subscribers) : "приховано"}</td>
      <td class="num">${num(b.views)}</td>
      <td class="num">${ratioBadge(b.outlierRatio)}</td>
      <td class="num">${b.velocity ? num(Math.round(b.velocity)) + "/д" : "—"}</td>
      <td><button class="btn-sm" data-retention="${esc(b.videoId)}">Утримання</button></td>
    </tr>`).join("");

  const compRows = competitors.slice(0, 12).map((c) => `
    <tr>
      <td><a href="${esc(c.url || "#")}" target="_blank" rel="noopener">${esc(c.channel)}</a></td>
      <td class="num">${c.subscribers ? num(c.subscribers) : "—"}</td>
      <td class="num">${num(c.peakViews)}</td>
      <td class="num">${ratioBadge(c.bestOutlierRatio)}</td>
      <td class="num">${c.videosCount}</td>
    </tr>`).join("");

  host.innerHTML = `
    <div class="card">
      <h2>Свіжі прориви · ${breakouts.length}</h2>
      <p class="muted" style="margin-bottom:10px">Це канали, які щойно пробилися. <b>Кратність</b> — у скільки разів переглядів більше, ніж підписників: 3× і вище означає, що відео вирвалося за межі власної аудиторії.</p>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Відео</th><th>Підписники</th><th>Перегляди</th><th>Кратність</th><th>Швидкість</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
    <div class="card" style="margin-top:16px">
      <h2>Конкуренти в ніші · ${competitors.length}</h2>
      <p class="muted" style="margin-bottom:10px">Хто вже грає в цій ніші й наскільки високо вони стрибають.</p>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Канал</th><th>Підписники</th><th>Найкраще відео</th><th>Кратність</th><th>Відео у вибірці</th></tr></thead>
        <tbody>${compRows}</tbody>
      </table></div>
    </div>
    <div class="card" style="margin-top:16px">
      <h2>Що робити з цим далі</h2>
      <ol class="muted" style="line-height:1.9;padding-left:18px">
        <li>Відкрийте 2–3 найкращі відео й подивіться криву утримання — кнопка «Утримання» показує, де саме глядачі тікають.</li>
        <li>Порівняйте заголовки: у нішах, що працюють, зазвичай є цифри та конкретика.</li>
        <li>Знайдіть кут, якого немає в жодного з конкурентів — це і є ваша ніша.</li>
        <li>Внесіть нішу в пайплайн («Полювання») — досьє згенерує ідеї відео за методологією утримання.</li>
      </ol>
    </div>
    <div id="rdRetention"></div>`;

  host.querySelectorAll("[data-retention]").forEach((b) => {
    b.addEventListener("click", () => showRetention(b.dataset.retention, b));
  });
}

async function showRetention(videoId, btn) {
  const host = document.getElementById("rdRetention");
  if (!host) return;
  btn.disabled = true;
  btn.textContent = "…";
  host.innerHTML = '<div class="card" style="margin-top:16px"><h2>Крива уваги аудиторії</h2><div class="muted">Збираю дані…</div></div>';
  try {
    const data = await api.post("/api/yt/video", { videoId, transcript: false });
    const v = data.video || {};
    const r = data.retention;
    if (!r || r.ok === false) {
      host.innerHTML = `<div class="card" style="margin-top:16px"><h2>Крива утримання</h2>
        <p class="muted">${esc(r?.reason || "YouTube не віддав криву для цього відео.")}</p></div>`;
      return;
    }
    host.innerHTML = `<div class="card" style="margin-top:16px">
      <h2>Крива утримання · ${esc((v.title || "").slice(0, 60))}</h2>
      <p class="muted" style="margin-bottom:10px">Форма уваги аудиторії за офіційними даними YouTube — для чужого відео теж. Значення нормовані до найвищої точки відео, тому це не відсоток утримання, а рельєф уваги: де вона сягає піку, а де провалюється.</p>
      ${retentionSvg(r)}
      <div class="grid g4" style="margin-top:14px;gap:10px">
        ${stat("Старт відносно піку", r.startVsPeak ?? r.hookRetention)}
        ${stat("Найбільше передивляються", r.peakAtSec != null ? Math.round(r.peakAtSec / 60) + " хв" : null, true)}
        ${stat("Середина відносно піку", r.midVsPeak ?? r.retentionAt50pct)}
        ${stat("Кінець відносно піку", r.endVsPeak ?? r.endRetention)}
      </div>
      <div class="muted" style="margin-top:12px;line-height:1.6">
        ${r.biggestDrop ? `<b>Найглибший спад:</b> на ${Math.round(r.biggestDrop.fromSec)}–${Math.round(r.biggestDrop.toSec)} с увага падає на ${Math.round(r.biggestDrop.drop * 100)}%. Це найслабше місце відео.` : ""}
        <br>Середнє утримання за відео: <b>${Math.round(r.avgRetention * 100)}%</b>.
      </div>
    </div>`;
  } catch (e) {
    host.innerHTML = `<div class="card" style="margin-top:16px"><h2>Крива утримання</h2><p class="muted">Не вдалося: ${esc(e.message)}</p></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Утримання";
  }
}

const stat = (label, value, raw) => `<div class="mini"><span class="muted">${label}</span><b>${value == null ? "—" : raw ? value : Math.round(value * 100) + "%"}</b></div>`;

/** Малює криву утримання як SVG без жодних бібліотек. */
export function retentionSvg(r, { width = 760, height = 200 } = {}) {
  const pts = (r.curve || []).map((p) => ({ x: p.t, y: p.value }));
  if (pts.length < 2) return '<div class="muted">Недостатньо точок для графіка.</div>';
  const pad = { l: 34, r: 10, t: 12, b: 22 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const X = (x) => pad.l + x * w;
  const Y = (y) => pad.t + (1 - Math.max(0, Math.min(1, y))) * h;
  const line = pts.map((p, i) => (i ? "L" : "M") + X(p.x).toFixed(1) + " " + Y(p.y).toFixed(1)).join(" ");
  const area = line + ` L ${X(1).toFixed(1)} ${Y(0).toFixed(1)} L ${X(0).toFixed(1)} ${Y(0).toFixed(1)} Z`;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((g) =>
    `<line x1="${pad.l}" y1="${Y(g)}" x2="${X(1)}" y2="${Y(g)}" stroke="#232c47" stroke-width="1"/>
     <text x="${pad.l - 6}" y="${Y(g) + 3.5}" fill="#6d7ba0" font-size="10" text-anchor="end">${Math.round(g * 100)}%</text>`).join("");
  const drop = r.biggestDrop
    ? `<line x1="${X(r.biggestDrop.fromSec / Math.max(1, r.durationSec || r.biggestDrop.toSec))}" y1="${pad.t}" x2="${X(r.biggestDrop.fromSec / Math.max(1, r.durationSec || r.biggestDrop.toSec))}" y2="${pad.t + h}" stroke="#ff6b6b" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>`
    : "";
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px" role="img" aria-label="Крива утримання аудиторії">
    <defs><linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#b6ff3d" stop-opacity="0.35"/><stop offset="100%" stop-color="#b6ff3d" stop-opacity="0.02"/>
    </linearGradient></defs>
    ${grid}${drop}
    <path d="${area}" fill="url(#rg)"/>
    <path d="${line}" fill="none" stroke="#b6ff3d" stroke-width="2" stroke-linejoin="round"/>
  </svg>`;
}
