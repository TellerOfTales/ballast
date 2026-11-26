// The director's workbench: the places a director plays, notes and iterates on one thing at a time.
// - Gyms: a test scene for one system (a section), loaded straight into it, with its tuning numbers as
//   live controls, readouts and a quick reset. Ballast writes the ticket that builds it, learns from the
//   agent's report how to open it, and notes written while playing it go to that system's section.
// - Art subjects: a character, level, prop or effect developed in iteration rounds. Each round is a
//   ticket carrying the brief, the references and the director's notes on the last round; its captures
//   come back to the subject, and the director gives notes for the next round or approves it.
import { db, save, uid } from './store.mjs';
import { changed } from './bus.mjs';
import * as orch from './orchestrator.mjs';
import * as jungledocs from './jungledocs.mjs';

const must = (v, msg, status = 400) => { if (!v) throw Object.assign(new Error(msg), { status }); return v; };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'gym';
const sectionOf = (game, id) => game.roadmap?.features?.find((f) => f.id === id) || null;
const LEVELS = ['Greybox', 'Functional', 'Polished', 'Ship'];
export const SUBJECT_KINDS = ['character', 'creature', 'level', 'environment', 'prop', 'ui', 'vfx', 'other'];
function post(game, text) { orch.feedPost(game.id, { kind: 'system', from: 'Workbench', text }); }

// ---------------------------------------------------------------------------
// Gyms

export function requestGym(gameId, { sectionId, ask = '', gymId = null } = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const gyms = (game.gyms ||= []);
  const existing = gymId && gyms.find((g) => g.id === gymId);
  const f = must(sectionOf(game, existing?.sectionId || sectionId), 'Pick a section for the gym.');
  ask = String(ask || '').trim().slice(0, 3000);
  const gym = existing || { id: uid('gym'), sectionId: f.id, name: f.name, slug: slug(f.key || f.name), createdAt: Date.now(), asks: [] };
  if (!existing) gyms.push(gym);
  if (ask) gym.asks.push({ at: Date.now(), text: ask });
  const gate = f.gate ?? -1;
  const jungle = jungledocs.isJungle(game);
  const detail = existing
    ? `Change the gym for ${f.name} (opened with: ${gym.open || 'see its first report'}). The director asks:\n${ask || '(see the earlier asks below)'}\n\nKeep it loading straight into the system, with its live controls and readouts. End your report with one line: GYM: <how to open it now>.`
    : `Build a gym for "${f.name}": a small test scene that loads straight into this one system, so the director can play it in isolation and refine it.
- It opens directly: a URL query like ?gym=${gym.slug}, a dev-menu entry, or one command. No menus, no campaign, no waiting.
- It holds only what the system needs to be exercised, plus the director's asks below.
- The system's tuning numbers are live controls in an in-game panel (sliders, toggles, presets), with a reset to the game's real values.
- Readouts show what the system is doing (values, states, timers), so a change can be judged by playing.
- One action resets the gym. It never changes the real game's balance, saves or content.
- It lives in the game's own code (for example a gyms/ folder) and builds with the game, so later work keeps it running.${jungle ? '\n- This is a Jungle Engine game: build it the engine\'s way (its scene, room and Game Pack conventions; see the engine docs).' : ''}

The system, from the GDD: ${clip(f.summary, 600)}${f.gdd ? ` (GDD: ${f.gdd})` : ''}
Its gate is ${gate < 0 ? 'on hold' : `L${gate} ${LEVELS[gate]}`}; what that means here: ${clip(f.levels?.[Math.max(0, gate)]?.done, 500)}
${ask ? `\nThe director's asks for this gym:\n${ask}\n` : ''}
End your report with one line: GYM: <how to open it>, a URL or path the director can open, or the exact steps.`;
  const t = orch.addTask(game.id, { title: `[gameplay] Gym: ${f.name}${existing ? ' (changes)' : ''}`, detail, createdBy: orch.directorName(), featureId: f.id, level: Math.max(0, gate) });
  Object.assign(t, { gymId: gym.id, priority: Math.max(t.priority ?? 1, 2) });
  Object.assign(gym, { status: 'building', taskId: t.id, taskNum: t.num, error: null });
  save(); changed();
  post(game, `${existing ? 'Changes to the' : 'A'} gym for ${f.name} are on the board as #${t.num}.`);
  return gym;
}

export function gymNote(gameId, gymId, text) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const gym = must((game.gyms || []).find((g) => g.id === gymId), 'Unknown gym');
  text = must(String(text || '').trim(), 'Write the note first.');
  gym.notes = (gym.notes || 0) + 1;
  gym.lastNoteAt = Date.now();
  save();
  orch.postNote(game.id, { text: `[Playing the ${gym.name} gym] ${text}`, sectionId: gym.sectionId });
  return { ok: true };
}

export function removeGym(gameId, gymId) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  game.gyms = (game.gyms || []).filter((g) => g.id !== gymId);
  save(); changed();
  return { ok: true };
}

