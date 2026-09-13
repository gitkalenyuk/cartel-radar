// desktop/electron/main.js — нативне вікно для Windows, macOS і Linux.
// Сервер запускається як дочірній процес; ключі лишаються в теці даних користувача.
import { app, BrowserWindow, Menu, shell, dialog } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..", "..");
const PORT_CANDIDATES = [8787, 8788, 8789, 8790, 8791, 8792];

let server = null;
let win = null;
let port = PORT_CANDIDATES[0];
let quitting = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthy(p) {
  try {
    const res = await fetch("http://127.0.0.1:" + p + "/api/health", { signal: AbortSignal.timeout(1200) });
    const j = await res.json();
    return j && j.ok === true;
  } catch { return false; }
}

function startServer(p) {
  const dataDir = path.join(app.getPath("userData"), "data");
  const child = spawn(process.execPath, [path.join(APP_ROOT, "server.mjs"), "--port", String(p)], {
    cwd: APP_ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CARTEL_RADAR_DATA: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write("[сервер] " + d));
  child.stderr.on("data", (d) => process.stderr.write("[сервер] " + d));
  child.on("exit", (code) => { if (!quitting) console.error("Сервер завершився з кодом " + code); });
  return child;
}

async function bootServer() {
  for (const candidate of PORT_CANDIDATES) {
    if (await healthy(candidate)) { port = candidate; return true; }   // уже працює
    server = startServer(candidate);
    for (let i = 0; i < 60; i++) {
      await sleep(400);
      if (await healthy(candidate)) { port = candidate; return true; }
      if (server.exitCode !== null) break;   // порт зайнятий — пробуємо наступний
    }
    if (server && server.exitCode === null) { try { server.kill(); } catch {} }
    server = null;
  }
  return false;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 940, minWidth: 960, minHeight: 640,
    title: "Cartel Radar",
    backgroundColor: "#0b1020",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  win.loadURL("http://127.0.0.1:" + port + "/");
  // зовнішні посилання (Telegram, GitHub) — у системному браузері, а не всередині вікна
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on("closed", () => { win = null; });
}

function stopServer() {
  if (!server) return;
  quitting = true;
  try { server.kill("SIGTERM"); } catch {}
  server = null;
}

app.whenReady().then(async () => {
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);
  const ok = await bootServer();
  if (!ok) {
    dialog.showErrorBox("Cartel Radar", "Не вдалося запустити локальний сервер.\n\nПеревірте, що встановлено Node.js 18+, і спробуйте ще раз.");
    app.quit();
    return;
  }
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { stopServer(); if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", stopServer);
process.on("SIGINT", () => { stopServer(); app.quit(); });
process.on("SIGTERM", () => { stopServer(); app.quit(); });
