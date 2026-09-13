// public/updates.js — оновлення модулів просто із застосунку.
//
// Застосунок складається з модулів: інтерфейс, логіка, сервер, довідка.
// Кожен можна оновити окремо. Це важливо, бо повний інсталятор важить
// понад 100 МБ, а виправлення в інтерфейсі — це кілька кілобайтів.

import { api, toast } from "./core.js"; // api.post(url, body) — див. core.js
import { esc } from "./ui.js";

let checkResult = null;
let busy = false;

function $(id) { return document.getElementById(id); }

export function initUpdates() {
  $("btnUpdCheck")?.addEventListener("click", () => runCheck(true));
  $("btnUpdAll")?.addEventListener("click", () => applySelected(true));
  $("btnUpdSelected")?.addEventListener("click", () => applySelected(false));
  $("btnUpdReload")?.addEventListener("click", () => location.reload());
  $("updGroups")?.addEventListener("change", (e) => {
    const box = e.target.closest("input[type=checkbox][data-files]");
    if (box) syncButtons();
  });
}

/** Викликається при вході в розділ — щоб дані були свіжі, але без зайвих запитів. */
export function renderUpdates() {
  if (!checkResult && !busy) runCheck(false);
}

function status(text, kind = "") {
  const el = $("updStatus");
  if (el) { el.textContent = text || ""; el.className = "muted " + kind; }
}

function syncButtons() {
  const boxes = [...document.querySelectorAll("input[type=checkbox][data-files]:checked")];
  const n = boxes.reduce((sum, b) => sum + b.dataset.files.split(",").filter(Boolean).length, 0);
  const sel = $("btnUpdSelected");
  const all = $("btnUpdAll");
  if (sel) { sel.disabled = n === 0 || busy; sel.textContent = n ? `Оновити вибране (${n})` : "Оновити вибране"; }
  if (all) all.disabled = busy;
}

async function runCheck(showToast) {
  busy = true;
  const btn = $("btnUpdCheck");
  if (btn) { btn.disabled = true; btn.textContent = "Перевіряю…"; }
  status("Перевіряю останню версію на GitHub…");
  try {
    const r = await api.post("/api/update/check");
    if (!r.ok) throw new Error(r.error || "не вдалося перевірити");
    checkResult = r;
    render(r);
    status(r.upToDate ? "Усе оновлено — ви маєте найсвіжішу версію." : "Є що оновити.", r.upToDate ? "ok" : "warn");
    if (showToast) toast(r.upToDate ? "Оновлень немає" : "Знайдено оновлення", r.upToDate ? "ok" : "info");
  } catch (e) {
    status("Не вдалося перевірити: " + e.message, "err");
    if (showToast) toast("Помилка перевірки: " + e.message, "error");
  } finally {
    busy = false;
    if (btn) { btn.disabled = false; btn.textContent = "Перевірити оновлення"; }
  }
}

