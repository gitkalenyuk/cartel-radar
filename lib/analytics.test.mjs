// lib/analytics.test.mjs — самоперевірка аналітики без залежностей: node lib/analytics.test.mjs
import * as A from "./analytics.mjs";

let passed = 0;
const ok = (name, cond, extra = "") => {
  if (!cond) { console.error("✗ " + name + (extra ? " → " + extra : "")); process.exit(1); }
  passed++; console.log("✓ " + name);
};
const eq = (name, a, b) => ok(name, a === b, `отримано ${JSON.stringify(a)}, очікували ${JSON.stringify(b)}`);

// Дата без часу (YYYYMMDD) — так YouTube віддає дату публікації.
const days = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
// Точний момент N діб тому. Потрібен там, де перевіряємо саме число діб:
// у дати без часу доба неповна, і результат залежить від години запуску.
const daysAgoExact = (n) => new Date(Date.now() - n * 86400000).toISOString();

// ── 1. швидкість ──
eq("speed: 1000 переглядів за 10 діб = 100/добу", A.speed({ views: 1000, date: daysAgoExact(10) }), 100);
// Дата без часу: минуло 10 діб і скількись годин, тож округлення дає 10 або 11
// залежно від години запуску. Фіксуємо це як відому властивість, а не як
// випадковість: саме через неї тест падав щоразу після 12:00 UTC.
ok("speed: дата без часу округлюється до 10 або 11 діб",
  [100, 90.9].includes(A.speed({ views: 1000, date: days(10) })));
ok("speed: без дати → null", A.speed({ views: 1000 }) === null);

// ── 2. медіана й середнє ──
eq("median непарної кількості", A.median([1, 5, 3]), 3);
eq("median парної кількості", A.median([1, 2, 3, 4]), 3);
eq("mean", A.mean([10, 20, 30]), 20);

// ── 3. хіти/провали ──
const mk = (views, ageDays, exact = true) => ({ id: "v" + views, title: "t" + views, views, date: days(ageDays), dateExact: exact });
const pool = [mk(100, 10), mk(120, 10), mk(90, 10), mk(110, 10), mk(130, 10), mk(95, 10), mk(105, 10), mk(1000, 10), mk(80, 10), mk(85, 10)];
const o = A.outliers(pool, { hits: 3, flops: 2 });
ok("outliers: достатньо даних → conclusive", o.conclusive);
eq("outliers: хіт №1 — найбільше переглядів", o.hits[0].views, 1000);
ok("хіти й провали не перетинаються", !o.hits.some((h) => o.flops.some((f) => f.id === h.id)));
ok("trueOutliers містить відео з кратністю ≥3", o.trueOutliers.length === 1 && o.trueOutliers[0].views === 1000);
ok("кратність пораxована", o.hits[0].xMedian > 8);

const small = A.outliers([mk(100, 5), mk(200, 5)], {});
ok("outliers: мало відео → не conclusive", small.conclusive === false);
ok("outliers: мало відео → trueOutliers порожні", small.trueOutliers.length === 0);
ok("outliers: у примітці попередження", small.note.includes("НЕПЕВНИЙ"));

const approx = A.outliers([{ id: "a", views: 500, date: days(10) }, { id: "b", views: 1500, date: days(10) }, { id: "c", views: 700, date: days(10) }, { id: "d", views: 900, date: days(10) }], {});
ok("метрика перегляди/добу, коли дати приблизні", approx.metric.includes("приблизні"), approx.metric);
const noDates = A.outliers([{ id: "a", views: 500 }, { id: "b", views: 1500 }, { id: "c", views: 700 }, { id: "d", views: 900 }], {});
ok("метрика «перегляди», коли дат немає", noDates.metric.includes("дати ненадійні"), noDates.metric);

// ── 4. заголовки ──
const ts = A.titleStats([{ title: "Як зробити сонячну панель" }, { title: "Як обрати інвертор" }, { title: "Чому це працює" }]);
eq("titleStats: кількість", ts.count, 3);
ok("titleStats: знайшов повторюваний зачин «як»", ts.repeatedOpenings.some((r) => r.word === "як" && r.count === 2));

// ── 5. набір для читання ──
const rs = A.referenceReadSet(pool, o);
ok("readSet: ролі не повторюються", new Set(rs.map((r) => r.video.id)).size === rs.length);
ok("readSet: найсильніше й найслабше є завжди", rs.some((r) => r.role === "strongest") && rs.some((r) => r.role === "weakest"));
// різні дати → чотири різні відео на чотири ролі
const diverse = [30, 120, 400, 60, 200, 15, 900, 45, 300, 150].map((age, i) => mk(100 + i * 37, age));
const rs2 = A.referenceReadSet(diverse, A.outliers(diverse, { hits: 1, flops: 1 }));
ok("readSet: 4 різні відео, коли дані різноманітні", rs2.length === 4);
ok("readSet: усі ролі присутні", ["strongest", "weakest", "typical", "recent"].every((r) => rs2.some((x) => x.role === r)), rs2.map((r) => r.role).join(","));

