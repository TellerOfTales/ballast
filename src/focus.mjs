// Focuses: what the director wants worked on right now, in their own words ("the first 15 minutes
// have to read: first room dug, first client signed, first breach survived"). Each focus is matched
// to the board's tickets by Claude, and the matched tickets go first (or are the only ones taken,
// besides urgent work). Triage tags new tickets with the focuses they serve, agents are told the
// focus with every hand-off, and "Plan tickets" adds what the board is missing for it. Section gates
// still apply: a focus never pulls work past a gate.
import path from 'node:path';
import { db, save, uid } from './store.mjs';
import { changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import * as pace from './pace.mjs';
import * as gates from './gates.mjs';
import * as gdd from './gddreview.mjs';
import * as jungledocs from './jungledocs.mjs';
import { recordUsage } from './usage.mjs';

const must = (v, msg, status = 400) => { if (!v) throw Object.assign(new Error(msg), { status }); return v; };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
const MODES = ['first', 'only'];
const busy = new Set();

const list = (game) => (game.focuses ||= []);
export function active(game) {
  const now = Date.now();
  return (game?.focuses || []).filter((f) => f.on && !(f.until && now > f.until));
}
const live = (t) => t.status !== 'done' && !t.cancelled;

function account() {
  return db.accounts.filter((a) => a.loggedIn && !(a.limitedUntil > Date.now()) && !a.authBroken && orch.utilization(a) * 100 < (db.settings.limitGuardPct || 95)).sort(pace.compareAccounts)[0] || null;
}
function post(game, text) { orch.feedPost(game.id, { kind: 'system', from: 'Focus', text }); }

// ---------------------------------------------------------------------------
// Claiming

const matches = (game, t) => (t.focusIds || []).some((id) => active(game).some((f) => f.id === id));
export const rank = (game, t) => (matches(game, t) ? 1 : 0);

// With an "only" focus on, a ticket is taken only if it serves an active focus, is urgent, or is repo work.
export function heldBy(game, t) {
  const only = active(game).filter((f) => f.mode === 'only');
  if (!only.length || t.repoWide || t.gymId || t.subjectId || (t.priority ?? 1) >= 3 || matches(game, t)) return null;
  return { kind: 'focus', text: `outside the focus "${only.map((f) => f.title).join('", "')}"` };
}
export const claimOk = (game, t) => !heldBy(game, t);

// ---------------------------------------------------------------------------
// What agents and triage are told

export function agentNote(game) {
  const fs = active(game);
  if (!fs.length) return '';
  return `[The director's focus right now: ${fs.map((f) => `"${f.title}"${f.text ? `: ${clip(f.text, 600)}` : ''}${f.mode === 'only' ? ' (only work on this, apart from urgent tickets)' : ''}`).join(' | ')}. Do your ticket with that in mind: favour the parts of it that serve the focus, and say in your report how it moves the focus forward. If you notice something the focus needs that no ticket covers, add it to the board.]\n\n`;
}

export function triageNote(game) {
  const fs = active(game);
  if (!fs.length) return '';
  return `\nThe director's focus right now (give each task the ids of the focuses it serves, in "focus"; none is fine):\n${fs.map((f) => `- ${f.id}: ${f.title}${f.text ? `: ${clip(f.text, 500)}` : ''}`).join('\n')}\n`;
}

// A new ticket's focus tags, from triage or a planning run.
export function tag(game, task, ids) {
  const ok = (ids || []).filter((id) => list(game).some((f) => f.id === id));
  if (ok.length) { task.focusIds = [...new Set([...(task.focusIds || []), ...ok])]; save(); }
  return task;
}

// ---------------------------------------------------------------------------
// Matching tickets to focuses (Claude reads the board; no code)

const MATCH_SCHEMA = {
  type: 'object', required: ['matches'],
  properties: { matches: { type: 'array', items: { type: 'object', required: ['focus', 'nums'], properties: { focus: { type: 'string' }, nums: { type: 'array', items: { type: 'integer' } } } } } },
};

async function match(game, { onlyNew = false } = {}) {
  const fs = list(game).filter((f) => f.on);
  if (!fs.length) return 0;
  const since = onlyNew ? Math.min(...fs.map((f) => f.matchedAt || 0)) : 0;
  const tickets = db.tasks.filter((t) => t.gameId === game.id && live(t) && (!onlyNew || (t.createdAt || 0) > since)).slice(-220);
  if (!tickets.length) { for (const f of fs) f.matchedAt = Date.now(); return 0; }
  const acct = must(account(), 'No account free.');
  const { result } = await claude.runQuick({
    account: acct,
    args: ['--model', db.settings.triageModel || 'sonnet', '--tools', 'Read', '--json-schema', JSON.stringify(MATCH_SCHEMA)],
    prompt: `The director of "${game.name}" wrote what they want worked on right now. For each focus, list the tickets below that directly serve it: doing the ticket moves that focus forward. Leave out tickets that are only loosely related; general groundwork counts only if the focus needs it.

Focuses:
${fs.map((f) => `- ${f.id}: ${f.title}${f.text ? `\n  ${f.text.slice(0, 2000)}` : ''}`).join('\n')}

Tickets:
${tickets.map((t) => `#${t.num} [${t.status}] ${t.title}: ${clip(t.detail, 220)}`).join('\n')}`,
  });
  if (result) recordUsage({ account: acct, gameId: game.id, kind: 'focus-match', result });
  const out = must(result?.structured_output?.matches, 'Matching returned nothing.');
  const ids = new Set(fs.map((f) => f.id));
  for (const t of tickets) if (!onlyNew) t.focusIds = (t.focusIds || []).filter((id) => !ids.has(id));
  let n = 0;
  for (const m of out) {
    if (!ids.has(m.focus)) continue;
    for (const num of m.nums) { const t = tickets.find((x) => x.num === num); if (t) { t.focusIds = [...new Set([...(t.focusIds || []), m.focus])]; n++; } }
  }
  for (const f of fs) f.matchedAt = Date.now();
  save();
  return n;
}

// ---------------------------------------------------------------------------
// Planning: what the board is missing for a focus (reads the GDD and the code)

const PLAN_SCHEMA = {
  type: 'object', required: ['summary', 'tasks'],
  properties: {
    summary: { type: 'string', description: 'Two sentences: where the focus stands in the game today and what is missing.' },
    tasks: { type: 'array', maxItems: 8, items: { type: 'object', required: ['title', 'detail'], properties: { title: { type: 'string', description: 'Starts with a department tag like [gameplay] or [art].' }, detail: { type: 'string', description: 'What to do and how to check it by playing.' }, section: { type: 'string' }, level: { type: 'integer', minimum: 0, maximum: 3 } } } },
  },
};

async function plan(game, f) {
  const acct = must(account(), 'No account free.');
  const { files } = await gdd.pullLatest(game).catch(() => ({ files: [] }));
  const board = db.tasks.filter((t) => t.gameId === game.id && (live(t) || (t.doneAt || 0) > Date.now() - 14 * 864e5)).slice(-200).map((t) => `#${t.num} [${t.status}] ${t.title}`).join('\n');
  const secs = gates.on(game) ? `\nThe GDD's sections and their quality gates (tasks above a gate wait for the director, so stay at or under it unless the focus plainly needs the next level):\n${game.roadmap.features.map((x) => `- ${x.id}: ${x.name} gate L${x.gate ?? -1}`).join('\n')}\nGive each task its section id and the level it works toward.\n` : '';
  const { result } = await claude.runQuick({
    account: acct,
    cwd: game.repoPath,
    args: ['--model', db.settings.reportModel || 'sonnet', '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', '--add-dir', gdd.gddDirOf(game), ...jungledocs.forRun(game).args, '--json-schema', JSON.stringify(PLAN_SCHEMA)],
    prompt: `${game.subdir ? `This game's own folder is ${game.subdir}/.\n\n` : ''}The director of "${game.name}" wants this worked on right now:

"${f.title}"
${f.text}

Read the GDD (${files.map((x) => x).join(', ') || 'none found'}) and the code to see where this stands in the game a player runs today. Then list the board-sized tasks still missing to deliver it, most important first, at most 8. Don't repeat what a ticket below already covers, open or recently done.
${secs}
Board:
${board || '(empty)'}${jungledocs.forRun(game).text}`,
  });
  if (result) recordUsage({ account: acct, gameId: game.id, kind: 'focus-plan', result });
  const out = must(result?.structured_output, clip(result?.result, 300) || 'Planning returned nothing.');
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const titles = new Set(db.tasks.filter((t) => t.gameId === game.id && live(t)).map((t) => norm(t.title)));
  const added = [];
  for (const t of out.tasks || []) {
    if (!t.title?.trim() || titles.has(norm(t.title))) continue;
    titles.add(norm(t.title));
    const task = orch.addTask(game.id, { title: t.title.trim().slice(0, 200), detail: `${t.detail}\n\nFor the director's focus "${f.title}".`, createdBy: 'Focus', ...gates.link(game, t, null) });
    tag(game, task, [f.id]);
    added.push(task);
  }
  f.planned = { at: Date.now(), summary: out.summary, added: added.map((t) => t.num) };
  const held = added.filter((t) => gates.heldBy(game, t));
  post(game, `Planned "${f.title}": ${out.summary}${added.length ? `\nAdded ${added.map((t) => `#${t.num}`).join(', ')}.${held.length ? ` ${held.map((t) => `#${t.num}`).join(', ')} wait${held.length === 1 ? 's' : ''} above a section gate.` : ''}` : '\nThe board already covers it.'}`);
}

// ---------------------------------------------------------------------------
// The director's controls

function background(game, key, fn) {
  if (busy.has(`${game.id}:${key}`)) return;
  busy.add(`${game.id}:${key}`);
  changed();
  fn().catch((err) => post(game, `Focus: ${err.message}`)).finally(() => {
    busy.delete(`${game.id}:${key}`);
    save(); changed();
    orch.wakeIdle(game.id);
  });
}

export function update(gameId, body = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  let rematch = false;
  if (body.save) {
    const b = body.save;
    const title = must(String(b.title || '').trim(), 'Give the focus a short title.').slice(0, 120);
    const fields = { title, text: String(b.text || '').trim().slice(0, 4000), mode: MODES.includes(b.mode) ? b.mode : 'first', until: b.until ? new Date(`${b.until}T23:59:59`).getTime() || null : null };
    const f = b.id && list(game).find((x) => x.id === b.id);
    if (f) { Object.assign(f, fields); post(game, `Focus updated: "${title}"${fields.mode === 'only' ? ' (only this)' : ''}.`); }
    else { list(game).push({ id: uid('fx'), on: true, createdAt: Date.now(), ...fields }); post(game, `New focus: "${title}"${fields.mode === 'only' ? '. Only work that serves it is taken, apart from urgent tickets.' : '. Work that serves it goes first.'} Matching the board to it…`); }
    rematch = true;
  }
  if (body.toggle) { const f = must(list(game).find((x) => x.id === body.toggle), 'Unknown focus'); f.on = !f.on; post(game, `Focus "${f.title}" ${f.on ? 'on again' : 'paused'}.`); rematch = f.on; }
  if (body.remove) { const f = list(game).find((x) => x.id === body.remove); game.focuses = list(game).filter((x) => x.id !== body.remove); for (const t of db.tasks) if (t.focusIds) t.focusIds = t.focusIds.filter((id) => id !== body.remove); if (f) post(game, `Focus "${f.title}" removed.`); }
  if (body.match) rematch = true;
  if (body.plan) { const f = must(list(game).find((x) => x.id === body.plan), 'Unknown focus'); background(game, `plan:${f.id}`, () => plan(game, f)); }
  save();
  if (rematch) background(game, 'match', async () => { const n = await match(game); post(game, `Matched ${n} ticket${n === 1 ? '' : 's'} to ${active(game).length === 1 ? 'the focus' : 'the focuses'}.`); });
  changed();
  setTimeout(() => orch.wakeIdle(game.id), 300);
  return publicFocus(game);
}

export function publicFocus(game) {
  const tasks = db.tasks.filter((t) => t.gameId === game.id);
  return {
    matching: busy.has(`${game.id}:match`),
    focuses: list(game).map((f) => {
      const mine = tasks.filter((t) => (t.focusIds || []).includes(f.id));
      return {
        ...f, expired: !!(f.until && Date.now() > f.until), planning: busy.has(`${game.id}:plan:${f.id}`),
        counts: { open: mine.filter((t) => t.status === 'open').length, working: mine.filter((t) => t.status === 'claimed').length, blocked: mine.filter((t) => t.status === 'blocked').length, done: mine.filter((t) => t.status === 'done' && !t.cancelled).length, held: mine.filter((t) => live(t) && gates.heldBy(game, t)).length },
      };
    }),
  };
}

// New tickets from anywhere (roadmap, audits, the GDD check) get matched every 10 minutes.
export function init() {
  setInterval(() => {
    for (const game of db.games) {
      if ((game.status || 'active') !== 'active' || !active(game).length) continue;
      const since = Math.min(...active(game).map((f) => f.matchedAt || 0));
      if (!db.tasks.some((t) => t.gameId === game.id && live(t) && !t.focusIds && (t.createdAt || 0) > since)) continue;
      background(game, 'match', () => match(game, { onlyNew: true }));
    }
  }, 10 * 60e3).unref();
}
