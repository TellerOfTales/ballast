// Roadmap: the GDD broken into features, each with four quality levels, and milestones defined
// as "these features at this level". Ballast keeps the board stocked one level at a time
// (automated backlogging) and forecasts each milestone from the game's real pace.
//   L0 Greybox: placeholder, proves the idea      L1 Functional: works end to end, rough
//   L2 Polished: feels good, target-quality art   L3 Ship: performance, edge cases, final content
import fs from 'node:fs';
import path from 'node:path';
import { db, save, uid, paths, HOME } from './store.mjs';
import { changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import * as review from './review.mjs';
import { recordUsage } from './usage.mjs';
import * as gates from './gates.mjs';

export const LEVELS = [
  { n: 0, name: 'Greybox', text: 'Placeholder art and logic that proves the idea is fun.' },
  { n: 1, name: 'Functional', text: 'Works end to end with real rules; rough edges and placeholder content are fine.' },
  { n: 2, name: 'Polished', text: 'Feels good: tuned, juicy, target-quality art and audio.' },
  { n: 3, name: 'Ship', text: 'Performance, edge cases, accessibility and final content: ready for players.' },
];

const DEFAULT_MILESTONES = [
  { name: 'First playable', core: 1, other: 0 },
  { name: 'Vertical slice', core: 2, other: 1 },
  { name: 'Content complete', core: 2, other: 2 },
  { name: 'Launch', core: 3, other: 3 },
];

const DAY = 86400e3;

// How the director wants the GDD cut into sections. Each scheme is a way of seeing the game; the
// director's own instructions (guide) come on top and win where they differ.
export const SCHEMES = {
  systems: { label: 'Systems', text: 'Break it into the game\'s systems: each section is one system with its own rules, numbers and feedback (for example digging, power, air, clients, threats, economy, the board). Content such as levels, characters and items sits inside the system it exercises, unless it is big enough to be its own section. Name each section after its system.' },
  features: { label: 'Features', text: 'Break it into features: what a player can do or meets in the game, merging tiny ones.' },
  content: { label: 'Content', text: 'Break it into content: levels, areas, characters, creatures, items and story beats, each its own section, with the systems they rely on noted in the summary.' },
  journey: { label: 'Player journey', text: 'Break it into the player\'s journey: the first minutes, the first session, the early game, mid-game, late game and the ending, each a section holding what the player meets there.' },
};
const KINDS = ['system', 'feature', 'content', 'character', 'level', 'journey', 'other'];
const must = (v, msg) => { if (!v) throw Object.assign(new Error(msg), { status: 400 }); return v; };
const tasksOf = (gameId) => db.tasks.filter((t) => t.gameId === gameId);

// ---------------------------------------------------------------------------
// Breakdown (one Claude run that reads the GDD and the board)

const DISCIPLINES = review.DISCIPLINES.map((d) => d.id);
const taskShape = { type: 'object', required: ['title', 'detail'], properties: { title: { type: 'string' }, detail: { type: 'string' } } };
const SCHEMA = {
  type: 'object',
  required: ['features', 'existing'],
  properties: {
    features: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'name', 'area', 'core', 'summary', 'currentLevel', 'levels'],
        properties: {
          key: { type: 'string', description: 'Short stable id, kebab-case.' },
          kind: { enum: KINDS, description: 'What sort of section it is.' },
          name: { type: 'string' },
          area: { enum: DISCIPLINES },
          core: { type: 'boolean', description: 'Part of the core loop: needed for the game to be the game.' },
          summary: { type: 'string', description: 'What it is, from the GDD, in one or two sentences.' },
          gdd: { type: 'string', description: 'Where in the GDD it is described (section or file).' },
          currentLevel: { type: 'integer', minimum: -1, maximum: 3, description: 'Highest level already reached in the repo; -1 if not started.' },
          levels: {
            type: 'array', minItems: 4, maxItems: 4,
            items: { type: 'object', required: ['level', 'done', 'tasks'], properties: { level: { type: 'integer', minimum: 0, maximum: 3 }, done: { type: 'string', description: 'What "done at this level" means for this feature, checkable by playing.' }, tasks: { type: 'array', items: taskShape, description: '1-5 board-sized tasks that take the feature from the level below to this one. Empty for levels already reached.' } } },
          },
        },
      },
    },
    existing: { type: 'array', description: 'Board tasks that belong to a feature level.', items: { type: 'object', required: ['num', 'key', 'level'], properties: { num: { type: 'integer' }, key: { type: 'string' }, level: { type: 'integer', minimum: 0, maximum: 3 } } } },
  },
};

