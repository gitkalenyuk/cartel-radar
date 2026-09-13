// public/analysis.js — аналіз каналу, gap-сканер, відео-лаб
import { state, api, runJob, toast } from "./core.js";
import { retentionSvg } from "./radar.js";
import { esc, num, ring, badge, listBlock, sparkline, usd, factorBars } from "./ui.js";

const box = (id) => document.getElementById(id);

function progressBar(target, label) {
  target.innerHTML = `<div class="card"><div class="row"><span class="spin"></span><b>${esc(label)}</b><span class="muted" id="anProgress"></span></div>
    <div class="bar"><i style="width:8%"></i></div></div>`;
}

function setProgress(msg) { const el = document.getElementById("anProgress"); if (el) el.textContent = msg; }

export function initAnalysis() {
  box("btnChannel").addEventListener("click", async () => {
    const channel = box("chInput").value.trim();
    if (!channel) return toast("Вкажіть канал", "warn");
    progressBar(box("chResult"), "Аналізую канал…");
    try {
      await runJob("channel", { channel, provider: box("chProvider").value || undefined, model: box("chModel").value.trim() || undefined }, (ev) => {
        if (ev.t === "log") setProgress(ev.msg);
        if (ev.t === "stage") setProgress(ev.label);
        if (ev.t === "result") renderChannel(ev.result);
        if (ev.t === "error") { toast(ev.msg, "error", 8000); box("chResult").innerHTML = `<div class="card" style="border-color:rgba(255,77,109,.4)">${esc(ev.msg)}</div>`; }
      });
    } catch (e) { toast(e.message, "error"); }
  });

  box("btnGap").addEventListener("click", async () => {
    const seed = box("gapSeed").value.trim();
    if (!seed) return toast("Вкажіть тему", "warn");
    progressBar(box("gapResult"), "Сканую кластери…");
    try {
      await runJob("gap", { seed, provider: box("gapProvider").value || undefined, model: box("gapModel").value.trim() || undefined }, (ev) => {
        if (ev.t === "log" || ev.t === "stage") setProgress(ev.msg || ev.label);
        if (ev.t === "result") renderGap(ev.result, seed);
        if (ev.t === "error") { toast(ev.msg, "error", 8000); box("gapResult").innerHTML = `<div class="card">${esc(ev.msg)}</div>`; }
      });
    } catch (e) { toast(e.message, "error"); }
  });

  box("btnThumbs").addEventListener("click", async () => {
    const input = box("thInput").value.trim();
    if (!input) return toast("Вкажіть канал або нішу", "warn");
    progressBar(box("thResult"), "Дивлюся прев'ю…");
    try {
      await runJob("thumbs", { channel: input, provider: box("thProvider").value || undefined, model: box("thModel").value.trim() || undefined }, (ev) => {
        if (ev.t === "log" || ev.t === "stage") setProgress(ev.msg || ev.label);
        if (ev.t === "result") renderThumbs(ev.result);
        if (ev.t === "error") { toast(ev.msg, "error", 9000); box("thResult").innerHTML = `<div class="card">${esc(ev.msg)}</div>`; }
      });
    } catch (e) { toast(e.message, "error"); }
  });

  // Реальні дані про відео: точні цифри, крива утримання й темпоритм — локально через yt-dlp.
  box("btnVideoReal").addEventListener("click", async () => {
    const url = box("vidUrl").value.trim();
    if (!url) return toast("Вставте посилання", "warn");
    box("vidResult").innerHTML = `<div class="card"><h2>Реальні дані</h2><div class="muted">Збираю…</div></div>`;
    try {
      const d = await api.post("/api/yt/video", { url, transcript: true, comments: true });
      renderRealVideo(d);
    } catch (e) {
      box("vidResult").innerHTML = `<div class="card"><h2>Реальні дані</h2><p class="muted">Не вдалося: ${esc(e.message)}</p></div>`;
      toast("Реальні дані: " + e.message, "error");
    }
  });
  box("btnVideo").addEventListener("click", async () => {
    const url = box("vidUrl").value.trim();
    if (!url) return toast("Вставте посилання", "warn");
    progressBar(box("vidResult"), "Розбираю відео…");
    try {
      await runJob("video", { url, provider: box("vidProvider").value || undefined, model: box("vidModel").value.trim() || undefined }, (ev) => {
        if (ev.t === "log" || ev.t === "stage") setProgress(ev.msg || ev.label);
        if (ev.t === "result") renderVideo(ev.result);
        if (ev.t === "error") { toast(ev.msg, "error", 8000); box("vidResult").innerHTML = `<div class="card">${esc(ev.msg)}</div>`; }
      });
    } catch (e) { toast(e.message, "error"); }
  });
}


