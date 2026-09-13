// public/detail.js — повне досьє ніші в модалці
import { state, api, openModal, toast, closeModal } from "./core.js";
import { esc, num, ring, radar, factorBars, listBlock, badge, usd, LABELS } from "./ui.js";

export function openNicheModal(item) {
  const n = item.analysis || item;
  const d = n.dossier || {};
  const reality = item.reality || n.reality;
  const parts = item.parts || n.parts;
  const score = item.riskAdjusted ?? item.score ?? n.riskAdjusted ?? n.score ?? 0;

  const html = `
  <div class="row" style="justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:18px">
    <div style="flex:1">
      <div class="row" style="gap:8px;margin-bottom:9px">
        ${badge("Оцінка " + Number(score).toFixed(2), "b-acc")}
        ${n.rpmEstimateUsd ? badge("RPM ~$" + num(n.rpmEstimateUsd, 1), "b-info") : ""}
        ${n.growthScore >= 7 ? badge("зростає", "b-ok") : ""}
        ${n.confidence ? badge("впевненість " + n.confidence + "/10", "b-mute") : ""}
      </div>
      <h2 style="font-size:23px;margin-bottom:8px">${esc(n.niche || item.niche)}</h2>
      <div class="muted" style="line-height:1.6">${esc(n.oneLiner || n.verdict || "")}</div>
    </div>
    ${ring(score, 92, 8)}
  </div>
  <div class="grid g2" style="gap:20px">
    <div>
      <h3>Фактори</h3>${parts ? radar(parts, 268) : "<div class='muted'>—</div>"}
      ${parts ? factorBars(parts) : ""}
    </div>
    <div>
      ${listBlock("Чому зараз", [d.whyNow || n.whyNow].filter(Boolean))}
      ${listBlock("Аудиторія", [d.audience || n.audience].filter(Boolean))}
      ${listBlock("Позиціювання", [d.positioning].filter(Boolean))}
      ${listBlock("Під-ніші", d.subNiches || n.subNiches)}
      ${listBlock("Прогалини, які можна зайняти", n.gaps)}
    </div>
  </div>
  <div class="split" style="margin-top:8px">
    <div>${listBlock("30 ідей відео", d.videoIdeas)}</div>
    <div>
      ${listBlock("Формули заголовків", d.titleFormulas)}
      ${listBlock("Прев'ю", d.thumbnailConcepts)}
    </div>
  </div>
  <div class="split" style="margin-top:8px">
    <div>
      ${listBlock("Монетизація", d.monetizationStack || n.monetizationPaths)}
      ${listBlock("Конкуренти", d.competitors)}
    </div>
    <div>
      ${listBlock("Ризики", d.risks || n.risks)}
      ${listBlock("План на 30 днів", d.plan30Days)}
    </div>
  </div>
  ${d.firstVideos?.length ? `<h3 style="margin-top:14px">Перші три відео</h3>${d.firstVideos.map((v, i) => `
    <div class="card" style="margin-bottom:10px">
      <b>${i + 1}. ${esc(v.title)}</b>
      ${v.hook ? `<div class="muted" style="margin-top:6px">Хук: ${esc(v.hook)}</div>` : ""}
      ${v.outline?.length ? `<ul class="tight">${v.outline.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>` : ""}
    </div>`).join("")}` : ""}
  ${reality ? `
    <h3 style="margin-top:16px">Реальні дані YouTube</h3>
    <div class="card">
      <div class="kv">
        <b>Медіана переглядів</b><span>${num(reality.medianViews)}</span>
        <b>Свіжих відео (90 днів)</b><span>${num(reality.freshShare)}%</span>
        <b>Малих каналів у видачі</b><span>${num(reality.smallChannelShare)}%</span>
        <b>Індекс насиченості</b><span>${num(reality.saturationIndex, 1)}/10</span>
        <b>Індекс можливості</b><span>${num(reality.opportunityIndex, 1)}/10</span>
        <b>Великих каналів (500k+)</b><span>${num(reality.competition?.bigChannels)}</span>
      </div>
      <div class="muted" style="margin-top:10px">${esc(reality.verdict || "")}</div>
      ${reality.outliers?.length ? `<h3 style="margin-top:14px">Вибухові відео</h3><ul class="tight">${reality.outliers.slice(0, 6).map((o) => `<li><b>×${o.multiple}</b> — ${esc(o.title)} <span class="tiny">(${num(o.views)} переглядів, ${esc(o.channelTitle || o.channel || "")})</span></li>`).join("")}</ul>` : ""}
    </div>` : ""}
  <div class="row" style="margin-top:20px">
    <button class="btn-primary" data-add-pipeline='${esc(JSON.stringify({ niche: n.niche || item.niche, score: n.score, riskAdjusted: n.riskAdjusted, rpmEstimateUsd: n.rpmEstimateUsd, parts, analysis: n, reality: reality || null, oneLiner: n.oneLiner })).replace(/'/g, "&#39;")}'>Додати в пайплайн</button>
    <button class="btn" id="btnCopyDossier">Копіювати досьє</button>
  </div>`;
  openModal(html);

  document.querySelector("[data-add-pipeline]")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    try {
      const payload = JSON.parse(btn.dataset.addPipeline);
      const res = await api.post("/api/niches", payload);
      const { niches } = await api.get("/api/niches");
      state.niches = niches;
      toast(res.duplicate ? "Ця ніша вже в пайплайні" : "Додано в пайплайн", res.duplicate ? "warn" : "ok");
    } catch (err) { toast("Не вдалося додати: " + err.message, "error"); }
  });

  document.getElementById("btnCopyDossier")?.addEventListener("click", async () => {
    const lines = [n.niche, "", n.oneLiner || "", "", "План:", ...(d.plan30Days || []), "", "Ідеї:", ...(d.videoIdeas || [])];
    try { await navigator.clipboard.writeText(lines.join("\n")); toast("Досьє скопійовано", "ok"); }
    catch { toast("Не вдалося скопіювати", "error"); }
  });
}