// ── 6. темпоритм ──
const cues = [{ start: 0, end: 2, text: "один два три чотири" }, { start: 2, end: 4, text: "п'ять шість сім вісім" }];
const m = A.measure(cues, 60);
eq("measure: слів", m.words, 8);
eq("measure: слів за хвилину", m.wordsPerMinute, 8);
ok("measure: попередження при понад 220 слів/хв", A.measure([{ start: 0, end: 10, text: Array(60).fill("слово").join(" ") }], 10).warn !== null);

// ── 7. якість транскрипту ──
const q = A.transcriptQuality([], null, 100);
ok("transcriptQuality: без субтитрів → not ok", q.ok === false && q.score === 0);

// ── 8. радар ──
const cand = [
  { videoId: "1", title: "Малий канал, вибух", views: 300000, subscribers: 10000, duration: 600, publishedAt: new Date(Date.now() - 30 * 86400000).toISOString(), channel: "A" },
  { videoId: "2", title: "Занадто великий канал", views: 5000000, subscribers: 900000, duration: 600, publishedAt: new Date(Date.now() - 30 * 86400000).toISOString(), channel: "B" },
  { videoId: "3", title: "Старе відео", views: 300000, subscribers: 10000, duration: 600, publishedAt: new Date(Date.now() - 900 * 86400000).toISOString(), channel: "C" },
  { videoId: "4", title: "Шортс", views: 900000, subscribers: 10000, duration: 30, publishedAt: new Date(Date.now() - 10 * 86400000).toISOString(), channel: "D" },
  { videoId: "5", title: "Приховані підписники, мало переглядів", views: 40000, subscribers: null, duration: 600, publishedAt: new Date(Date.now() - 10 * 86400000).toISOString(), channel: "E" },
];
const rd = A.filterAndRankRadar(cand);
ok("радар: лишився тільки малий канал", rd.breakouts.length === 1 && rd.breakouts[0].videoId === "1");
eq("радар: кратність перегляди/підписники", rd.breakouts[0].outlierRatio, 30);
ok("радар: великий канал відсіяно", !rd.breakouts.some((b) => b.videoId === "2"));
ok("радар: старе відсіяно", !rd.breakouts.some((b) => b.videoId === "3"));
ok("радар: шортс відсіяно", !rd.breakouts.some((b) => b.videoId === "4"));
ok("радар: приховані підписники + <50000 переглядів відсіяно", !rd.breakouts.some((b) => b.videoId === "5"));
ok("радар: конкуренти агреговані", rd.competitors.length >= 1 && rd.competitors[0].channel === "A");

// ── 9. утримання ──
ok("retention: мало точок → not ok", A.retentionFromHeatmap([{ start_time: 0, end_time: 1, value: 1 }]).ok === false);
const heat = Array.from({ length: 100 }, (_, i) => ({ start_time: i * 10, end_time: i * 10 + 10, value: Math.max(0.05, 1 - i * 0.009) }));
const ret = A.retentionFromHeatmap(heat);
ok("retention: ok", ret.ok === true);
eq("retention: точок", ret.points, 100);
ok("retention: утримання на старті високе", ret.hookRetention > 0.9);
ok("retention: утримання в кінці нижче", ret.endRetention < ret.hookRetention);
ok("retention: знайдено найбільший обрив", ret.biggestDrop && ret.biggestDrop.drop > 0);
eq("retention: крива нормалізована 0..1", Math.round(ret.curve[ret.curve.length - 1].t * 100) / 100, 0.99);

// ── 10. прокрутка субтитрів ──
const rolling = [
  { start: 0, end: 2, text: "For the last 20 years the standard" },
  { start: 2, end: 3, text: "For the last 20 years the standard" },
  { start: 3, end: 5, text: "For the last 20 years the standard silicon panel" },
  { start: 5, end: 7, text: "attached to your roof has been" },
];
const ded = A.dedupeRolling(rolling);
ok("прокрутка: дублікати прибрано", ded.length === 3, JSON.stringify(ded.map((c) => c.text)));
eq("прокрутка: перший рядок без змін", ded[0].text, "For the last 20 years the standard");
eq("прокрутка: другий рядок — лише нове слово", ded[1].text, "silicon panel");
ok("прокрутка: слова не рахуються двічі", A.measure(rolling, 7).words === 15, String(A.measure(rolling, 7).words));
ok("прокрутка: наївний підрахунок був би більшим",
  rolling.reduce((s, c) => s + c.text.split(" ").length, 0) > A.measure(rolling, 7).words);

// ── 11. крива уваги: чесні назви й нормування до піку ──
const warm = Array.from({ length: 50 }, (_, i) => ({ start_time: i * 10, end_time: i * 10 + 10, value: i === 20 ? 1 : 0.5 }));
const rr = A.retentionFromHeatmap(warm);
ok("крива: позначена як нормалізована", rr.normalized === true);
eq("крива: пік знайдено", rr.peakAtSec, 200);
ok("крива: старт відносно піку = 0.5", rr.startVsPeak === 0.5);
ok("крива: є показник рівності", typeof rr.steadiness === "number" && rr.steadiness >= 0 && rr.steadiness <= 1);
ok("крива: basis пояснює природу даних", String(rr.basis).includes("не відсоток утримання"));

console.log(`\nУСІ ПЕРЕВІРКИ ПРОЙДЕНО (${passed})`);