/** Показує точні цифри відео, криву утримання, темпоритм і коментарі. */
function renderRealVideo(d) {
  const v = d.video || {};
  const r = d.retention;
  const m = d.pacing;
  const stat = (label, value) => `<div class="mini"><span class="muted">${esc(label)}</span><b>${value}</b></div>`;
  const ratio = v.subscribers ? (v.views / v.subscribers) : null;
  box("vidResult").innerHTML = `
  <div class="card glow">
    <h2 style="font-size:20px">${esc((v.title || "").slice(0, 90))}</h2>
    <div class="muted" style="margin-bottom:12px">${esc(v.channel || "")}${v.publishedAt ? " · " + new Date(v.publishedAt).toLocaleDateString("uk-UA") : ""}${v.duration ? " · довжина " + Math.round(v.duration / 60) + " хв" : ""}</div>
    <div class="grid g4" style="gap:10px">
      ${stat("Перегляди", num(v.views))}
      ${stat("Лайки", v.likes != null ? num(v.likes) : "—")}
      ${stat("Коментарі", v.comments != null ? num(v.comments) : "—")}
      ${stat("Підписники", v.subscribers ? num(v.subscribers) : "приховано")}
    </div>
    ${ratio ? `<div style="margin-top:12px">Перегляди ÷ підписники: <b style="color:#b6ff3d">${ratio.toFixed(2)}×</b>${ratio >= 3 ? " — відео вирвалося за межі власної аудиторії" : ""}</div>` : ""}
  </div>
  ${r && r.ok ? `<div class="card">
    <h2>Крива уваги аудиторії</h2>
    <p class="muted" style="margin-bottom:10px">Офіційні дані YouTube про увагу до відео. Нормовано до найвищої точки, тому це рельєф уваги, а не відсоток утримання.</p>
    ${retentionSvg(r)}
    <div class="grid g4" style="margin-top:12px;gap:10px">
      ${stat("Старт відносно піку", (r.startVsPeak ?? r.hookRetention) != null ? Math.round((r.startVsPeak ?? r.hookRetention) * 100) + "%" : "—")}
      ${stat("Чверть", r.retentionAt25pct != null ? Math.round(r.retentionAt25pct * 100) + "%" : "—")}
      ${stat("Середина відносно піку", (r.midVsPeak ?? r.retentionAt50pct) != null ? Math.round((r.midVsPeak ?? r.retentionAt50pct) * 100) + "%" : "—")}
      ${stat("Кінець відносно піку", (r.endVsPeak ?? r.endRetention) != null ? Math.round((r.endVsPeak ?? r.endRetention) * 100) + "%" : "—")}
    </div>
    ${r.biggestDrop ? `<div class="muted" style="margin-top:12px"><b>Найглибший спад:</b> на ${Math.round(r.biggestDrop.fromSec)}–${Math.round(r.biggestDrop.toSec)} с увага падає на ${Math.round(r.biggestDrop.drop * 100)}%. Це найслабше місце відео.</div>` : ""}
  </div>` : `<div class="card"><h2>Крива утримання</h2><p class="muted">${esc(r?.reason || "Недоступна для цього відео.")}</p></div>`}
  ${m && m.words ? `<div class="card">
    <h2>Темпоритм мовлення</h2>
    <div class="grid g4" style="gap:10px">
      ${stat("Слів за хвилину", m.wordsPerMinute)}
      ${stat("Усього слів", num(m.words))}
      ${stat("Найдовша пауза", m.longestPauseSec + " с")}
      ${stat("Пауз понад 1,5 с", m.pauseCount)}
    </div>
    ${m.warn ? `<div class="muted" style="margin-top:10px;color:#ffb84d">${esc(m.warn)}</div>` : ""}
    <div class="muted" style="margin-top:10px">Норма для щільної подачі — 130–180 слів за хвилину. Понад 220 зазвичай означає збій транскрипту.</div>
  </div>` : ""}
  ${d.topComments?.length ? `<div class="card"><h2>Що пишуть у коментарях</h2>
    <div class="grid" style="gap:8px">${d.topComments.slice(0, 6).map((c) => `<div class="mini"><span class="muted">${esc((c.author || "").slice(0, 24))}${c.likes != null ? " · " + num(c.likes) + " ♥" : ""}</span><b style="font-size:13.5px;font-weight:500;line-height:1.5">${esc((c.text || "").slice(0, 260))}</b></div>`).join("")}</div>
  </div>` : ""}`;
}
function renderChannel(res) {
  const a = res.analysis || {};
  const r = a.reality || {};
  const real = r.stats || {};
  const ch = r.channel || a.channel || {};
  box("chResult").innerHTML = `
  <div class="card glow">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div>
        <h2 style="font-size:21px;margin-bottom:6px">${esc(ch.title || a.channel?.title || "Канал")}</h2>
        <div class="row">
          ${badge(num(ch.subs || a.channel?.subs) + " підписників", "b-info")}
          ${badge(num(ch.videoCount || a.channel?.videos) + " відео", "b-mute")}
          ${real.medianViews ? badge("медіана " + num(real.medianViews) + " переглядів", "b-acc") : ""}
          ${a.cadence?.perWeek ? badge("~" + a.cadence.perWeek + " відео/тиждень", "b-mute") : ""}
        </div>
      </div>
      ${real.medianViews && real.top10Avg ? ring(Math.min(10, (real.top10Avg / Math.max(1, real.medianViews)) * 3), 80, 7, "сила топу") : ""}
    </div>
    ${a.verdict ? `<p class="muted" style="margin-top:14px;line-height:1.6">${esc(a.verdict)}</p>` : ""}
  </div>
  <div class="split">
    <div class="card">
      <h2>Прогалини, які можна зайняти</h2>
      ${(r.gaps || a.gaps || []).length ? `<ul class="tight">${(r.gaps || a.gaps).map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : '<div class="muted">—</div>'}
      ${listBlock("Що варто взяти з їхнього підходу", a.stealList)}
    </div>
    <div class="card">
      <h2>Патерни упаковки</h2>
      ${a.patterns ? `<div class="kv">
        <b>Заголовки</b><span>${esc(a.patterns.titles || "—")}</span>
        <b>Прев'ю</b><span>${esc(a.patterns.thumbnails || "—")}</span>
        <b>Тривалість</b><span>${esc(a.patterns.lengths || "—")}</span>
        <b>Формати</b><span>${esc((a.patterns.formats || []).join(", ") || "—")}</span>
      </div>` : ""}
      ${a.monetization ? `<h3 style="margin-top:14px">Монетизація</h3><div class="muted">${esc(a.monetization.estimate || "")}</div>
        <ul class="tight">${(a.monetization.paths || []).map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
    </div>
  </div>
  ${(a.outliers || r.outliers || []).length ? `<div class="card"><h2>Вибухові відео (× до медіани)</h2>
    <table><thead><tr><th>Відео</th><th>Перегляди</th><th>Множник</th><th>Чому зайшло</th></tr></thead><tbody>
    ${(a.outliers || r.outliers).map((o) => `<tr><td>${esc(o.title)}</td><td>${num(o.views)}</td><td><b style="color:#b6ff3d">×${o.multiple ?? "—"}</b></td><td class="muted">${esc(o.why || "")}</td></tr>`).join("")}
    </tbody></table></div>` : ""}
  ${r.uploadsByMonth ? `<div class="card"><h2>Каденс публікацій (останні місяці)</h2>${sparkline(r.uploadsByMonth, { w: 720, h: 90 })}</div>` : ""}
  ${(r.recentVideos || []).length ? `<div class="card"><h2>Останні відео</h2>
    <div style="max-height:420px;overflow:auto"><table><thead><tr><th>Назва</th><th>Перегляди</th><th>Вподобання</th><th>Дата</th></tr></thead><tbody>
    ${r.recentVideos.map((v) => `<tr><td><a href="https://youtu.be/${esc(v.videoId)}" target="_blank" style="color:#9be9f6;text-decoration:none">${esc(v.title)}</a></td><td>${num(v.views)}</td><td>${num(v.likes)}</td><td class="tiny">${esc(String(v.publishedAt).slice(0, 10))}</td></tr>`).join("")}
    </tbody></table></div></div>` : ""}`;
}

function renderThumbs(res) {
  const a = res.analysis || {};
  const thumbs = res.thumbnails || [];
  box("thResult").innerHTML = `
  <div class="card glow">
    <h2>Вердикт по упаковці</h2>
    <p class="muted" style="line-height:1.6;margin:0">${esc(a.overall || "")}</p>
    ${res.summary ? `<div class="row" style="margin-top:12px">${badge(res.summary.thumbnails + " прев'ю проаналізовано", "b-info")}${badge(res.summary.model, "b-mute")}${res.reality?.channel ? badge(num(res.reality.channel.subs) + " підписників", "b-mute") : ""}</div>` : ""}
  </div>
  <div class="grid g4">${thumbs.map((t, i) => `
    <div class="card" style="padding:0;overflow:hidden">
      <img src="${esc(t.imageUrl)}" alt="" style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#0a0f1a">
      <div style="padding:11px">
        <div class="tiny" style="margin-bottom:4px">№${i + 1} · ${num(t.views)} переглядів</div>
        <b style="font-size:12.5px;line-height:1.35;display:block">${esc(t.title)}</b>
      </div>
    </div>`).join("")}</div>
  <div class="split">
    <div class="card">${listBlock("Спільні прийоми, які працюють", a.commonPatterns)}${listBlock("Що зроблено сильно", a.strengths)}${listBlock("Слабкі місця — і як цим скористатися", a.weaknesses)}</div>
    <div class="card">${(a.perThumbnail || []).length ? `<h3>Розбір кожного прев'ю</h3><ul class="tight">${a.perThumbnail.map((t) => `<li><b>№${t.index}: ${esc(t.what || "")}</b> — ${esc(t.why || "")}${t.score != null ? ` <span class="tiny">(${t.score}/10)</span>` : ""}${t.fix ? `<br><span class="muted">Покращити: ${esc(t.fix)}</span>` : ""}</li>`).join("")}</ul>` : ""}</div>
  </div>
  <div class="grid g2">
    <div class="card"><h3>Мої концепти прев'ю</h3>${(a.myConcept || []).map((c) => `<div style="border:1px solid var(--stroke);border-radius:11px;padding:11px;margin-bottom:9px">
      <b>${esc(c.concept || "")}</b>
      <div class="muted" style="margin-top:6px">Розташування: ${esc(c.layout || "")}</div>
      <div class="muted">Текст: «${esc(c.text || "")}»</div>
      <div class="tiny" style="margin-top:6px">${esc(c.why || "")}</div></div>`).join("") || '<div class="muted">—</div>'}</div>
    <div class="card">${listBlock("План A/B тестів", a.testPlan)}</div>
  </div>`;
}

function renderGap(res, seed) {
  const clusters = res.clusters || [];
  box("gapResult").innerHTML = `
  <div class="card"><h2>Кластери довгого хвоста для «${esc(seed)}»</h2>
    <div class="muted">Знайдено ${clusters.length} кластерів. Сортування — за індексом можливості (попит проти конкуренції).</div></div>
  ${clusters.map((c, i) => `
    <div class="card hover">
      <div class="row" style="justify-content:space-between">
        <div><b style="font-size:15px">#${i + 1} · ${esc(c.cluster)}</b>
          ${c.why ? `<div class="muted" style="margin-top:6px">${esc(c.why)}</div>` : ""}</div>
        ${c.opportunity != null ? ring(c.opportunity, 62, 6, "можливість") : ""}
      </div>
      <div class="grid g4" style="margin-top:12px">
        <div><div class="tiny">Попит</div><b>${num(c.demand, 1)}/10</b></div>
        <div><div class="tiny">Конкуренція</div><b>${num(c.competition, 1)}/10</b></div>
        ${c.reality ? `<div><div class="tiny">Медіана переглядів</div><b>${num(c.reality.medianViews)}</b></div>
        <div><div class="tiny">YT-можливість</div><b>${num(c.reality.opportunityIndex, 1)}/10</b></div>` : ""}
      </div>
      <div class="chips" style="margin-top:12px">${(c.keywords || []).map((k) => `<span class="tag">${esc(k)}</span>`).join("")}</div>
    </div>`).join("")}`;
}

function renderVideo(res) {
  const a = res.analysis || {};
  const v = a.video || {};
  const r = res.reality || {};
  box("vidResult").innerHTML = `
  <div class="card glow">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div>
        <h2 style="font-size:19px;margin-bottom:8px">${esc(r.video?.title || v.title || "Відео")}</h2>
        <div class="row">
          ${badge(num(r.video?.views ?? v.views) + " переглядів", "b-info")}
          ${r.channel ? badge(num(r.channel.subs) + " підписників каналу", "b-mute") : ""}
          ${r.video?.likes ? badge(num(r.video.likes) + " вподобань", "b-mute") : ""}
        </div>
      </div>
      ${r.video && r.channel?.videoCount ? ring(Math.min(10, (r.video.views / Math.max(1, r.channel.views / r.channel.videoCount)) * 2), 80, 7, "× до каналу") : ""}
    </div>
  </div>
  <div class="split">
    <div class="card">${listBlock("Чому зайшло", a.whyItWorked)}${listBlock("Як зробити краще", a.howToBeat)}</div>
    <div class="card">${listBlock("Кути для сильнішого відео", a.angles)}
      ${a.packaging ? `<h3 style="margin-top:10px">Упаковка</h3><div class="kv"><b>Заголовок</b><span>${esc(a.packaging.title || "")}</span><b>Прев'ю</b><span>${esc(a.packaging.thumbnail || "")}</span></div>` : ""}
      ${a.hook ? `<h3 style="margin-top:10px">Хук</h3><div class="muted">${esc(a.hook)}</div>` : ""}
    </div>
  </div>`;
}