function render(r) {
  const ver = $("updVersion");
  if (ver) {
    ver.innerHTML = `У вас <b>${esc(r.currentVersion || "?")}</b> · на GitHub <b>${esc(r.manifestVersion || r.release.tag)}</b>${r.upToDate ? ' <span class="badge b-ok">актуально</span>' : ' <span class="badge b-warn">є новіше</span>'}`;
  }
  const rel = $("updRelease");
  if (rel) {
    rel.innerHTML = `Останній реліз: <a href="${esc(r.release.url)}" target="_blank" rel="noopener">${esc(r.release.name)}</a>` +
      (r.lastUpdate ? ` · модулі оновлювалися ${new Date(r.lastUpdate.at).toLocaleString("uk-UA")}` : "");
  }
  const warn = $("updWhere");
  if (warn) {
    warn.style.display = r.writable ? "none" : "block";
    warn.textContent = r.writable ? "" : "Тека застосунку захищена від запису — оновлення ляжуть у теку даних і працюватимуть, але після повного перевстановлення їх треба буде повторити.";
  }

  const box = $("updGroups");
  if (!box) return;
  box.innerHTML = r.groups.map((g) => {
    const outdated = g.files.filter((f) => f.status !== "current");
    const badge = g.outdated
      ? `<span class="badge b-warn">${g.outdated} до оновлення</span>`
      : `<span class="badge b-ok">актуально</span>`;
    const files = g.files.map((f) => {
      const mark = f.status === "current" ? '<span class="tiny" style="color:var(--ok)">актуальний</span>'
        : f.status === "missing" ? '<span class="tiny" style="color:var(--warn)">немає</span>'
          : '<span class="tiny" style="color:var(--warn)">застарів</span>';
      return `<label class="upd-file"><input type="checkbox" data-files="${esc(f.file)}"${f.status === "current" ? "" : " checked"} ${f.status === "current" ? "disabled" : ""}><code>${esc(f.file)}</code> ${mark}</label>`;
    }).join("");
    return `<div class="upd-group">
      <div class="upd-head">
        <label class="upd-pick"><input type="checkbox" data-group="${g.id}" ${g.outdated ? "checked" : "disabled"}><b>${esc(g.name)}</b></label>
        <span class="muted tiny">${esc(g.hint)} · ${g.total} файлів</span>
        ${badge}
      </div>
      <details><summary class="tiny muted">показати файли</summary><div class="upd-files">${files}</div></details>
    </div>`;
  }).join("");

  // груповий чекбокс вибирає всі застарілі файли групи
  box.querySelectorAll("input[data-group]").forEach((box2) => {
    box2.addEventListener("change", () => {
      const g = r.groups.find((x) => x.id === box2.dataset.group);
      if (!g) return;
      const set = new Set(g.files.filter((f) => f.status !== "current").map((f) => f.file));
      box.querySelectorAll("input[data-files]").forEach((cb) => { if (set.has(cb.dataset.files)) cb.checked = box2.checked; });
      syncButtons();
    });
  });

  box.querySelectorAll("input[data-files]").forEach((cb) => cb.addEventListener("change", syncButtons));
  syncButtons();
  const sel = $("btnUpdSelected");
  if (sel) sel.style.display = r.upToDate ? "none" : "";
}

async function applySelected(everything) {
  if (busy) return;
  const files = everything ? [] : [...document.querySelectorAll("input[type=checkbox][data-files]:checked")].map((b) => b.dataset.files).filter(Boolean);
  if (!everything && !files.length) return toast("Нічого не вибрано", "warn");
  busy = true;
  syncButtons();
  status(everything ? "Оновлюю все застаріле…" : `Оновлюю ${files.length} файлів…`);
  try {
    const body = everything ? { all: true, tag: checkResult?.release?.tag } : { files, tag: checkResult?.release?.tag };
    const r = await api.post("/api/update/apply", body);
    if (!r.ok) throw new Error(r.error || (r.results || []).find((x) => !x.ok)?.reason || "не вдалося оновити");
    const parts = [];
    parts.push(`Оновлено файлів: ${r.updated}`);
    if (r.failed) parts.push(`не вдалося: ${r.failed}`);
    if (r.backup) parts.push("старі версії збережено в " + r.backup);
    status(parts.join(" · "), "ok");
    toast(`Оновлено ${r.updated} файлів`, "ok");
    const reload = $("btnUpdReload");
    if (reload) reload.style.display = "";
    if (r.restartRequired) {
      status(parts.join(" · ") + " — змінилися сервер або логіка, потрібен перезапуск застосунку", "warn");
    } else {
      // інтерфейс можна підхопити одразу
      setTimeout(() => location.reload(), 1200);
    }
    checkResult = null;
  } catch (e) {
    status("Помилка оновлення: " + e.message, "err");
    toast("Помилка оновлення: " + e.message, "error");
  } finally {
    busy = false;
    syncButtons();
  }
}
