// lib/store.mjs — збережені ніші, пайплайн, історія запусків, експорт звітів
import { loadCollection, saveCollection, DATA_DIR } from "./config.mjs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const STATUSES = [
  { id: "idea", label: "Ідея" },
  { id: "validating", label: "Валідація" },
  { id: "greenlit", label: "Затверджено" },
  { id: "rejected", label: "Відхилено" },
];

export async function listNiches() { return (await loadCollection("niches", [])); }

export async function addNiche(item) {
  const list = await listNiches();
  const exists = list.find((n) => n.niche === item.niche);
  if (exists) return { niche: exists, duplicate: true };
  const niche = {
    id: randomUUID(),
    niche: item.niche, oneLiner: item.oneLiner || "", score: item.score ?? null,
    riskAdjusted: item.riskAdjusted ?? null, rpmEstimateUsd: item.rpmEstimateUsd ?? null,
    parts: item.parts || null, analysis: item, reality: item.reality || null,
    status: item.status || "idea", tags: item.tags || [], note: item.note || "",
    runId: item.runId || null, addedAt: Date.now(),
  };
  list.unshift(niche);
  await saveCollection("niches", list);
  return { niche };
}

export async function updateNiche(id, patch) {
  const list = await listNiches();
  const i = list.findIndex((n) => n.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch, updatedAt: Date.now() };
  await saveCollection("niches", list);
  return list[i];
}

export async function deleteNiche(id) {
  const list = await listNiches();
  const next = list.filter((n) => n.id !== id);
  await saveCollection("niches", next);
  return { removed: list.length - next.length };
}

export async function listRuns() {
  try {
    const files = await fs.readdir(path.join(DATA_DIR, "runs"));
    const runs = [];
    for (const f of files.slice(-200)) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(await fs.readFile(path.join(DATA_DIR, "runs", f), "utf8"));
        runs.push({ id: r.id, type: r.type, status: r.status, createdAt: r.createdAt, finishedAt: r.finishedAt, params: r.params, stats: r.stats, summary: r.result?.summary || null });
      } catch {}
    }
    return runs.sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}

export async function getRun(id) {
  try { return JSON.parse(await fs.readFile(path.join(DATA_DIR, "runs", id + ".json"), "utf8")); }
  catch { return null; }
}

// ---------------------------------------------------------------- ЕКСПОРТ
export function nicheToMarkdown(n, index) {
  const s = n.analysis || {};
  const d = s.dossier || {};
  const r = n.reality || s.reality;
  const L = [];
  L.push(`## ${index != null ? index + 1 + ". " : ""}${n.niche}`);
  if (n.oneLiner) L.push(`*${n.oneLiner}*`);
  L.push("");
  L.push(`**Оцінка:** ${n.score ?? "—"} / 10  ·  **з урахуванням ризику:** ${n.riskAdjusted ?? "—"}  ·  **RPM:** ${n.rpmEstimateUsd ?? "—"} $  ·  **Статус:** ${(STATUSES.find((x) => x.id === (n.status || "idea")) || {}).label || n.status}`);
  if (n.parts) {
    const rows = Object.entries(n.parts).map(([k, v]) => k.padEnd(14) + " " + v).join("\n");
    L.push("```\n" + rows + "\n```");
  }
  if (r) {
    L.push(`**Реальні дані YouTube:** медіана ${r.medianViews} переглядів · свіжих відео ${r.freshShare}% · малих каналів ${r.smallChannelShare}% · індекс можливості ${r.opportunityIndex}`);
    if (r.outliers?.length) { L.push(""); L.push("**Вибухові відео (x-медіана):**"); for (const o of r.outliers.slice(0, 5)) L.push(`- ${o.multiple}× — ${o.title} (${o.views} переглядів, ${o.channelTitle})`); }
  }
  if (s.audience) L.push(`\n**Аудиторія:** ${s.audience}`);
  if (s.whyNow || d.whyNow) L.push(`\n**Чому зараз:** ${d.whyNow || s.whyNow}`);
  if (d.positioning) L.push(`\n**Позиціювання:** ${d.positioning}`);
  if (d.subNiches?.length || s.subNiches?.length) { L.push("\n**Під-ніші:**"); for (const x of (d.subNiches || s.subNiches)) L.push(`- ${x}`); }
  if (s.gaps?.length) { L.push("\n**Прогалини:**"); for (const x of s.gaps) L.push(`- ${x}`); }
  if (d.videoIdeas?.length) { L.push("\n**30 ідей відео:**"); d.videoIdeas.forEach((x, i) => L.push(`${i + 1}. ${x}`)); }
  if (d.titleFormulas?.length) { L.push("\n**Формули заголовків:**"); for (const x of d.titleFormulas) L.push(`- ${x}`); }
  if (d.thumbnailConcepts?.length) { L.push("\n**Прев'ю:**"); for (const x of d.thumbnailConcepts) L.push(`- ${x}`); }
  if (d.monetizationStack?.length || s.monetizationPaths?.length) { L.push("\n**Монетизація:**"); for (const x of (d.monetizationStack || s.monetizationPaths)) L.push(`- ${x}`); }
  if (d.competitors?.length) { L.push("\n**Конкуренти:**"); for (const x of d.competitors) L.push(`- ${x}`); }
  if (d.risks?.length || s.risks?.length) { L.push("\n**Ризики:**"); for (const x of (d.risks || s.risks)) L.push(`- ${x}`); }
  if (d.plan30Days?.length) { L.push("\n**План на 30 днів:**"); for (const x of d.plan30Days) L.push(`- ${x}`); }
  if (d.firstVideos?.length) {
    L.push("\n**Перші три відео:**");
    d.firstVideos.forEach((v, i) => { L.push(`${i + 1}. **${v.title}** — хук: ${v.hook}`); if (v.outline) L.push(`   - ${v.outline.join(" → ")}`); });
  }
  if (n.note) L.push(`\n> Нотатка: ${n.note}`);
  L.push("");
  return L.join("\n");
}

export function toMarkdown(items, title = "Звіт Cartel Radar") {
  const head = [`# ${title}`, "", `Згенеровано: ${new Date().toLocaleString("uk-UA")}  ·  Ніш у звіті: ${items.length}`, "", "| # | Ніша | Оцінка | RPM | Статус |", "|---|------|--------|-----|--------|"];
  items.forEach((n, i) => head.push(`| ${i + 1} | ${String(n.niche).replace(/\|/g, "/")} | ${n.score ?? "—"} | ${n.rpmEstimateUsd ?? "—"} | ${n.status || "idea"} |`));
  head.push("");
  return head.concat(items.map((n, i) => nicheToMarkdown(n, i))).join("\n");
}

export function toCSV(items) {
  const cols = ["niche", "score", "riskAdjusted", "rpmEstimateUsd", "demandScore", "competitionScore", "saturationScore", "monetizationScore", "noveltyScore", "growthScore", "evergreenScore", "facelessScore", "aiProducibleScore", "easeScore", "status"];
  const rows = [cols.join(",")];
  for (const n of items) {
    const a = n.analysis || {};
    const get = (k) => {
      if (k === "niche") return n.niche;
      if (k === "score") return n.score;
      if (k === "riskAdjusted") return n.riskAdjusted;
      if (k === "status") return n.status || "idea";
      return a[k] ?? n[k] ?? "";
    };
    rows.push(cols.map((c) => {
      const v = get(c);
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(","));
  }
  return rows.join("\n");
}
