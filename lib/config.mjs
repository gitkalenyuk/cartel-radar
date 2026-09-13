// lib/config.mjs — конфіг і дані на диску (лише локально, chmod 600)
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Тека даних залежить від системи: на Windows не існує ~/Library, а на Linux
 * прийнято тримати дані в XDG-теці. Однаковий шлях для всіх систем ламався б
 * на Windows при першому ж записі конфігу.
 */
function platformDataDir() {
  if (process.platform === "win32") {
    const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "CartelRadar", "data");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "CartelRadar", "data");
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "CartelRadar", "data");
}

export const DATA_DIR = process.env.CARTEL_RADAR_DATA || process.env.NICHE_RADAR_DATA || platformDataDir();

export const LEGACY_DIRS = [
  // стара назва застосунку — ключі користувача могли лишитися там
  path.join(os.homedir(), "Library", "Application Support", "NicheRadar", "data"),
  path.join(os.homedir(), "Applications", "NicheRadar", "data"),
  path.join(os.homedir(), "Applications", "CartelRadar", "data"),
  // Windows: дані могли лишитися в старій теці застосунку
  path.join(process.env.APPDATA || os.homedir(), "NicheRadar", "data"),
  path.join(process.cwd(), "data"),
  path.join(process.cwd(), "..", "..", "data"),
];

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

/** Одноразовий перенос даних зі старої теки (у т.ч. зсередини .app) у постійну. */
export async function migrateLegacyData() {
  if (await exists(path.join(DATA_DIR, "config.json"))) return null;
  // Якщо старих тек кілька — беремо НАЙСВІЖІШУ: інакше можна перенести старі ключі
  // замість тих, які людина щойно додала.
  const candidates = [];
  for (const dir of LEGACY_DIRS) {
    if (path.resolve(dir) === path.resolve(DATA_DIR)) continue;
    const cfgFile = path.join(dir, "config.json");
    if (!(await exists(cfgFile))) continue;
    const st = await fs.stat(cfgFile).catch(() => null);
    candidates.push({ dir, mtime: st ? st.mtimeMs : 0 });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const { dir } of candidates) {
    await ensureDataDir();
    for (const f of ["config.json", "niches.json", "history.json", "pipeline.json"]) {
      if (await exists(path.join(dir, f))) await fs.copyFile(path.join(dir, f), path.join(DATA_DIR, f));
    }
    if (await exists(path.join(dir, "runs"))) {
      await fs.cp(path.join(dir, "runs"), path.join(DATA_DIR, "runs"), { recursive: true });
    }
    return dir;
  }
  return null;
}

const DEFAULTS = {
  version: 1,
  providers: {},
  customProviders: [],
  routing: {
    discovery: { provider: "", model: "" },
    screening: { provider: "", model: "" },
    deepdive: { provider: "", model: "" },
    vision: { provider: "", model: "" },
    copy: { provider: "", model: "" },
    auto: true,
  },
  run: {
    concurrency: 6,
    breadthAgents: 6,
    maxCandidates: 90,
    topN: 12,
    deepDiveCount: 6,
    temperature: 0.85,
    maxTokens: 6000,
    requestTimeoutMs: 180000,
    retries: 2,
    costCapUsd: 8,
    hltb: 0,
    demandFloor: 0,
  },
  scoring: {
    weights: {
      demand: 20, competition: 16, monetization: 14, novelty: 12,
      evergreen: 10, faceless: 8, aiProducible: 6, ease: 6, growth: 8,
    },
  },
  // mode: auto — якщо є вбудований yt-dlp, реальні дані працюють одразу, без ключа
  youtube: { mode: "auto", apiKey: "", region: "US", hl: "en", sampleSize: 12 },
  markets: { langs: ["en"], regions: ["US"], outputLang: "uk", includeGlobal: true },
  personas: [
    { id: "trend", name: "Мисливець за трендами", on: true, brief: "Шукає теми на ранній фазі зростання: нові інструменти, зміни в поведінці, свіжі хвилі попиту." },
    { id: "gap", name: "Шукач прогалин", on: true, brief: "Шукає прогалини: те що має попит, але якісно не закрито на YouTube." },
    { id: "money", name: "Монетизатор", on: true, brief: "Шукає ніші з найвищим RPM: фінанси, B2B, SaaS, здоров'я, нерухомість, кар'єра." },
    { id: "psych", name: "Психолог аудиторії", on: true, brief: "Йде від болю й бажань аудиторії: страхи, мрії, нерозв'язані задачі." },
    { id: "geo", name: "Локалізатор", on: true, brief: "Знаходить ніші, що працюють в одній країні та ще не адаптовані в інших." },
    { id: "format", name: "Режисер формату", on: true, brief: "Йде від формату: нові формати упаковки (серіали, челенджі, тести, документалки) — і шукає теми під них." },
    { id: "skeptic", name: "Скептик", on: false, brief: "Знаходить ніші, які всі вважають мертвими, але де новачки ще перемагають." },
    { id: "ai", name: "AI-фабрика", on: false, brief: "Ніші, які можна робити без обличчя й майже повністю автоматизувати." },
  ],
  ui: { theme: "radar", compact: false },
};

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch;
  if (patch && typeof patch === "object") {
    const out = Array.isArray(base) ? [] : { ...(base || {}) };
    for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base?.[k], v);
    return out;
  }
  return patch;
}

export async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, "runs"), { recursive: true });
}

/** Запис провайдера без ключа, моделей і без явного збереження — фантом (раніше їх плодив порожній «Зберегти»). */
function isPhantomProvider(rec) {
  if (!rec || typeof rec !== "object") return true;
  if (rec.apiKey) return false;
  if (Array.isArray(rec.models) && rec.models.length) return false;
  if (rec.custom) return false;
  return !rec.savedAt;
}

function prunePhantoms(cfg) {
  const kept = {};
  for (const [id, rec] of Object.entries(cfg.providers || {})) if (!isPhantomProvider(rec)) kept[id] = rec;
  cfg.providers = kept;
  return cfg;
}

export async function loadConfig() {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, "config.json"), "utf8");
    return prunePhantoms(deepMerge(DEFAULTS, JSON.parse(raw)));
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export async function saveConfig(cfg) {
  await ensureDataDir();
  const file = path.join(DATA_DIR, "config.json");
  await fs.writeFile(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { await fs.chmod(file, 0o600); } catch {}
  return cfg;
}

export async function patchConfig(patch) {
  const cfg = await loadConfig();
  const next = deepMerge(cfg, patch);
  await saveConfig(next);
  return next;
}

export function defaultConfig() { return structuredClone(DEFAULTS); }

// --- колекції (ніші, пайплайн, історія) ---
export async function loadCollection(name, fallback) {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, name + ".json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function saveCollection(name, value) {
  await ensureDataDir();
  await fs.writeFile(path.join(DATA_DIR, name + ".json"), JSON.stringify(value, null, 2));
  return value;
}
