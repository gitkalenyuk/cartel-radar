// public/ui.js — хелпери рендерингу, форматування, мікрографіки
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const num = (n, d = 0) => (n == null || n === "" || isNaN(n)) ? "—" : Number(n).toLocaleString("uk-UA", { maximumFractionDigits: d });
export const usd = (n) => n == null ? "—" : "$" + Number(n).toFixed(n < 1 ? 4 : 2);
export const pct = (n) => n == null ? "—" : Math.round(n) + "%";
export const clamp = (n, a = 0, b = 10) => Math.max(a, Math.min(b, Number(n) || 0));

export function scoreColor(v) {
  const n = clamp(v);
  if (n >= 8) return "#b6ff3d";
  if (n >= 6.5) return "#35e08a";
  if (n >= 5) return "#22d3ee";
  if (n >= 3.5) return "#ffb020";
  return "#ff4d6d";
}

/** Кільце оцінки (SVG). */
export function ring(value, size = 62, stroke = 6, label = "") {
  const v = clamp(value);
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex:0 0 ${size}px">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${scoreColor(v)}" stroke-width="${stroke}"
      stroke-dasharray="${(c * v) / 10} ${c}" stroke-linecap="round" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="52%" text-anchor="middle" dominant-baseline="middle" fill="${scoreColor(v)}" font-size="${size * 0.3}" font-weight="700" font-family="var(--sans)">${v.toFixed(1)}</text>
    ${label ? `<text x="50%" y="78%" text-anchor="middle" fill="#5f6b88" font-size="${size * 0.14}">${esc(label)}</text>` : ""}
  </svg>`;
}

/** Радар-чарт факторів ніші. */
export function radar(parts, size = 250) {
  const keys = Object.entries(parts || {});
  if (keys.length < 3) return "";
  const cx = size / 2, cy = size / 2, R = size / 2 - 34;
  const ang = (i) => (Math.PI * 2 * i) / keys.length - Math.PI / 2;
  const pt = (i, v) => [cx + Math.cos(ang(i)) * R * (v / 10), cy + Math.sin(ang(i)) * R * (v / 10)];
  const grid = [2, 4, 6, 8, 10].map((lvl) =>
    `<polygon points="${keys.map((_, i) => pt(i, lvl).join(",")).join(" ")}" fill="none" stroke="rgba(255,255,255,.075)"/>`).join("");
  const axes = keys.map((_, i) => `<line x1="${cx}" y1="${cy}" x2="${pt(i, 10)[0]}" y2="${pt(i, 10)[1]}" stroke="rgba(255,255,255,.09)"/>`).join("");
  const poly = keys.map(([, v], i) => pt(i, clamp(v)).join(",")).join(" ");
  const labels = keys.map(([k], i) => {
    const [x, y] = pt(i, 11.9);
    return `<text x="${x}" y="${y}" fill="#8b98b8" font-size="9.5" text-anchor="middle" dominant-baseline="middle" font-family="var(--sans)">${esc(LABELS[k] || k)}</text>`;
  }).join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${grid}${axes}
    <polygon points="${poly}" fill="rgba(182,255,61,.18)" stroke="#b6ff3d" stroke-width="1.8"/>
    ${keys.map(([, v], i) => `<circle cx="${pt(i, clamp(v))[0]}" cy="${pt(i, clamp(v))[1]}" r="2.6" fill="#b6ff3d"/>`).join("")}
    ${labels}</svg>`;
}

export const LABELS = {
  demand: "Попит", competition: "Конкуренція", saturation: "Насиченість", monetization: "Гроші",
  novelty: "Новизна", evergreen: "Довговічність", growth: "Зростання", faceless: "Без обличчя",
  aiProducible: "AI-продакшн", ease: "Легкість старту",
};
const INVERTED = new Set(["competition", "saturation"]);

export function isInverted(key) { return INVERTED.has(key); }

