// Production gates: a game's GDD broken into sections (the Roadmap's features, each with what L0-L3
// means for it), each held at a level of quality (LOQ) gate that only the director moves.
// - A section's gate is the highest LOQ the team may work toward on it. Tickets above it wait, the
//   roadmap doesn't stock the next level, and a section that reaches its gate waits for the director.
//   "Hold" stops work on a section entirely.
// - A production gate set is a named set of section targets ("Vertical slice: core loop L2, shelter L1,
//   world held"). Applying one moves every gate it lists at once; nothing moves on by itself.
// - Focus: each department (gameplay, art, ...) can focus on chosen sections, only those or those first,
//   so a section can be honed for a while without the rest of the game pulling at the team.
import { db, save, uid } from './store.mjs';
import { changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import * as roadmap from './roadmap.mjs';
import * as review from './review.mjs';
import * as pace from './pace.mjs';
import { recordUsage } from './usage.mjs';

const must = (v, msg, status = 400) => { if (!v) throw Object.assign(new Error(msg), { status }); return v; };
const LOQ = (n) => (n < 0 ? 'Hold' : `L${n} ${roadmap.LEVELS[n].name}`);
const DEPTS = review.DISCIPLINES.map((d) => d.id);
const disc = (t) => t.discipline || review.disciplineOf(t.title);

export const on = (game) => !!game?.roadmap?.features?.length && game.roadmap.gates?.on !== false;
const sectionOf = (game, id) => game?.roadmap?.features?.find((f) => f.id === id) || null;

// First time: each section's gate starts where the team was already headed (the active milestone's
// target), so switching gates on doesn't stop work in flight.
export function ensure(game) {
  const rm = game?.roadmap;
  if (!rm?.features?.length) return;
  rm.gates ||= { on: true, sets: [], activeSet: null };
  rm.focus ||= {};
  const m = roadmap.active(game);
  for (const f of rm.features) if (f.gate === undefined) f.gate = m ? roadmap.targetOf(m, f) : Math.max(0, Math.min(3, roadmap.levelOf(game, f)));
}

// The most a section may be built up to right now: its gate (gates on) or the milestone target.
export function capOf(game, f) {
  if (on(game)) return f.gate ?? -1;
  const m = roadmap.active(game);
  return m ? roadmap.targetOf(m, f) : -1;
}

// ---------------------------------------------------------------------------
// What agents may take

function focusFor(game, t) {
  const fx = game?.roadmap?.focus?.[disc(t)];
  return fx && fx.mode && fx.mode !== 'off' && fx.sections?.length ? fx : null;
}

// Why a ticket is waiting, or null when it can be worked.
export function heldBy(game, t) {
  if (t.repoWide || t.gymId || t.subjectId || !on(game)) return null; // repo work, gyms and art rounds the director asked for go ahead
  const f = t.featureId && sectionOf(game, t.featureId);
  if (f) {
    const g = f.gate ?? -1;
    if (g < 0) return { kind: 'hold', text: `${f.name} is on hold` };
    if (t.level != null && t.level > g) return { kind: 'gate', text: `${f.name} is gated at L${g}; this is L${t.level} work` };
  }
  const fx = focusFor(game, t);
  if (fx?.mode === 'only' && !fx.sections.includes(t.featureId)) return { kind: 'focus', text: `${review.DISCIPLINES.find((d) => d.id === disc(t))?.label || 'This department'} is focused on other sections` };
  return null;
}
export const claimOk = (game, t) => !heldBy(game, t);
export const focusRank = (game, t) => { const fx = focusFor(game, t); return fx && fx.sections.includes(t.featureId) ? 1 : 0; };

export function agentNote(game) {
  if (!on(game)) return '';
  const rm = game.roadmap;
  const name = (id) => sectionOf(game, id)?.name;
  const focus = DEPTS.map((d) => [d, rm.focus?.[d]]).filter(([, fx]) => fx?.mode && fx.mode !== 'off' && fx.sections?.length)
    .map(([d, fx]) => `${review.DISCIPLINES.find((x) => x.id === d).label}: ${fx.sections.map(name).filter(Boolean).join(', ')}${fx.mode === 'only' ? ' (only these)' : ' (these first)'}`);
  return `[Production gates: the director develops this game section by section, each held at a quality gate (L0 Greybox, L1 Functional, L2 Polished, L3 Ship) that only the director passes. Build each section up to its gate and no further: no next-level polish or content on a section beyond its gate. When a section meets its gate, iterate within it or say so in your report; don't start its next level.${focus.length ? ` Focus right now: ${focus.join('; ')}.` : ''}]\n\n`;
}

export function triageNote(game, note) {
  if (!on(game)) return '';
  const secs = game.roadmap.features.slice(0, 40).map((f) => `- ${f.id}: ${f.name} [${f.area}${f.core ? ', core' : ''}] gate ${LOQ(f.gate ?? -1)}, now L${roadmap.levelOf(game, f)}`).join('\n');
  const about = note?.sectionId && sectionOf(game, note.sectionId);
  return `\nThe GDD is developed in sections, each held at a quality gate only the director passes:\n${secs}\nGive every task the section it develops (its id) and the level (0-3) it works toward: a fix or iteration within a section is at or below its gate; work for a section's next level is above its gate and will wait for the director. Leave section empty for work no section owns (builds, tools, crashes).${about ? `\nThis note is about the section "${about.name}" (${about.id}): its tasks belong to that section unless one plainly doesn't.` : ''}\n`;
}

// A triaged task's section and level, if it named a real one.
export function link(game, task, note) {
  if (!on(game)) return {};
  const f = sectionOf(game, task.section) || (note?.sectionId && !task.section && sectionOf(game, note.sectionId)) || null;
  if (!f) return {};
  const level = Number.isInteger(task.level) ? Math.max(0, Math.min(3, task.level)) : Math.max(0, f.gate ?? 0);
  return { featureId: f.id, level };
}

// ---------------------------------------------------------------------------
// The director's controls

function post(game, text) { orch.feedPost(game.id, { kind: 'system', from: 'Production gates', text }); }

export function setGate(game, f, gate, { quiet = false } = {}) {
  const was = f.gate ?? -1;
  f.gate = Math.max(-1, Math.min(3, Number(gate)));
  if (f.gate !== was && !quiet) post(game, f.gate > was ? `${f.name}: gate passed, ${LOQ(was)} → ${LOQ(f.gate)}. Work toward ${LOQ(f.gate)} starts now.` : `${f.name}: gate set back to ${LOQ(f.gate)}.${f.gate < 0 ? ' No work on it until you open it again.' : ''}`);
  return f.gate !== was;
}

export function update(gameId, body = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const rm = must(game.roadmap?.features?.length && game.roadmap, 'Break the GDD into sections first.');
  ensure(game);
  if (body.on !== undefined) { rm.gates.on = !!body.on; post(game, rm.gates.on ? 'Production gates on: each section is built up to its gate, and only you pass a gate.' : 'Production gates off: the roadmap\'s milestones drive the work again.'); }
  if (body.gate) setGate(game, must(sectionOf(game, body.gate.featureId), 'Unknown section'), body.gate.gate);
  if (Array.isArray(body.gates)) {
    const moved = [];
    for (const x of body.gates) { const f = sectionOf(game, x.featureId); if (f && setGate(game, f, x.gate, { quiet: true })) moved.push(`${f.name} → ${LOQ(f.gate)}`); }
    if (moved.length) post(game, `${body.why ? `${body.why} ` : ''}Gates set: ${moved.join(', ')}.`);
  }
  if (body.focus) {
    const d = must(DEPTS.includes(body.focus.dept) && body.focus.dept, 'Unknown department');
    const sections = (body.focus.sections || []).filter((id) => sectionOf(game, id));
    rm.focus[d] = { mode: ['only', 'first', 'off'].includes(body.focus.mode) ? body.focus.mode : 'first', sections };
  }
  if (body.saveSet) {
    const s = body.saveSet;
    const targets = {};
    for (const [id, v] of Object.entries(s.targets || {})) if (sectionOf(game, id) && v !== '' && v != null) targets[id] = Math.max(-1, Math.min(3, Number(v)));
    const name = must(String(s.name || '').trim(), 'Name the gate set.').slice(0, 60);
    const existing = s.id && rm.gates.sets.find((x) => x.id === s.id);
    if (existing) Object.assign(existing, { name, targets, note: String(s.note || '').slice(0, 400) });
    else rm.gates.sets.push({ id: uid('gs'), name, targets, note: String(s.note || '').slice(0, 400), createdAt: Date.now() });
  }
  if (body.deleteSet) { rm.gates.sets = rm.gates.sets.filter((x) => x.id !== body.deleteSet); if (rm.gates.activeSet === body.deleteSet) rm.gates.activeSet = null; }
  if (body.moveSet) {
    const i = rm.gates.sets.findIndex((x) => x.id === body.moveSet.id);
    const j = i + (body.moveSet.dir === 'up' ? -1 : 1);
    if (i >= 0 && j >= 0 && j < rm.gates.sets.length) [rm.gates.sets[i], rm.gates.sets[j]] = [rm.gates.sets[j], rm.gates.sets[i]];
  }
  if (body.applySet) {
    const s = must(rm.gates.sets.find((x) => x.id === body.applySet), 'Unknown gate set');
    const moved = [];
    for (const [id, g] of Object.entries(s.targets)) { const f = sectionOf(game, id); if (f && setGate(game, f, g, { quiet: true })) moved.push(`${f.name} → ${LOQ(g)}`); }
    Object.assign(rm.gates, { activeSet: s.id, on: true });
    s.appliedAt = Date.now();
    post(game, `Gate set "${s.name}" applied${moved.length ? `: ${moved.join(', ')}` : ' (every section was already there)'}.`);
  }
  save();
  roadmap.tick(game); // stock the board for gates that opened
  changed();
  setTimeout(() => orch.wakeIdle(game.id), 300);
  return roadmap.publicRoadmap(game);
}

// ---------------------------------------------------------------------------
// Sorting tickets that have no section yet

const SORT_SCHEMA = {
  type: 'object', required: ['tickets'],
  properties: { tickets: { type: 'array', items: { type: 'object', required: ['num', 'section', 'level'], properties: { num: { type: 'integer' }, section: { type: 'string', description: 'The section id, or empty when no section owns it.' }, level: { type: 'integer', minimum: 0, maximum: 3, description: 'The quality level the ticket works toward.' } } } } },
};
const sorting = new Set();

export function unlinked(game) {
  return db.tasks.filter((t) => t.gameId === game.id && !t.featureId && !t.repoWide && !t.noSection && t.status !== 'done');
}

export function sort(gameId) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  must(game.roadmap?.features?.length, 'Break the GDD into sections first.');
  must(!sorting.has(game.id), 'Already sorting.', 409);
  const list = unlinked(game).slice(0, 150);
  must(list.length, 'Every open ticket already has a section.');
  sorting.add(game.id);
  game.roadmap.gates.sorting = Date.now();
  changed();
  (async () => {
    const acct = must(db.accounts.filter((a) => a.loggedIn && !(a.limitedUntil > Date.now()) && orch.utilization(a) * 100 < (db.settings.limitGuardPct || 95)).sort(pace.compareAccounts)[0], 'No account free.');
    const { result } = await claude.runQuick({
      account: acct,
      args: ['--model', db.settings.triageModel || 'sonnet', '--tools', 'Read', '--json-schema', JSON.stringify(SORT_SCHEMA)],
      prompt: `Sort these board tickets of "${game.name}" into the sections of its GDD. For each ticket give the section it develops (its id) and the quality level (0-3) it works toward: L0 Greybox, L1 Functional, L2 Polished, L3 Ship. Leave section empty for work no section owns (builds, CI, tools, crashes, repo upkeep).

Sections:
${game.roadmap.features.map((f) => `- ${f.id}: ${f.name} [${f.area}] ${f.summary} | L0: ${f.levels[0]?.done || ''} | L1: ${f.levels[1]?.done || ''} | L2: ${f.levels[2]?.done || ''} | L3: ${f.levels[3]?.done || ''}`).join('\n').slice(0, 30000)}

Tickets:
${list.map((t) => `#${t.num} ${t.title}: ${(t.detail || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}`,
    });
    if (result) recordUsage({ account: acct, gameId: game.id, kind: 'gate-sort', result });
    const out = must(result?.structured_output?.tickets, 'The sort returned nothing.');
    let linked = 0;
    for (const r of out) {
      const t = list.find((x) => x.num === r.num);
      if (!t) continue;
      const f = sectionOf(game, r.section);
      if (f) { Object.assign(t, { featureId: f.id, level: Math.max(0, Math.min(3, r.level)) }); linked++; } else t.noSection = true;
    }
    post(game, `Sorted ${list.length} ticket${list.length > 1 ? 's' : ''} into sections: ${linked} belong to a section, ${list.length - linked} to none (groundwork).`);
  })().catch((err) => post(game, `Couldn't sort tickets into sections: ${err.message}`)).finally(() => {
    sorting.delete(game.id);
    delete game.roadmap.gates.sorting;
    save(); changed();
    orch.wakeIdle(game.id);
  });
  return { started: true, tickets: list.length };
}

export function publicGates(game) {
  const rm = game.roadmap;
  if (!rm?.features?.length) return null;
  const tasks = db.tasks.filter((t) => t.gameId === game.id && t.status !== 'done');
  return {
    on: on(game), activeSet: rm.gates?.activeSet || null, sorting: !!rm.gates?.sorting,
    sets: (rm.gates?.sets || []).map((s) => {
      const listed = Object.entries(s.targets).map(([id, g]) => ({ f: sectionOf(game, id), g })).filter((x) => x.f);
      return { ...s, met: listed.filter(({ f, g }) => roadmap.levelOf(game, f) >= g).length, of: listed.length };
    }),
    focus: rm.focus || {},
    unlinked: unlinked(game).length,
    held: tasks.filter((t) => heldBy(game, t)).length,
  };
}
