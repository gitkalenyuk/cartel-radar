// lib/jobs.mjs — реєстр фонових завдань, стрім подій, пул паралельності
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDir } from "./config.mjs";

const MAX_EVENTS = 20000;
const jobs = new Map();

export function createJob(type, params = {}) {
  const job = {
    id: randomUUID(),
    type, params,
    status: "running",
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: null,
    events: [],
    seq: 0,
    result: null,
    error: null,
    controller: new AbortController(),
    listeners: new Set(),
    stats: { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, steps: 0, total: 0, done: 0, failed: 0 },
    emit(ev) {
      const event = { i: this.seq++, ts: Date.now(), ...ev };
      this.events.push(event);
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
      for (const fn of this.listeners) { try { fn(event); } catch {} }
      return event;
    },
    log(msg, level = "info") { return this.emit({ t: "log", level, msg }); },
    progress(extra = {}) { return this.emit({ t: "progress", stats: { ...this.stats }, ...extra }); },
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id) { return jobs.get(id) || null; }
export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map((j) => ({
    id: j.id, type: j.type, status: j.status, createdAt: j.createdAt, finishedAt: j.finishedAt,
    seed: j.params?.seed || j.params?.query || j.params?.channel || j.params?.url || "",
    stats: j.stats, error: j.error, summary: j.result?.summary || null,
  }));
}

export function subscribe(job, fromIndex, onEvent) {
  const start = Math.max(0, Number(fromIndex) || 0);
  const buffered = job.events.filter((e) => e.i >= start);
  job.listeners.add(onEvent);
  return { buffered, unsubscribe: () => job.listeners.delete(onEvent) };
}

export async function finishJob(job, result) {
  job.status = "done";
  job.finishedAt = Date.now();
  job.result = result;
  job.emit({ t: "result", result });
  job.emit({ t: "end", status: "done", stats: job.stats, ms: job.finishedAt - job.startedAt });
  job.listeners.clear();
  await persistJob(job);
  return job;
}

export async function failJob(job, err) {
  const cancelled = /Скасовано|cancel/i.test(String(err?.message || err));
  job.status = cancelled ? "cancelled" : "error";
  job.finishedAt = Date.now();
  job.error = String(err?.message || err);
  job.emit({ t: "error", msg: job.error, cancelled });
  job.emit({ t: "end", status: job.status, stats: job.stats, ms: job.finishedAt - job.startedAt });
  job.listeners.clear();
  await persistJob(job);
  return job;
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.status !== "running") return false;
  job.controller.abort(new Error("Скасовано користувачем"));
  job.emit({ t: "log", level: "warn", msg: "Запит на скасування…" });
  return true;
}

async function persistJob(job) {
  try {
    await ensureDataDir();
    const file = path.join(DATA_DIR, "runs", job.id + ".json");
    const payload = {
      id: job.id, type: job.type, status: job.status, createdAt: job.createdAt, finishedAt: job.finishedAt,
      params: job.params, stats: job.stats, error: job.error,
      result: job.status === "done" ? job.result : null,
      log: job.events.filter((e) => e.t === "log").slice(-200),
    };
    await fs.writeFile(file, JSON.stringify(payload, null, 2));
  } catch (e) { /* історія не критична */ }
}

/** Обмежений пул: виконує worker над кожним елементом із лімітом паралельності. */
export async function pool(items, limit, worker, { signal, onProgress } = {}) {
  const arr = [...items];
  const results = new Array(arr.length);
  let next = 0, done = 0;
  const n = Math.max(1, Math.min(limit || 1, arr.length || 1));
  const runners = Array.from({ length: n }, async () => {
    while (true) {
      if (signal?.aborted) throw new Error("Скасовано");
      const i = next++;
      if (i >= arr.length) return;
      try { results[i] = await worker(arr[i], i); }
      catch (e) { results[i] = { __error: String(e?.message || e) }; }
      done++;
      onProgress?.(done, arr.length);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Повтор із backoff для функцій, що не є LLM-викликами. */
export async function withRetry(fn, { tries = 3, base = 500, onRetry = null } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i < tries - 1) { onRetry?.(e, i + 1); await new Promise((r) => setTimeout(r, base * Math.pow(2, i))); }
    }
  }
  throw lastErr;
}
