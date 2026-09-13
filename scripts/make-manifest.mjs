// scripts/make-manifest.mjs — перелік файлів застосунку з хешами.
//
// Цей перелік — основа модульних оновлень: застосунок порівнює хеші з тим,
// що лежить у користувача, і розуміє, які модулі застаріли. Файл мусить
// оновлюватися разом із кодом, тому збірка перевіряє його актуальність і
// падає, якщо він застарів.
//
// Запуск: node scripts/make-manifest.mjs [--check]

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "manifest.json");

// Що потрапляє в перелік. desktop/ свідомо немає: обгортку вікна не можна
// оновити на льоту — вона вкомпільована у зібраний застосунок.
const INCLUDE = ["server.mjs", "public", "lib", "docs"];
const SKIP = [/\.test\.mjs$/, /(^|\/)\./, /(^|\/)node_modules(\/|$)/];

async function walk(rel) {
  const abs = path.join(ROOT, rel);
  let st;
  try { st = await fs.stat(abs); } catch { return []; }
  if (st.isFile()) return SKIP.some((re) => re.test(rel)) ? [] : [rel];
  const out = [];
  for (const entry of await fs.readdir(abs)) {
    const child = path.posix.join(rel, entry);
    if (SKIP.some((re) => re.test(child))) continue;
    out.push(...(await walk(child)));
  }
  return out;
}

const files = {};
for (const inc of INCLUDE) {
  for (const f of await walk(inc)) {
    const buf = await fs.readFile(path.join(ROOT, f));
    files[f] = { hash: createHash("sha256").update(buf).digest("hex"), size: buf.length };
  }
}
const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));

const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
const manifest = {
  name: "cartel-radar",
  version: pkg.version,
  generatedAt: new Date().toISOString(),
  files: sorted,
};

const text = JSON.stringify(manifest, null, 2) + "\n";
const count = Object.keys(sorted).length;
const totalBytes = Object.values(sorted).reduce((n, f) => n + f.size, 0);

if (process.argv.includes("--check")) {
  let current = null;
  try { current = await fs.readFile(OUT, "utf8"); } catch { /* немає файлу */ }
  // Порівнюємо лише вміст і версію: час генерації щоразу інший і не є ознакою
  // застарілості — інакше перевірка лаялася б навіть на щойно створеному файлі.
  const sameContent = () => {
    if (!current) return false;
    try {
      const prev = JSON.parse(current);
      return prev.version === manifest.version && JSON.stringify(prev.files) === JSON.stringify(sorted);
    } catch { return false; }
  };
  if (sameContent()) {
    console.log(`Перелік актуальний: ${count} файлів, ${(totalBytes / 1024).toFixed(0)} КБ`);
    process.exit(0);
  }
  console.error("::error::manifest.json застарів — запустіть «node scripts/make-manifest.mjs» і закомітьте зміни");
  const prev = current ? Object.keys(JSON.parse(current).files) : [];
  const now = Object.keys(sorted);
  for (const f of now) if (!prev.includes(f)) console.error("  новий файл: " + f);
  for (const f of prev) if (!now.includes(f)) console.error("  зник файл: " + f);
  process.exit(1);
}

await fs.writeFile(OUT, text);
console.log(`Записано manifest.json: ${count} файлів, ${(totalBytes / 1024).toFixed(0)} КБ`);
