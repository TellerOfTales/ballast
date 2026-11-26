// Performance tab: every profiler run you attach to a note (or add from the tab) becomes a run on
// the game's Performance tab, so test builds can be compared and trended. A run is any JSON file
// with a `budgets` list ({ name, value, limit, unit, pass }); `samples` (rows over time) and
// `frame` are used when present. Sample columns come from `sampleFields` when the profiler names
// them, else Look Normal's layout: t, fps, crowd sim ms, crowd draw ms, draw calls, townsfolk drawn,
// then CPU ms and GPU ms, then render scale (-1 = not measured).
import fs from 'node:fs';
import path from 'node:path';
import { db, save, attachmentsDir } from './store.mjs';
import { changed } from './bus.mjs';
import * as orch from './orchestrator.mjs';

const FIELDS = ['t', 'fps', 'simMs', 'renderMs', 'draws', 'drawn', 'cpuMs', 'gpuMs', 'scale'];
const cache = new Map(); // file path -> { key, run }
const must = (v, msg, status = 400) => { if (!v) throw Object.assign(new Error(msg), { status }); return v; };

function parse(file) {
  const st = fs.statSync(file);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(file);
  if (hit?.key === key) return hit.run;
  let run = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (Array.isArray(j?.budgets) && j.budgets.some((b) => b && typeof b.value === 'number')) {
      const fields = Array.isArray(j.sampleFields) ? j.sampleFields.map(String) : FIELDS;
      const rows = (Array.isArray(j.samples) ? j.samples : [])
        .map((s) => (Array.isArray(s) ? s : fields.map((f) => s?.[f])).map((v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)));
      const at = Date.parse(j.finishedAt || '') || st.mtimeMs;
      run = {
        id: String(j.sid || `${j.session || ''}-${j.seq ?? ''}` || path.basename(file)).replace(/[^\w.-]/g, '_') || path.basename(file),
        at,
        summary: j.summary || '',
        frameSummary: j.frameSummary || '',
        platform: j.platform || '',
        state: j.state || j.outcome || '',
        seconds: j.seconds ?? null,
        townsfolk: j.townsfolk ?? null,
        budgets: j.budgets.filter((b) => b && typeof b.value === 'number').map((b) => ({ name: String(b.name), value: b.value, limit: typeof b.limit === 'number' ? b.limit : null, unit: b.unit || '', pass: b.pass !== false })),
        frame: j.frame || null,
        samples: { fields: fields.slice(0, Math.max(0, ...rows.map((r) => r.length))), rows },
      };
    }
  } catch { /* not a profiler run */ }
  cache.set(file, { key, run });
  return run;
}

// Which note each attachment came with, so a run links back to its playtest.
function noteOf(gameId) {
  const map = new Map();
  for (const e of orch.readFeed(gameId, 20000)) {
    if (e.kind !== 'note' || !e.num) continue;
    for (const a of e.attachments || []) if (a.path && !map.has(path.basename(a.path))) map.set(path.basename(a.path), e.num);
  }
  return map;
}

export function runs(gameId) {
  must(orch.getGame(gameId), 'Unknown game');
  const dir = attachmentsDir(gameId);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)); } catch { /* no attachments yet */ }
  const notes = noteOf(gameId);
  const byId = new Map();
  for (const f of files) {
    const file = path.join(dir, f);
    const run = parse(file);
    if (!run) continue;
    const meta = db.perfRuns[`${gameId}:${run.id}`] || {};
    const entry = { ...run, file: f.replace(/^[a-z0-9]{8}-/, ''), url: `/files/attachments/${gameId}/${encodeURIComponent(f)}`, noteNum: notes.get(f) || null, label: meta.label || '', hidden: !!meta.hidden };
    // The same run attached twice counts once; keep the copy that came with a note.
    const prev = byId.get(run.id);
    if (!prev || (!prev.noteNum && entry.noteNum)) byId.set(run.id, entry);
  }
  const list = [...byId.values()].sort((a, b) => a.at - b.at);
  // What landed on the board between each run and the one before it.
  const done = db.tasks.filter((t) => t.gameId === gameId && t.status === 'done' && !t.cancelled && t.doneAt);
  list.forEach((r, i) => {
    const since = i ? list[i - 1].at : 0;
    r.landed = since ? done.filter((t) => t.doneAt > since && t.doneAt <= r.at).sort((a, b) => a.doneAt - b.doneAt).map((t) => ({ num: t.num, title: t.title })) : [];
  });
  return list;
}

export function update(gameId, runId, { label, hidden } = {}) {
  must(orch.getGame(gameId), 'Unknown game');
  const key = `${gameId}:${runId}`;
  const meta = { ...(db.perfRuns[key] || {}) };
  if (label !== undefined) meta.label = String(label).trim().slice(0, 80);
  if (hidden !== undefined) meta.hidden = !!hidden;
  db.perfRuns[key] = meta;
  save();
  changed();
  return meta;
}
