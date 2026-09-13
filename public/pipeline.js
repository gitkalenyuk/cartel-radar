// public/pipeline.js — канбан пайплайну, історія запусків, експорт
import { state, api, toast, timeAgo, download, runJob } from "./core.js";
import { esc, num, ring, badge, usd } from "./ui.js";
import { openNicheModal } from "./detail.js";
import { setRankingData } from "./hunt.js";
import { goto } from "./app.js";

const COLUMNS = [
  { id: "idea", label: "Ідея" },
  { id: "validating", label: "Валідація" },
  { id: "greenlit", label: "Затверджено" },
  { id: "rejected", label: "Відхилено" },
];

export function initPipeline() {
  document.querySelectorAll("[data-export]").forEach((b) =>
    b.addEventListener("click", () => { window.location.href = `/api/export?format=${b.dataset.export}`; }));

  document.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del-niche]");
    if (del) { await api.del("/api/niches/" + del.dataset.delNiche); await reload(); toast("Видалено", "ok"); return; }
    const open = e.target.closest("[data-open-niche]");
    if (open) {
      const n = state.niches.find((x) => x.id === open.dataset.openNiche);
      if (n) openNicheModal({ ...n.analysis, ...n });
    }
    const run = e.target.closest("[data-run]");
    if (run) openRun(run.dataset.run);
  });
}

async function reload() {
  const { niches } = await api.get("/api/niches");
  state.niches = niches;
  renderPipeline();
  if (state.view === "dashboard") import("./app.js").then((m) => m.goto("dashboard"));
}

export function renderPipeline() {
  const box = document.getElementById("kanban");
  if (!box) return;
  document.getElementById("pipeCount").textContent = state.niches.length ? `${state.niches.length} ніш` : "";
  box.innerHTML = COLUMNS.map((col) => {
    const items = state.niches.filter((n) => (n.status || "idea") === col.id);
    return `<div class="kcol" data-col="${col.id}">
      <h3>${esc(col.label)} <span>${items.length}</span></h3>
      ${items.map((n) => `
        <div class="kcard" draggable="true" data-id="${esc(n.id)}">
          <b>${esc(n.niche)}</b>
          <div class="row" style="justify-content:space-between">
            <span class="tiny">${n.rpmEstimateUsd ? "RPM ~$" + num(n.rpmEstimateUsd, 1) : ""}</span>
            <span style="color:#b6ff3d;font-family:var(--mono);font-size:12px">${n.riskAdjusted ?? n.score ?? "—"}</span>
          </div>
          <div class="row" style="margin-top:8px;gap:6px">
            <button class="btn-sm" data-open-niche="${esc(n.id)}">Досьє</button>
            <button class="btn-sm btn-danger" data-del-niche="${esc(n.id)}">×</button>
          </div>
        </div>`).join("") || `<div class="tiny" style="padding:10px 0">порожньо</div>`}
    </div>`;
  }).join("");

  // drag&drop
  let dragged = null;
  box.querySelectorAll(".kcard").forEach((card) => {
    card.addEventListener("dragstart", () => { dragged = card.dataset.id; card.style.opacity = ".5"; });
    card.addEventListener("dragend", () => { card.style.opacity = "1"; });
  });
  box.querySelectorAll(".kcol").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
    col.addEventListener("dragleave", () => col.classList.remove("over"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault(); col.classList.remove("over");
      if (!dragged) return;
      await api.patch("/api/niches/" + dragged, { status: col.dataset.col });
      dragged = null;
      await reload();
    });
  });
}

export async function renderHistory() {
  const { history } = await api.get("/api/runs");
  state.runs = history || [];
  const t = document.getElementById("histTable");
  if (!state.runs.length) { t.innerHTML = `<tbody><tr><td class="muted" style="padding:20px">Історія порожня.</td></tr></tbody>`; return; }
  t.innerHTML = `<thead><tr><th>Дата</th><th>Тип</th><th>Запит</th><th>Статус</th><th>Ніш</th><th>Викликів</th><th>Вартість</th><th>Топ ніша</th><th></th></tr></thead><tbody>` +
    state.runs.map((r) => `<tr>
      <td class="tiny">${new Date(r.createdAt).toLocaleString("uk-UA")}</td>
      <td><span class="tag">${esc(r.type)}</span></td>
      <td>${esc(String(r.params?.seeds || r.params?.channel || r.params?.seed || r.params?.url || "автопошук").slice(0, 46))}</td>
      <td>${badge(r.status === "done" ? "готово" : r.status, r.status === "done" ? "b-ok" : r.status === "running" ? "b-info" : "b-warn")}</td>
      <td>${num(r.summary?.screened ?? r.stats?.total)}</td>
      <td>${num(r.stats?.calls)}</td>
      <td>${usd(r.stats?.costUsd)}</td>
      <td class="muted">${esc(r.summary?.best || "—")}</td>
      <td><button class="btn-sm" data-run="${esc(r.id)}">Відкрити</button></td>
    </tr>`).join("") + "</tbody>";
}

async function openRun(id) {
  try {
    const { job } = await api.get("/api/runs/" + id);
    const niches = job?.result?.niches || [];
    if (!niches.length) return toast("У цьому запуску немає збережених ніш", "warn");
    setRankingData(niches);
    goto("ranking");
    toast(`Завантажено ${niches.length} ніш із запуску`, "ok");
  } catch (e) { toast(e.message, "error"); }
}
