// lib/modules.mjs — модульні оновлення застосунку.
//
// Ідея: застосунок складається з модулів (інтерфейс, логіка, сервер, довідка),
// і кожен можна оновити окремо, не перевстановлюючи програму. Це важливо, бо
// інсталятор важить 100+ МБ, а виправлення в інтерфейсі — це кілька кілобайтів.
//
// Як це працює:
//  1. У репозиторії лежить manifest.json — перелік файлів застосунку з їхніми
//     хешами. Його оновлює скрипт scripts/make-manifest.mjs, а збірка стежить,
//     щоб він не застарів.
//  2. Застосунок читає останній реліз на GitHub, тягне звідти manifest.json
//     і порівнює хеші з тим, що лежить на диску.
//  3. Користувач бачить, які модулі застаріли, і оновлює вибране.
//
// Безпека: кожен завантажений файл звіряється з хешем із маніфесту; перед
// заміною робиться резервна копія; дані користувача не чіпаються взагалі.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./config.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Адреси можна перевизначити змінними середовища — це потрібно тестам і
// форкам репозиторію, які публікують власні збірки.
const REPO = process.env.CARTEL_RADAR_UPDATE_REPO || "gitkalenyuk/cartel-radar";
const API_BASE = process.env.CARTEL_RADAR_UPDATE_API || "https://api.github.com";
const RAW_BASE = process.env.CARTEL_RADAR_UPDATE_RAW || "https://raw.githubusercontent.com";

/** Що саме вважаємо модулем. Порядок важливий — від найважливішого. */
export const MODULE_GROUPS = [
  { id: "ui", name: "Інтерфейс", hint: "вікно, кнопки, таблиці, стилі", prefixes: ["public/"] },
  { id: "lib", name: "Логіка", hint: "аналітика, двигун, провайдери, дані YouTube", prefixes: ["lib/"] },
  { id: "server", name: "Сервер", hint: "локальний сервер застосунку", prefixes: ["server.mjs"] },
  { id: "docs", name: "Довідка", hint: "вбудована документація", prefixes: ["docs/"] },
];

export function groupOf(file) {
  const f = String(file).replace(/^\\+/, "");
  for (const g of MODULE_GROUPS) {
    if (g.prefixes.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p))) return g;
  }
  return null;
}

export function appRoot() { return APP_ROOT; }

/** Тека, куди кладемо оновлення, якщо тека застосунку недоступна для запису. */
export function overlayDir() { return path.join(DATA_DIR, "modules", "files"); }
export function backupDir() { return path.join(DATA_DIR, "modules", "backups"); }
export function stateFile() { return path.join(DATA_DIR, "modules", "state.json"); }

export async function readUpdateState() {
  try { return JSON.parse(await fs.readFile(stateFile(), "utf8")); } catch { return null; }
}

async function writeUpdateState(state) {
  await fs.mkdir(path.dirname(stateFile()), { recursive: true });
  await fs.writeFile(stateFile(), JSON.stringify(state, null, 2));
}

export function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }

/** Локальний стан файлів: що лежить на диску і чи доступне воно для запису. */
export async function localState(files) {
  const out = {};
  for (const f of files) {
    try {
      const buf = await fs.readFile(path.join(APP_ROOT, f));
      out[f] = { hash: sha256(buf), size: buf.length };
    } catch { out[f] = null; }
  }
  return out;
}

/** Чи можна взагалі писати в теку застосунку (у зібраному вигляді буває ні). */
export async function appDirWritable() {
  try {
    const probe = path.join(APP_ROOT, ".write-probe");
    await fs.writeFile(probe, "1");
    await fs.unlink(probe);
    return true;
  } catch { return false; }
}