/** Смуги факторів: показуємо «добре = довга смуга» (конкуренцію інвертуємо). */
export function factorBars(parts, { max = 10 } = {}) {
  if (!parts) return "";
  return `<div class="bars">${Object.entries(parts).map(([k, v]) => {
    const val = clamp(v);
    const inv = isInverted(k);
    // для конкуренції/насиченості довга смуга = погано (червона), коротка = добре (зелена)
    const w = (val / max) * 100;
    const good = inv ? val <= 4.5 : val >= 6;
    const grad = inv
      ? (val >= 6.5 ? "linear-gradient(90deg,#ff8a5c,#ff4d6d)" : "linear-gradient(90deg,#35e08a,#b6ff3d)")
      : (val <= 4 ? "linear-gradient(90deg,#ff8a5c,#ffb020)" : "linear-gradient(90deg,#22d3ee,#b6ff3d)");
    return `<div class="bline"><span class="muted">${esc(LABELS[k] || k)}${inv ? " ↓" : ""}</span>
      <span class="track"><i style="width:${w}%;background:${grad};opacity:${good ? 1 : .85}"></i></span>
      <b>${val.toFixed(1)}</b></div>`;
  }).join("")}</div>`;
}

/** Спарклайн (гістограма) по місяцях. */
export function sparkline(data, { w = 260, h = 60 } = {}) {
  const entries = Object.entries(data || {}).sort((a, b) => a[0].localeCompare(b[0])).slice(-12);
  if (!entries.length) return "";
  const max = Math.max(...entries.map(([, v]) => v), 1);
  const bw = w / entries.length;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${entries.map(([k, v], i) => {
    const bh = (v / max) * (h - 16);
    return `<rect x="${i * bw + 2}" y="${h - bh - 12}" width="${Math.max(2, bw - 4)}" height="${bh}" rx="2" fill="url(#gr)"/>
      <text x="${i * bw + bw / 2}" y="${h - 2}" font-size="8" fill="#5f6b88" text-anchor="middle">${esc(k.slice(2))}</text>`;
  }).join("")}<defs><linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b6ff3d"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs></svg>`;
}

export function listBlock(title, items, type = "ul") {
  if (!items || !items.length) return "";
  const body = items.map((x) => (typeof x === "string" ? `<li>${esc(x)}</li>` : `<li><b>${esc(x.title || x.cluster || x.niche || "")}</b> ${esc(x.why || x.hook || x.outline || "")}${x.views ? ` <span class="tiny">(${num(x.views)} переглядів${x.multiple ? ` · ×${x.multiple}` : ""})</span>` : ""}</li>`)).join("");
  return `<div style="margin-bottom:12px"><h3>${esc(title)}</h3><${type} class="tight">${body}</${type}></div>`;
}

export function badge(text, kind = "b-mute") { return `<span class="badge ${kind}">${esc(text)}</span>`; }

export function nicheCard(n, rank, { selected = false } = {}) {
  const score = n.score ?? n.riskAdjusted ?? 0;
  return `<div class="niche ${selected ? "sel" : ""}" data-niche="${esc(n.niche)}" data-uid="${esc(n.id || "")}">
    ${rank != null ? `<div class="rank">#${rank}</div>` : ""}
    <div class="top" style="margin-top:${rank != null ? 12 : 0}px">
      <h3>${esc(n.niche)}</h3>
      ${ring(score, 56, 5)}
    </div>
    <div class="muted" style="margin-bottom:10px;line-height:1.5">${esc(n.oneLiner || n.verdict || "")}</div>
    <div class="chips" style="margin-bottom:11px">
      ${n.rpmEstimateUsd ? badge("RPM ~$" + num(n.rpmEstimateUsd, 1), "b-acc") : ""}
      ${n.reality?.opportunityIndex != null ? badge("YT-можливість " + n.reality.opportunityIndex, n.reality.opportunityIndex >= 7 ? "b-ok" : n.reality.opportunityIndex >= 5 ? "b-info" : "b-warn") : ""}
      ${n.dossier ? badge("досьє готове", "b-info") : ""}
      ${n.confidence ? badge("впевненість " + n.confidence + "/10", "b-mute") : ""}
      ${n.parts ? badge("попит " + n.parts.demand, "b-mute") : ""}
    </div>
    ${n.parts ? factorBars(n.parts) : ""}
  </div>`;
}
