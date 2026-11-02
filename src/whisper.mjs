// Local Whisper (whisper.cpp) for Director Review. Far more accurate than the browser's recognizer,
// and the audio never leaves this PC. Ballast starts whisper-server on demand (the model loads in
// a few seconds) and stops it after a quiet spell so it isn't holding GPU memory while you play.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { HOME } from './store.mjs';

const DIR = path.join(HOME, 'whisper');
const PORT = Number(process.env.BALLAST_WHISPER_PORT || 4478);
const BASE = `http://127.0.0.1:${PORT}`;
const IDLE_MS = 15 * 60e3;

let proc = null;
let ready = null;
let idleTimer = null;
let lastError = '';

function find(dir, test, depth = 3) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) if (e.isFile() && test(e.name)) return path.join(dir, e.name);
  if (depth > 0) for (const e of entries) if (e.isDirectory()) { const hit = find(path.join(dir, e.name), test, depth - 1); if (hit) return hit; }
  return null;
}

function locate() {
  const exe = find(path.join(DIR, 'bin'), (n) => /^whisper-server(\.exe)?$/i.test(n));
  const model = find(path.join(DIR, 'models'), (n) => /^ggml-.+\.bin$/i.test(n), 0);
  return { exe, model };
}

export function info() {
  const { exe, model } = locate();
  return { installed: !!(exe && model), running: !!proc, model: model ? path.basename(model) : null, error: lastError };
}

function start() {
  if (ready) return ready;
  const { exe, model } = locate();
  if (!exe || !model) return Promise.reject(Object.assign(new Error(`Whisper isn't installed (expected it under ${DIR}).`), { status: 400 }));
  lastError = '';
  const log = fs.createWriteStream(path.join(DIR, 'server.log'));
  const threads = String(Math.max(4, Math.min(8, os.cpus().length >> 1)));
  // -sns drops non-speech tokens ("[music]", "(laughs)"); the CUDA build uses the GPU by default.
  proc = spawn(exe, ['-m', model, '--host', '127.0.0.1', '--port', String(PORT), '-t', threads, '-sns'], { cwd: path.dirname(exe), windowsHide: true });
  let tail = '';
  const keep = (d) => { log.write(d); tail = (tail + d).slice(-2000); };
  proc.stdout.on('data', keep);
  proc.stderr.on('data', keep);
  const child = proc;
  proc.on('exit', (code) => {
    if (proc === child) { proc = null; ready = null; }
    if (code) lastError = `whisper-server exited (${code}): ${tail.trim().split('\n').slice(-3).join(' ')}`;
    log.end();
  });
  proc.on('error', (err) => { lastError = err.message; });
  ready = (async () => {
    const until = Date.now() + 90e3;
    while (Date.now() < until) {
      if (!proc || proc !== child) throw new Error(lastError || 'whisper-server stopped while loading.');
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.status !== 503) return; // 503 means it's still loading the model
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    stop();
    throw new Error('Whisper took too long to load its model.');
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

export function stop() {
  clearTimeout(idleTimer);
  if (proc) { try { proc.kill(); } catch { /* gone */ } }
  proc = null;
  ready = null;
}
process.on('exit', stop);

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, IDLE_MS);
}

// Loads the model ahead of the first phrase, so the first line doesn't wait on it.
export function warm() {
  touch();
  start().catch(() => {});
  return info();
}

// Whisper invents these on breaths, game audio and silence.
const NOISE = /^(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|you|thank you\.?|thanks for watching!?|bye\.?|\.+|…)$/i;

// A whole recording (a playtest video's commentary): timestamped segments, in seconds.
export async function transcribeFile(file, { lang = 'en', prompt = '' } = {}) {
  touch();
  await start();
  const form = new FormData();
  form.append('file', await fs.openAsBlob(file, { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0.0');
  form.append('language', lang);
  if (prompt) form.append('prompt', prompt.slice(-900));
  const res = await fetch(`${BASE}/inference`, { method: 'POST', body: form });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.error) throw new Error(`Whisper: ${out.error || res.statusText}`);
  touch();
  // whisper.cpp reports start/end in seconds (OpenAI style) or t0/t1 in centiseconds.
  return (out.segments || []).map((s) => ({
    start: s.start ?? (s.t0 ?? 0) / 100,
    end: s.end ?? (s.t1 ?? 0) / 100,
    text: String(s.text || '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim(),
  })).filter((s) => s.text && !NOISE.test(s.text));
}

export async function transcribe({ audio, lang = 'en', prompt = '' }) {
  if (!audio) throw Object.assign(new Error('No audio.'), { status: 400 });
  touch();
  await start();
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(audio, 'base64')], { type: 'audio/wav' }), 'phrase.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0.0');
  form.append('temperature_inc', '0.2');
  form.append('language', /^[a-z]{2}$/.test(lang) ? lang : 'en');
  if (prompt) form.append('prompt', prompt.slice(-900));
  const res = await fetch(`${BASE}/inference`, { method: 'POST', body: form });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.error) throw new Error(`Whisper: ${out.error || res.statusText}`);
  const text = String(out.text || '').replace(/\[[^\]]*\]|\((?:music|laughs?|applause|silence|inaudible)[^)]*\)/gi, ' ').replace(/\s+/g, ' ').trim();
  return { text: NOISE.test(text) ? '' : text };
}