function gddFiles(game) {
  const docs = db.cloudArtifacts.filter((c) => c.gameId === game.id && c.mirrored && (c.role === 'gdd' || /gdd|design doc/i.test(c.title)))
    .map((c) => ({ title: c.title, file: path.join(paths.cloud, c.id, 'page.html') })).filter((f) => fs.existsSync(f.file));
  // Once the GDD has versions in Ballast (GDD tab), the current version is the GDD.
  const own = path.join(HOME, 'gdd', game.id, 'current.md');
  if (fs.existsSync(own)) return [{ title: 'GDD (current version in Ballast)', file: own }];
  return docs;
}

function prompt(game) {
  const docs = gddFiles(game);
  const board = tasksOf(game.id).slice(-200).map((t) => `#${t.num} [${t.status}] ${t.title}`).join('\n');
  return `Break the game design of "${game.name}" into features with four quality levels each, so a solo developer's AI team can work level by level toward milestones.

Quality levels:
${LEVELS.map((l) => `- L${l.n} ${l.name}: ${l.text}`).join('\n')}

You are in the game's folder. Find and read the GDD and design docs (GDD.md, design/, docs/ and similar)${docs.length ? `, and these GDD pages saved from claude.ai: ${docs.map((d) => `${d.file} (${d.title})`).join(', ')}` : ''}. Skim the code to judge how far each feature really is.

How to cut it into sections (aim for 8-25): ${(SCHEMES[game.roadmap?.scheme?.kind] || SCHEMES.features).text}${game.roadmap?.scheme?.guide?.trim() ? `\nThe director's own instructions, which win where they differ:\n${game.roadmap.scheme.guide.trim()}` : ''}
Then, for each section:
- kind: system, feature, content, character, level, journey or other.
- area: which department mostly owns it (${DISCIPLINES.join(', ')}).
- core: true if it's part of the core loop.
- currentLevel: the highest level the repo already meets (-1 if not started). Be honest: L1 needs it to work end to end.
- levels: for L0..L3, what "done" means at that level (something you can check by playing) and the 1-5 tasks that take it there from the level below. Leave tasks empty for levels already reached. Task titles start with the department tag, e.g. "[gameplay] Hiding spots: score for staying hidden". Details say what to do and how to check it, for an agent who hasn't read the GDD.
Also map board tasks that clearly belong to a feature level in "existing" (by number).

Game brief:
${game.brief?.trim().slice(0, 3000) || '(none)'}

Board:
${board || '(empty)'}`;
}

export function start(gameId, { model, scheme, guide } = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  must(game.repoPath, 'This game has no folder Ballast can read.');
  const rm = (game.roadmap ||= { features: [], milestones: [] });
  if (rm.status === 'running') return rm;
  if (scheme !== undefined || guide !== undefined) rm.scheme = { kind: SCHEMES[scheme] ? scheme : (rm.scheme?.kind || 'features'), guide: String(guide ?? rm.scheme?.guide ?? '').slice(0, 4000) };
  Object.assign(rm, { status: 'running', startedAt: Date.now(), error: null, model: model || db.settings.roadmapModel || 'opus' });
  save();
  changed();
  run(game).catch(() => {});
  return rm;
}

async function run(game) {
  const rm = game.roadmap;
  try {
    const acct = db.accounts.filter((a) => a.loggedIn && !(a.limitedUntil > Date.now())).sort((a, b) => orch.utilization(a) - orch.utilization(b))[0];
    must(acct, 'No logged-in account has usage free right now.');
    const { result } = await claude.runQuick({
      account: acct,
      cwd: game.subdir ? path.join(game.repoPath, game.subdir) : game.repoPath,
      args: ['--model', rm.model, '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', '--add-dir', paths.cloud, '--add-dir', path.join(HOME, 'gdd'), '--json-schema', JSON.stringify(SCHEMA)],
      prompt: prompt(game),
    });
    if (result) recordUsage({ account: acct, gameId: game.id, kind: 'roadmap', result });
    const out = result?.structured_output;
    must(out?.features?.length, result?.result?.slice(0, 300) || 'The breakdown returned no features.');
    merge(game, out);
    rm.status = 'done';
    rm.breakdownAt = Date.now();
    orch.feedPost(game.id, { kind: 'system', text: `GDD broken down into ${rm.features.length} sections (${(SCHEMES[rm.scheme?.kind] || SCHEMES.features).label.toLowerCase()}${rm.scheme?.guide ? ', with your instructions' : ''}) with L0-L3 quality levels. Milestone: ${active(game)?.name || 'none'}. Ballast keeps the board stocked one level at a time.` });
    tick(game);
  } catch (err) {
    Object.assign(rm, { status: 'error', error: err.message });
  }
  save();
  changed();
}

// A re-run keeps what you've changed (core flags, levels reached) for features it recognizes.
function merge(game, out) {
  const rm = game.roadmap;
  const old = new Map(rm.features.map((f) => [f.key, f]));
  // In a re-break, a new section starts at the gate its siblings have now (core or not), never at a
  // milestone's target: milestones can mark themselves reached, but only the director opens gates.
  const usualGate = (core) => {
    const seen = rm.features.filter((f) => !!f.core === !!core && f.gate !== undefined).map((f) => f.gate);
    if (!seen.length) return undefined;
    const count = new Map();
    for (const g of seen) count.set(g, (count.get(g) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  };
  rm.features = out.features.map((f) => {
    const prev = old.get(f.key);
    const levels = [0, 1, 2, 3].map((n) => {
      const l = f.levels.find((x) => x.level === n) || { done: '', tasks: [] };
      return { done: l.done, tasks: (l.tasks || []).slice(0, 6).map((t) => ({ title: t.title.slice(0, 200), detail: t.detail })) };
    });
    return {
      id: prev?.id || uid('feat'),
      key: f.key,
      name: f.name,
      kind: KINDS.includes(f.kind) ? f.kind : prev?.kind || 'feature',
      area: f.area,
      core: prev?.coreSet ? prev.core : f.core,
      coreSet: prev?.coreSet || false,
      summary: f.summary,
      gdd: f.gdd || '',
      base: prev?.verified ? prev.base : Math.max(prev?.base ?? -1, f.currentLevel),
      verified: prev?.verified || null,
      gate: prev?.gate ?? usualGate(prev ? prev.core : f.core), // the director's gate (src/gates.mjs); a first breakdown's come from gates.ensure
      levels,
    };
  });
  // A re-break with another scheme replaces sections: tickets of sections that are gone go back to
  // "no section", so the mapping below (or Sort into sections) places them again.
  const ids = new Set(rm.features.map((f) => f.id));
  for (const t of tasksOf(game.id)) if (t.featureId && !ids.has(t.featureId)) { delete t.featureId; delete t.level; delete t.noSection; }
  const byKey = new Map(rm.features.map((f) => [f.key, f]));
  for (const e of out.existing || []) {
    const t = tasksOf(game.id).find((x) => x.num === e.num);
    const f = byKey.get(e.key);
    if (t && f && !t.featureId) Object.assign(t, { featureId: f.id, level: e.level });
  }
  if (!rm.milestones?.length) rm.milestones = DEFAULT_MILESTONES.map((m) => ({ id: uid('ms'), ...m, overrides: {} }));
  gates.ensure(game);
}

// ---------------------------------------------------------------------------
// Levels, milestones, backlog

// The level a feature has reached: its starting estimate (or its verified level, after a level audit
// or the director set it), raised by every level whose tasks are all done. After a verification only
// tasks made since then count: tickets closed before it were already weighed.
const countedTasks = (game, f) => tasksOf(game.id).filter((t) => t.featureId === f.id && (!f.verified || (t.createdAt || 0) >= f.verified.at));
export function levelOf(game, f) {
  let lvl = f.base ?? -1;
  const tasks = countedTasks(game, f);
  for (let n = lvl + 1; n <= 3; n++) {
    const at = tasks.filter((t) => t.level === n);
    if (at.length && at.every((t) => t.status === 'done')) lvl = n;
    else break;
  }
  return lvl;
}

export const targetOf = (m, f) => (m.overrides?.[f.id] ?? (f.core ? m.core : m.other));
export const active = (game) => game.roadmap?.milestones?.find((m) => !m.reachedAt) || null;

function pace(game) {
  const done = tasksOf(game.id).filter((t) => t.status === 'done' && t.doneAt);
  const in14 = done.filter((t) => t.doneAt >= Date.now() - 14 * DAY).length;
  if (in14 >= 3) return in14 / 14;
  return done.filter((t) => t.doneAt >= Date.now() - 30 * DAY).length / 30;
}

// Progress and forecast for one milestone: remaining work counts open tasks already on the
// board plus planned tasks for levels not stocked yet.
export function forecast(game, m) {
  const tasks = tasksOf(game.id);
  let done = 0;
  let remaining = 0;
  let featuresMet = 0;
  for (const f of game.roadmap.features) {
    const target = targetOf(m, f);
    const lvl = levelOf(game, f);
    if (lvl >= target) featuresMet++;
    for (let n = 0; n <= target; n++) {
      const at = tasks.filter((t) => t.featureId === f.id && t.level === n);
      if (n <= lvl) { done += Math.max(at.filter((t) => t.status === 'done').length, at.length ? 0 : f.levels[n].tasks.length || 1); continue; }
      if (at.length) { done += at.filter((t) => t.status === 'done').length; remaining += at.filter((t) => t.status !== 'done').length; } else remaining += f.levels[n].tasks.length || 1;
    }
  }
  const perDay = pace(game);
  return {
    done, remaining, featuresMet, features: game.roadmap.features.length,
    progress: done + remaining ? done / (done + remaining) : 1,
    perDay: Math.round(perDay * 10) / 10,
    eta: remaining === 0 ? Date.now() : perDay > 0 ? Date.now() + (remaining / perDay) * DAY : null,
  };
}

// Stock the board for the active milestone: each feature below its target gets the tasks for its
// next level, once. Called after a breakdown and every minute.
// With production gates on, a section is stocked only up to its gate, which the director moves.
function backlog(game) {
  const m = active(game);
  const gated = gates.on(game);
  if (!m && !gated) return 0;
  const tasks = tasksOf(game.id);
  let added = 0;
  for (const f of game.roadmap.features) {
    const next = levelOf(game, f) + 1;
    if (next > gates.capOf(game, f) || next > 3) continue;
    if (countedTasks(game, f).some((t) => t.level === next)) continue;
    const doneTitles = new Set(tasks.filter((t) => t.featureId === f.id && t.status === 'done').map((t) => t.title.toLowerCase()));
    const fresh = f.levels[next].tasks.filter((p) => !doneTitles.has(p.title.toLowerCase()));
    const plan = fresh.length ? fresh : [{ title: `[${f.area}] ${f.name}: reach L${next} ${LEVELS[next].name}`, detail: f.verified?.missing || '' }];
    for (const p of plan) {
      orch.addTask(game.id, {
        title: /^\s*\[/.test(p.title) ? p.title : `[${f.area}] ${p.title}`,
        detail: `${p.detail}\n\nFeature: ${f.name} (L${next} ${LEVELS[next].name}). Done at this level means: ${f.levels[next].done || LEVELS[next].text}\n${f.summary}${f.gdd ? `\nGDD: ${f.gdd}` : ''}`.trim(),
        createdBy: gated ? `Roadmap (${f.name} gate L${f.gate})` : `Roadmap (${m.name})`,
        featureId: f.id,
        level: next,
      });
      added++;
    }
  }
  return added;
}

export function tick(game) {
  const rm = game.roadmap;
  if (!rm?.features?.length || (game.status || 'active') !== 'active') return;
  gates.ensure(game);
  const seen = (rm.levelSeen ||= {});
  for (const f of rm.features) {
    const lvl = levelOf(game, f);
    if (seen[f.id] !== undefined && lvl > seen[f.id]) orch.feedPost(game.id, { kind: 'system', text: `${f.name} reached L${lvl} ${LEVELS[lvl].name}.${gates.on(game) && lvl >= (f.gate ?? -1) ? ' It has met its gate: it waits for you to pass it (Sections tab).' : ''}` });
    seen[f.id] = lvl;
  }
  const m = active(game);
  if (m && rm.features.every((f) => levelOf(game, f) >= targetOf(m, f))) {
    m.reachedAt = Date.now();
    const next = active(game);
    orch.feedPost(game.id, { kind: 'system', text: `Milestone reached: ${m.name}! ${next ? `Next up: ${next.name}.` : 'That was the last milestone.'}` });
  }
  const added = backlog(game);
  if (added) orch.feedPost(game.id, { kind: 'system', text: `Roadmap added ${added} task${added > 1 ? 's' : ''} toward ${gates.on(game) ? 'the sections\' gates' : active(game)?.name}.` });
  save();
}

export function init() {
  for (const g of db.games) if (g.roadmap?.status === 'running') Object.assign(g.roadmap, { status: 'error', error: 'Ballast restarted before the breakdown finished. Run it again.' });
  setInterval(() => { for (const g of db.games) { try { tick(g); } catch (err) { console.error('[ballast] roadmap', err.message); } } changed(); }, 60e3).unref();
}

// ---------------------------------------------------------------------------
// Edits from the Roadmap tab

export function update(gameId, body = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const rm = must(game.roadmap, 'Break down the GDD first.');
  if (body.feature) {
    const f = must(rm.features.find((x) => x.id === body.feature.id), 'Unknown feature');
    if (body.feature.core !== undefined) Object.assign(f, { core: !!body.feature.core, coreSet: true });
    if (body.feature.base !== undefined) {
      f.base = Math.max(-1, Math.min(3, Number(body.feature.base)));
      f.verified = { level: f.base, at: Date.now(), by: 'director', said: levelOf(game, f) };
    }
  }
  if (body.milestone) {
    const m = must(rm.milestones.find((x) => x.id === body.milestone.id), 'Unknown milestone');
    for (const k of ['core', 'other']) if (body.milestone[k] !== undefined) m[k] = Math.max(0, Math.min(3, Number(body.milestone[k])));
    if (body.milestone.name?.trim()) m.name = body.milestone.name.trim().slice(0, 60);
    if (body.milestone.reopen) delete m.reachedAt;
    if (body.milestone.override) {
      const { featureId, level } = body.milestone.override;
      if (level === null || level === '') delete m.overrides[featureId];
      else m.overrides[featureId] = Math.max(0, Math.min(3, Number(level)));
    }
  }
  if (body.addMilestone) rm.milestones.push({ id: uid('ms'), name: String(body.addMilestone.name || 'Milestone').slice(0, 60), core: 3, other: 2, overrides: {} });
  if (body.removeMilestone) rm.milestones = rm.milestones.filter((m) => m.id !== body.removeMilestone);
  save();
  tick(game);
  changed();
  return publicRoadmap(game);
}

// Everything the Roadmap tab draws, computed here so levels and forecasts match the backlog.
export function publicRoadmap(game) {
  const rm = game?.roadmap;
  if (!rm) return null;
  const tasks = tasksOf(game.id);
  return {
    status: rm.status, error: rm.error, breakdownAt: rm.breakdownAt, model: rm.model, audit: rm.audit || null,
    scheme: rm.scheme || { kind: 'features', guide: '' }, schemes: Object.fromEntries(Object.entries(SCHEMES).map(([k, v]) => [k, v.label])),
    active: active(game)?.id || null,
    gates: gates.publicGates(game),
    features: rm.features.map((f) => ({
      ...f,
      level: levelOf(game, f),
      open: [0, 1, 2, 3].map((n) => tasks.filter((t) => t.featureId === f.id && t.level === n && t.status !== 'done').length),
      doneCount: [0, 1, 2, 3].map((n) => tasks.filter((t) => t.featureId === f.id && t.level === n && t.status === 'done').length),
      held: tasks.filter((t) => t.featureId === f.id && t.status !== 'done' && gates.heldBy(game, t)).length,
      unlevelled: tasks.filter((t) => t.featureId === f.id && t.status !== 'done' && t.level == null).length,
    })),
    milestones: (rm.milestones || []).map((m) => ({ ...m, ...forecast(game, m) })),
  };
}