// ── мережа ────────────────────────────────────────────────────────────────
async function getJSON(url, timeoutMs = 15000) {
  const res = await fetch(url, {
    headers: { "Accept": "application/vnd.github+json", "User-Agent": "Cartel-Radar" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} від ${url}`);
  return res.json();
}

export async function fetchLatestRelease() {
  const j = await getJSON(`${API_BASE}/repos/${REPO}/releases/latest`);
  return {
    tag: j.tag_name,
    name: j.name || j.tag_name,
    url: j.html_url,
    publishedAt: j.published_at,
    notes: String(j.body || "").slice(0, 4000),
  };
}

export function rawURL(tag, file) {
  return `${RAW_BASE}/${REPO}/${tag}/${file}`;
}

export async function fetchManifest(tag) {
  const res = await fetch(rawURL(tag, "manifest.json"), {
    headers: { "User-Agent": "Cartel-Radar" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Не вдалося прочитати перелік файлів (${res.status})`);
  const j = await res.json();
  if (!j || typeof j.files !== "object") throw new Error("Перелік файлів має неочікуваний вигляд");
  return j;
}

/**
 * Порівнює те, що на диску, з тим, що в останньому релізі.
 * Повертає стан кожного модуля окремо — щоб можна було оновити лише потрібне.
 */
export async function checkUpdates() {
  const release = await fetchLatestRelease();
  const manifest = await fetchManifest(release.tag);
  const files = Object.keys(manifest.files);
  const local = await localState(files);

  const groups = MODULE_GROUPS.map((g) => ({ ...g, files: [], changed: [], missing: [], total: 0 }));
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));

  for (const f of files) {
    const g = groupOf(f);
    if (!g) continue;
    const grp = byId[g.id];
    grp.total++;
    const want = manifest.files[f];
    const have = local[f];
    if (!have) { grp.missing.push(f); grp.files.push({ file: f, status: "missing", size: want.size }); }
    else if (have.hash !== want.hash) { grp.changed.push(f); grp.files.push({ file: f, status: "changed", size: want.size }); }
    else grp.files.push({ file: f, status: "current", size: want.size });
  }

  const currentVersion = await localVersion();
  return {
    ok: true,
    release,
    manifestVersion: manifest.version || null,
    currentVersion,
    upToDate: groups.every((g) => g.changed.length === 0 && g.missing.length === 0),
    writable: await appDirWritable(),
    lastUpdate: await readUpdateState(),
    groups: groups.map((g) => ({
      id: g.id, name: g.name, hint: g.hint,
      total: g.total,
      changed: g.changed.length,
      missing: g.missing.length,
      outdated: g.changed.length + g.missing.length,
      files: g.files,
    })),
  };
}

async function localVersion() {
  try {
    return JSON.parse(await fs.readFile(path.join(APP_ROOT, "package.json"), "utf8")).version || null;
  } catch { return null; }
}

/**
 * Завантажує й застосовує вибрані файли.
 * Спочатку пробуємо покласти у теку застосунку (звичайний випадок), а якщо
 * вона недоступна для запису — у теку даних, звідки сервер віддає файли
 * інтерфейсу як запасний варіант.
 */
export async function applyUpdates(files, { tag, onProgress } = {}) {
  if (!tag) throw new Error("Не вказано версію для оновлення");
  const wanted = [...new Set((files || []).map((f) => String(f).replace(/^\\+/, "")))];
  if (!wanted.length) throw new Error("Не вибрано жодного файлу");

  const manifest = await fetchManifest(tag);
  const writable = await appDirWritable();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(backupDir(), stamp);
  const results = [];
  let done = 0;

  for (const file of wanted) {
    const want = manifest.files[file];
    onProgress?.({ file, done, total: wanted.length });
    if (!want) { results.push({ file, ok: false, reason: "немає в переліку" }); continue; }
    if (groupOf(file) === null) { results.push({ file, ok: false, reason: "не належить до жодного модуля" }); continue; }

    try {
      const res = await fetch(rawURL(tag, file), { headers: { "User-Agent": "Cartel-Radar" }, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`сервер відповів ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());

      // головна перевірка: вміст мусить збігатися з хешем із маніфесту
      const got = sha256(buf);
      if (want.hash && got !== want.hash) throw new Error("вміст не збігається з переліком — оновлення скасовано");

      const local = path.join(APP_ROOT, file);
      try {
        await fs.mkdir(path.dirname(path.join(backup, file)), { recursive: true });
        await fs.copyFile(local, path.join(backup, file));
      } catch { /* файлу могло не бути — це нормально */ }

      let where = "app";
      if (writable) {
        await fs.mkdir(path.dirname(local), { recursive: true });
        const tmp = local + ".new";
        await fs.writeFile(tmp, buf);
        await fs.rename(tmp, local);
      } else {
        const target = path.join(overlayDir(), file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, buf);
        where = "overlay";
      }
      results.push({ file, ok: true, where });
    } catch (e) {
      results.push({ file, ok: false, reason: String(e.message || e) });
    }
    done++;
  }

  const okCount = results.filter((r) => r.ok).length;
  const state = {
    tag,
    version: manifest.version || null,
    at: Date.now(),
    files: results.filter((r) => r.ok).map((r) => r.file),
    failed: results.filter((r) => !r.ok).map((r) => ({ file: r.file, reason: r.reason })),
  };
  if (okCount) await writeUpdateState(state);

  return {
    ok: okCount > 0,
    updated: okCount,
    failed: results.length - okCount,
    results,
    backup: okCount ? backup : null,
    where: writable ? "app" : "overlay",
    // сервер і логіку Node підхопить лише після перезапуску застосунку
    restartRequired: results.some((r) => r.ok && ["lib", "server"].includes(groupOf(r.file)?.id)),
    state,
  };
}

/** Прибирає стару теку оновлень (після повного перевстановлення вона зайва). */
export async function clearOverlay() {
  await fs.rm(overlayDir(), { recursive: true, force: true });
  await fs.rm(stateFile(), { force: true });
  return true;
}

export function dataDir() { return DATA_DIR; }
export function homedir() { return os.homedir(); }