// A gym's ticket finished: its report says how to open it.
function settleGyms(game) {
  let moved = false;
  for (const gym of game.gyms || []) {
    if (gym.status !== 'building') continue;
    const t = db.tasks.find((x) => x.id === gym.taskId);
    if (!t) { gym.status = 'failed'; gym.error = 'Its ticket was deleted.'; moved = true; continue; }
    if (t.status === 'blocked') { if (gym.error !== t.blockReason) { gym.error = clip(t.blockReason, 300); moved = true; } continue; }
    if (t.status !== 'done') continue;
    if (t.cancelled) { gym.status = 'failed'; gym.error = 'Its ticket was cancelled.'; moved = true; continue; }
    const line = String(t.summary || '').match(/^\s*GYM:\s*(.+)$/im)?.[1]?.trim();
    Object.assign(gym, { status: 'ready', readyAt: t.doneAt || Date.now(), open: line || `See the report on #${t.num}`, url: line?.match(/https?:\/\/\S+/)?.[0] || null, pr: t.pr || null, error: null });
    post(game, `The ${gym.name} gym is ready${line ? `: ${line}` : ` (#${t.num})`}. Play it and write notes from the Sections tab; they go to ${gym.name}.`);
    moved = true;
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Art subjects

export function saveSubject(gameId, body = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const list = (game.subjects ||= []);
  const name = must(String(body.name || '').trim(), 'Name the subject.').slice(0, 80);
  const fields = {
    name, kind: SUBJECT_KINDS.includes(body.kind) ? body.kind : 'other',
    sectionId: sectionOf(game, body.sectionId) ? body.sectionId : null,
    brief: String(body.brief || '').trim().slice(0, 4000),
    refs: (body.refs || []).filter((id) => (db.targets || []).some((x) => x.id === id && x.gameId === game.id)).slice(0, 12),
    links: String(body.links || '').trim().slice(0, 2000),
  };
  const s = body.id && list.find((x) => x.id === body.id);
  if (s) Object.assign(s, fields);
  else list.push({ id: uid('subj'), status: 'active', rounds: [], createdAt: Date.now(), ...fields });
  save(); changed();
  return s || list.at(-1);
}

export function startRound(gameId, subjectId, { notes = '' } = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const s = must((game.subjects || []).find((x) => x.id === subjectId), 'Unknown subject');
  notes = String(notes || '').trim().slice(0, 4000);
  const last = s.rounds.at(-1);
  const lastTask = last && db.tasks.find((t) => t.id === last.taskId);
  must(!lastTask || ['done', 'blocked'].includes(lastTask.status), `Round ${last?.n} (#${lastTask?.num}) is still being made; give notes when it's done.`);
  if (last && notes) last.notes = notes;
  const n = (last?.n || 0) + 1;
  const f = s.sectionId && sectionOf(game, s.sectionId);
  const refs = (db.targets || []).filter((x) => s.refs.includes(x.id));
  const history = s.rounds.filter((r) => r.notes).slice(-4).map((r) => `- Round ${r.n}${r.num ? ` (#${r.num})` : ''}: ${r.notes}`).join('\n');
  const shot = { character: 'front, three-quarter and side, plus one in the game at play distance', creature: 'front, three-quarter and side, plus one in the game at play distance', level: 'the same 4-6 camera positions every round (an overview, the start, key spaces), plus a short fly-through if motion matters', environment: 'the same 4-6 camera positions every round', prop: 'front and three-quarter, plus one in place in the game', ui: 'each screen or state it appears in', vfx: 'a short clip of the effect in the game, plus stills of its key frames', other: 'the views that show it best' }[s.kind];
  const detail = `Art iteration, round ${n}, on ${s.kind === 'other' ? '' : `the ${s.kind} `}"${s.name}".${f ? ` Section: ${f.name} (gate ${f.gate < 0 ? 'hold' : `L${f.gate}`}).` : ''}

Brief: ${s.brief || '(none beyond the name)'}
${refs.length ? `\nReference targets (quality targets; read them with reference_targets, or from the ballast/targets branch in a cloud session): ${refs.map((x) => `"${x.title}"${x.notes ? ` (match: ${x.notes})` : ''}`).join('; ')}` : ''}${s.links ? `\nOther references: ${s.links}` : ''}
${n === 1 ? '\nThis is the first round: make a version that sets the direction, and say what you chose and why.' : `\nThe director's notes, newest last (the last line is for this round):\n${history || '(no notes on the last round)'}\n${lastTask?.summary ? `\nWhat round ${n - 1} changed: ${clip(lastTask.summary, 600)}` : ''}\nChange what the notes ask; keep what they didn't mention.`}

Capture it the same way every round so rounds compare side by side: ${shot}. Name captures ${slug(s.name)}-r${n}-<view> and attach them to this ticket. Report what you changed this round.`;
  const t = orch.addTask(game.id, { title: `[art] ${s.name}: iteration ${n}`, detail, createdBy: orch.directorName(), ...(f ? { featureId: f.id, level: Math.max(0, f.gate ?? 0) } : {}) });
  Object.assign(t, { subjectId: s.id, round: n, priority: Math.max(t.priority ?? 1, 2) });
  s.rounds.push({ n, taskId: t.id, num: t.num, at: Date.now() });
  s.status = 'active';
  save(); changed();
  post(game, `${s.name}: round ${n} is on the board as #${t.num}.`);
  return s;
}

export function updateSubject(gameId, subjectId, body = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const s = must((game.subjects || []).find((x) => x.id === subjectId), 'Unknown subject');
  if (body.remove) { game.subjects = game.subjects.filter((x) => x.id !== subjectId); save(); changed(); return { ok: true }; }
  if (body.notes !== undefined && s.rounds.at(-1)) s.rounds.at(-1).notes = String(body.notes).trim().slice(0, 4000);
  if (body.status && ['active', 'approved', 'paused'].includes(body.status)) {
    s.status = body.status;
    if (body.status === 'approved') { const r = s.rounds.at(-1); if (r) r.approved = true; post(game, `${s.name} approved at round ${r?.n || 0}.`); }
  }
  save(); changed();
  return s;
}

// ---------------------------------------------------------------------------

// Director-requested gym and art-round tickets go ahead whatever the gates or focuses say.
export const directorWork = (t) => !!(t.gymId || t.subjectId);

export function init() {
  setInterval(() => {
    let moved = false;
    for (const game of db.games) moved = settleGyms(game) || moved;
    if (moved) { save(); changed(); }
  }, 30e3).unref();
}
