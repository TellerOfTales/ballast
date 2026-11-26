// Gameplay Loop tab: audits a game's loops against "The Readable Loop" (an RGD framework checked
// against recent player-experience research), keeps a computational model of each loop that the
// director can tune with sliders, answers questions about one loop (adding the sliders and graphs the
// answer needs), and turns the director's tuning and decisions into board tasks on "Lock In Changes".
// The point is to keep a game on its core skill and retention curves: every audit also sorts recent
// tickets by the loop they serve, so work drifting off every loop shows up.
//
// Models are formulas over the loop's parameters (see public/loopmath.js): each parameter has the value
// read from the code (base) and the director's draft (value). Charts draw both, so a slider shows its
// effect against what the game does today.
import path from 'node:path';
import { db, save } from './store.mjs';
import { bus, changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import * as gdd from './gddreview.mjs';
import * as git from './git.mjs';
import * as perf from './perf.mjs';
import * as pace from './pace.mjs';
import * as jungledocs from './jungledocs.mjs';
import { recordUsage } from './usage.mjs';
import '../public/loopmath.js';

const LM = globalThis.LoopMath;
const must = (v, msg, status = 400) => { if (!v) throw Object.assign(new Error(msg), { status }); return v; };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || uid('loop');
const DAY = 864e5;

export const SCALES = ['moment', 'encounter', 'session', 'meta'];
export const STAGES = [
  { id: 'skill', name: 'One skill', test: 'The loop names one player skill before its mechanic. A loop that tests two skills is two loops.' },
  { id: 'signs', name: 'Predict, then act', test: 'Signs arrive before the outcome, so the player can form an expectation.' },
  { id: 'uncertainty', name: 'Keep the answer open', test: 'Outcomes stay uncertain for each player band, not an average player. Near-wins and near-losses happen.' },
  { id: 'feedback', name: 'Dose the feedback', test: 'Results are amplified in proportion to what the player did: neither none nor extreme.' },
  { id: 'model', name: 'Every pass moves the model', test: 'Each repetition changes what the player knows, has or wants; when it stops teaching, the loop gets an arc.' },
  { id: 'nesting', name: 'Nest the clocks', test: 'The answer at this time scale feeds the question at the next one.' },
];

const FRAMEWORK = `The Readable Loop (the director's framework: Rational Game Design, checked against player-experience research up to Nov 2026).
A compelling loop is a readable question with an uncertain answer, asked at several time scales (moment, encounter, session, meta), where every answer changes what the player knows or wants. RGD gives the chain: player skill → mechanic → atomic parameters → signs and feedback → progression.
Seven rules:
1. One skill per loop. Name the skill before the mechanic. Depth comes from exploring a few skills through level design, not from adding verbs. A loop testing two skills is two loops.
2. Predict, then act. Signs must arrive before the outcome. A player who can't form an expectation can't be surprised and can't learn.
3. Keep the answer open. Tune parameters so outcomes stay uncertain for each player band (new, mid, expert), not an average player. Near-wins and near-losses are the signal to watch.
4. Dose the feedback. Amplify results in proportion to what the player did. Zero juice and maximal juice both measured worse than the middle (Kao 2020, N = 3,018: None and Extreme were significantly lower than Medium and High on play time, experience, intrinsic motivation and performance; a follow-up traced the benefit to legible action-outcome links and graded, uncertain success).
5. Every pass moves the model. Each repetition should change what the player knows, has or wants. When a loop stops teaching, give it an arc: a new question, a story beat, a twist on the same skill.
6. Nest the clocks. Moment, encounter, session and meta loops each ask their own question, and the answer at one scale feeds the question at the next.
7. Measure what players do. Felt satisfaction and actual return behaviour can diverge. Validate loops with telemetry and observed skill chains, not surveys alone. (Ballou et al. 2026 is a preprint: a strong signal, not settled.)
The six stage tests for one loop at one time scale: ${STAGES.map((s) => `${s.id} (${s.name}): ${s.test}`).join(' ')} The weakest stage is usually where the loop leaks.`;

const MODEL_RULES = `Computational models. Each loop gets a small model the director can tune live:
- params: the loop's real tunables, read from the code (the value in the code today, with "path/to/file.ts:line"). 3-8 per loop, the ones that move its skill curve, uncertainty, feedback dose or pacing. key is a short identifier (letters, digits, _), min/max a sensible tuning range around the value, step a useful increment. Never invent a value: if the code has no number for it, leave it out (or say so in the finding).
- charts: 2-4 per loop. Each series is a formula over the params and x (the chart's axis). Formulas use + - * / ^ %, comparisons, c ? a : b, and the functions ${LM.FN.join(', ')}; constants pi and e. No other names. Pick charts that show the loop at its computational level, for example: chance of success (or of a near-win) against player skill x from 0 to 1, with three series for new, mid and expert play, and a band from 0.3 to 0.7 marking "answer still open"; the skill curve (success or mastery against attempts or minutes played); feedback intensity against the size of what the player did; time between meaningful answers across a session; a modelled return or retention curve over days. Derive the formulas from how the code uses the params; where you have to assume a shape (a player's skill, a logistic curve), say so in "why". A chart is a model, not telemetry: say which.
- tiles: 0-4 headline numbers worth watching (time to kill, shots per hole, minutes to the first upgrade), each a formula over the params, with a target range where the GDD or the evidence gives one.`;

const CHART = {
  type: 'object',
  required: ['id', 'title', 'why', 'xLabel', 'xMin', 'xMax', 'yLabel', 'series'],
  properties: {
    id: { type: 'string' }, title: { type: 'string' }, why: { type: 'string', description: 'What it shows, and what is assumed rather than read from code.' },
    xLabel: { type: 'string' }, xMin: { type: 'number' }, xMax: { type: 'number' },
    yLabel: { type: 'string' }, yMin: { type: 'number' }, yMax: { type: 'number' },
    series: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', required: ['label', 'expr'], properties: { label: { type: 'string' }, expr: { type: 'string' } } } },
    bandFrom: { type: 'number' }, bandTo: { type: 'number' }, bandLabel: { type: 'string', description: 'A target zone on the y axis, e.g. 0.3-0.7 "answer still open".' },
  },
};
const PARAM = {
  type: 'object',
  required: ['key', 'label', 'value', 'min', 'max', 'step'],
  properties: {
    key: { type: 'string' }, label: { type: 'string' }, value: { type: 'number', description: 'The value in the code today.' },
    min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number' }, unit: { type: 'string' },
    source: { type: 'string', description: 'file:line where the value lives.' }, affects: { type: 'string', description: 'What moving it changes for the player.' },
  },
};
const TILE = {
  type: 'object',
  required: ['id', 'label', 'expr'],
  properties: { id: { type: 'string' }, label: { type: 'string' }, expr: { type: 'string' }, unit: { type: 'string' }, targetMin: { type: 'number' }, targetMax: { type: 'number' }, why: { type: 'string' } },
};

const COHERENCE = {
  type: 'object',
  required: ['verdict', 'headline', 'chain', 'breaks'],
  properties: {
    verdict: { enum: ['coherent', 'strained', 'broken'], description: 'coherent: the loops as built form a compelling, repeatable loop that nests. strained: it repeats, but a link is weak (signs late, answer closed, feedback off, a system feeding nothing). broken: a core loop has no readable question, no uncertain answer, or nothing that brings the player back.' },
    headline: { type: 'string', description: 'One plain sentence: does the design deliver a compelling, repeatable loop right now, and the biggest reason why or why not.' },
    chain: { type: 'string', description: 'The core loop as a player meets it today, as short steps joined by " → " (e.g. "Read the lie → pick a club → swing → see where it lands → next shot → hole out → next hole"). Mark a weak link with "(weak)".' },
    breaks: { type: 'array', maxItems: 4, description: 'Where the design stops holding together, most serious first.', items: { type: 'object', required: ['loopId', 'problem', 'fix'], properties: { loopId: { type: 'string' }, problem: { type: 'string', description: 'One plain sentence.' }, fix: { type: 'string', description: 'One plain sentence.' } } } },
    changes: { type: 'string', description: 'One or two sentences: what recent changes to mechanics did to the loop (strengthened it, left it intact, or broke a link). Changing mechanics while the director tests them is expected; only say what it means for coherence. Empty if nothing changed.' },
  },
};

const ACTIONS = {
  type: 'array', maxItems: 6,
  description: 'The few things that matter most, ranked. Each one short and concrete.',
  items: {
    type: 'object',
    required: ['priority', 'kind', 'title', 'why', 'loopId'],
    properties: {
      priority: { enum: ['now', 'next', 'later'] },
      kind: { enum: ['playtest', 'tune', 'design', 'park'], description: 'playtest: the director should play something to answer a question. tune: change numbers. design: change how the loop works. park: set aside a system that feeds no loop yet.' },
      title: { type: 'string', description: 'An instruction of at most 10 words, e.g. "Play holes 1-3 in the headset".' },
      why: { type: 'string', description: 'One sentence: what it fixes in the loop.' },
      loopId: { type: 'string' },
      values: { type: 'array', description: 'For tune actions: slider settings that try it.', items: { type: 'object', required: ['key', 'value'], properties: { key: { type: 'string' }, value: { type: 'number' } } } },
    },
  },
};

const AUDIT_SCHEMA = {
  type: 'object',
  required: ['summary', 'coherence', 'actions', 'core', 'loops', 'focus'],
  properties: {
    summary: { type: 'string', description: 'Two short plain sentences for the director: the state of the loop, and the one thing to do first.' },
    coherence: COHERENCE,
    actions: ACTIONS,
    core: {
      type: 'object', required: ['skill', 'skillCurve', 'retention', 'drift'],
      properties: {
        skill: { type: 'string', description: 'The core skill the game is about.' },
        skillCurve: { type: 'string', description: 'The intended skill curve: how a player gets better and what keeps the answer open as they do.' },
        retention: { type: 'string', description: 'What brings a player back (next round, next session, next week).' },
        drift: { type: 'string', description: 'Where the design is losing coherence (not merely where mechanics changed), in one sentence. Empty if it holds.' },
      },
    },
    loops: {
      type: 'array', minItems: 1, maxItems: 7,
      items: {
        type: 'object',
        required: ['id', 'name', 'scale', 'core', 'skill', 'question', 'description', 'stages', 'params', 'charts', 'iterate'],
        properties: {
          id: { type: 'string', description: 'Reuse the id of an existing loop when it is the same loop.' },
          name: { type: 'string' }, scale: { enum: SCALES }, core: { type: 'boolean', description: 'Part of the core skill or retention curve.' },
          skill: { type: 'string' }, question: { type: 'string', description: 'The question the loop asks the player.' },
          feeds: { type: 'string', description: 'The id of the loop at the next time scale this answer feeds, or empty.' },
          description: { type: 'string' },
          stages: {
            type: 'array', minItems: 6, maxItems: 6,
            items: { type: 'object', required: ['stage', 'score', 'basis', 'finding'], properties: { stage: { enum: STAGES.map((s) => s.id) }, score: { type: 'integer', minimum: 0, maximum: 3, description: '0 missing, 1 weak, 2 holds, 3 strong.' }, basis: { enum: ['telemetry', 'playtest', 'director', 'code', 'assumption'], description: 'What the score rests on.' }, finding: { type: 'string', description: 'One plain sentence.' }, fix: { type: 'string', description: 'One plain sentence.' } } },
          },
          playtest: {
            type: 'array', maxItems: 6, description: 'Playtest results and director reviews that bear on this loop.',
            items: { type: 'object', required: ['source', 'says', 'interpretation'], properties: { source: { type: 'string', description: 'e.g. "note #41, Nov 12" or "review of #88".' }, says: { type: 'string' }, interpretation: { type: 'string', description: 'What it means for the loop, by the framework.' }, implication: { type: 'string' } } },
          },
          params: { type: 'array', maxItems: 8, items: PARAM },
          charts: { type: 'array', maxItems: 4, items: CHART },
          tiles: { type: 'array', maxItems: 4, items: TILE },
          iterate: {
            type: 'array', maxItems: 4, description: 'Next iterations of this loop, from the weakest stages and the playtest evidence.',
            items: { type: 'object', required: ['title', 'why'], properties: { title: { type: 'string' }, why: { type: 'string' }, values: { type: 'array', description: 'Slider settings that try it, when it is a tuning change.', items: { type: 'object', required: ['key', 'value'], properties: { key: { type: 'string' }, value: { type: 'number' } } } } } },
          },
        },
      },
    },
    focus: {
      type: 'object', required: ['byLoop', 'support', 'off'],
      description: 'Every ticket listed under "Recent tickets", sorted by what it serves.',
      properties: {
        byLoop: { type: 'array', items: { type: 'object', required: ['loopId', 'nums'], properties: { loopId: { type: 'string' }, nums: { type: 'array', items: { type: 'integer' } } } } },
        support: { type: 'array', items: { type: 'integer' }, description: 'Needed groundwork that serves no single loop: builds, CI, crashes, performance, platform.' },
        off: { type: 'array', items: { type: 'object', required: ['num', 'why'], properties: { num: { type: 'integer' }, why: { type: 'string', description: 'Why it serves none of the loops.' } } } },
      },
    },
  },
};

const CHAT_SCHEMA = {
  type: 'object',
  required: ['reply'],
  properties: {
    reply: { type: 'string', description: 'The answer for the director, plainly, with file paths where they help.' },
    params: { type: 'array', maxItems: 6, description: 'Sliders to add (or to update by key): only values read from the code.', items: PARAM },
    set: { type: 'array', description: 'Move sliders to these draft values: only when the director asked for a change or a scenario.', items: { type: 'object', required: ['key', 'value'], properties: { key: { type: 'string' }, value: { type: 'number' } } } },
    charts: { type: 'array', maxItems: 3, description: 'Graphs to add, or to replace by id.', items: CHART },
    removeCharts: { type: 'array', items: { type: 'string' } },
    tiles: { type: 'array', maxItems: 3, items: TILE },
    change: { type: 'string', description: 'A design change the director decided in this exchange that isn\'t a slider (it goes to Lock In). Empty if none.' },
  },
};

const LOCK_SCHEMA = {
  type: 'object',
  required: ['summary', 'tasks'],
  properties: {
    summary: { type: 'string', description: 'Two or three sentences for the Feed: what changes for the player and which curves it protects.' },
    tasks: {
      type: 'array', maxItems: 10,
      items: { type: 'object', required: ['loopId', 'title', 'detail'], properties: { loopId: { type: 'string' }, title: { type: 'string', description: 'Starts with a department tag like [gameplay] or [design].' }, detail: { type: 'string', description: 'What to change (files, from → to), why in terms of the loop, and how to check it in a playtest.' } } },
    },
  },
};

// ---------------------------------------------------------------------------
// State

const state = (game) => ((db.gameLoops ||= {})[game.id] ||= { every: 'off', at: '09:00', day: 1, model: '', loops: [], history: [], status: 'idle' });
const emit = (gameId) => { bus.emit('event', { type: 'loops', gameId }); };
const running = { audit: new Set(), chat: new Set(), lock: new Set() };

function account() {
  return db.accounts.filter((x) => x.loggedIn && !(x.limitedUntil > Date.now()) && orch.utilization(x) * 100 < (db.settings.limitGuardPct || 95)).sort(pace.compareAccounts)[0] || null;
}

function health(loop) {
  const s = loop.stages || [];
  return s.length ? Math.round((s.reduce((n, x) => n + x.score, 0) / (s.length * 3)) * 100) : null;
}

function cleanKey(k) { return String(k || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1').slice(0, 40); }

function cleanParam(p, origin) {
  const key = cleanKey(p.key);
  let { min, max } = p;
  const v = Number(p.value);
  if (!key || !Number.isFinite(v)) return null;
  if (!(Number.isFinite(min) && Number.isFinite(max) && max > min)) { min = v === 0 ? 0 : Math.min(v * 0.25, v * 2); max = v === 0 ? 1 : Math.max(v * 0.25, v * 2); }
  min = Math.min(min, v); max = Math.max(max, v);
  const step = Number.isFinite(p.step) && p.step > 0 ? p.step : Math.max((max - min) / 100, 1e-6);
  return { key, label: clip(p.label || key, 60), base: v, value: v, min, max, step, unit: clip(p.unit, 16), source: clip(p.source, 160), affects: clip(p.affects, 240), origin };
}

// Formulas must compile against the loop's names and give a number somewhere in range.
function checkExpr(expr, names) {
  try {
    const f = LM.compile(String(expr), [...names, 'x']);
    return f.uses.every((u) => names.includes(u) || u === 'x') ? null : 'unknown name';
  } catch (err) { return err.message; }
}

function cleanChart(c, names, origin) {
  const series = (c.series || []).filter((s) => s?.expr && !checkExpr(s.expr, names)).slice(0, 4).map((s) => ({ label: clip(s.label, 40), expr: String(s.expr).slice(0, 600) }));
  if (!series.length || !(c.xMax > c.xMin)) return null;
  const out = { id: cleanKey(c.id) || uid('chart'), title: clip(c.title, 80), why: clip(c.why, 400), xLabel: clip(c.xLabel, 40), xMin: c.xMin, xMax: c.xMax, yLabel: clip(c.yLabel, 40), series, origin };
  if (Number.isFinite(c.yMin)) out.yMin = c.yMin;
  if (Number.isFinite(c.yMax) && !(Number.isFinite(c.yMin) && c.yMax <= c.yMin)) out.yMax = c.yMax;
  if (Number.isFinite(c.bandFrom) && Number.isFinite(c.bandTo) && c.bandTo > c.bandFrom) Object.assign(out, { bandFrom: c.bandFrom, bandTo: c.bandTo, bandLabel: clip(c.bandLabel, 40) });
  return out;
}

function cleanTile(t, names, origin) {
  if (!t?.expr || checkExpr(t.expr, names)) return null;
  const out = { id: cleanKey(t.id) || uid('tile'), label: clip(t.label, 50), expr: String(t.expr).slice(0, 400), unit: clip(t.unit, 16), why: clip(t.why, 240), origin };
  if (Number.isFinite(t.targetMin)) out.targetMin = t.targetMin;
  if (Number.isFinite(t.targetMax)) out.targetMax = t.targetMax;
  return out;
}

// ---------------------------------------------------------------------------
// Evidence: what players did and what the director made of it

function evidence(game) {
  const director = orch.directorName();
  const notes = orch.readFeed(game.id, 3000).filter((e) => e.kind === 'note' && (e.from === director || ['director', 'review', 'review-session', 'playtest'].includes(e.source))).slice(-25)
    .map((e) => `note #${e.num || '?'} (${new Date(e.ts || 0).toLocaleDateString()}${e.source ? `, ${e.source}` : ''}): ${clip(e.text, 900)}`);
  const tasks = db.tasks.filter((t) => t.gameId === game.id);
  const reviews = tasks.filter((t) => t.createdBy === 'Director review' || /^changes to #\d+/i.test(t.title)).slice(-15).map((t) => `#${t.num} ${t.title}: ${clip(t.detail, 400)}`);
  const answers = (db.inbox || []).filter((q) => q.gameId === game.id && q.status === 'answered' && q.answer && !/^Added to the board/.test(q.answer)).slice(-15)
    .map((q) => `Q: ${clip(q.question, 300)}\n  Director: ${clip(q.answer, 400)}`);
  let perfLine = '';
  try {
    const last = perf.runs(game.id).filter((r) => !r.hidden).pop();
    if (last) perfLine = `Latest profiler run (${new Date(last.at).toLocaleDateString()}): ${last.budgets.map((b) => `${b.name} ${b.value}${b.unit && !['max', 'mean'].includes(b.unit) ? b.unit : ''} ${b.pass ? 'within' : 'OVER'} ${b.limit ?? '?'}`).join('; ')}`;
  } catch { /* none */ }
  const since = Date.now() - 21 * DAY;
  const recent = tasks.filter((t) => t.status !== 'cancelled' && ((t.createdAt || 0) > since || t.status !== 'done')).slice(-150);
  return { notes, reviews, answers, perfLine, recent };
}

const evidenceText = (ev) => `The director's notes, playtest notes and video reviews (newest last):
${ev.notes.join('\n') || '(none)'}
${ev.reviews.length ? `\nReview send-backs (the director's verdicts on finished work):\n${ev.reviews.join('\n')}\n` : ''}${ev.answers.length ? `\nThe director's answers to the team's questions (their interpretations and calls):\n${ev.answers.join('\n')}\n` : ''}${ev.perfLine ? `\n${ev.perfLine}\n` : ''}`;

const loopText = (l) => `${l.id}: ${l.name} [${l.scale}${l.core ? ', core' : ''}] skill: ${l.skill}; question: ${l.question}
  params (value in code → director's draft): ${l.params.map((p) => `${p.key} "${p.label}" ${p.base}${p.value !== p.base ? ` → ${p.value}` : ''}${p.unit ? ` ${p.unit}` : ''} [${p.min}..${p.max}] ${p.source || ''}`).join('; ') || '(none)'}
  charts: ${l.charts.map((c) => `${c.id} "${c.title}" x=${c.xLabel} [${c.xMin}..${c.xMax}]: ${c.series.map((s) => `${s.label} = ${s.expr}`).join(' | ')}`).join('; ') || '(none)'}
  tiles: ${(l.tiles || []).map((t) => `${t.id} "${t.label}" = ${t.expr}`).join('; ') || '(none)'}`;

// ---------------------------------------------------------------------------
// Audit

export function startAudit(gameId, { scheduled = false } = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const st = state(game);
  if (running.audit.has(game.id)) return publicState(game);
  must(game.repoPath, 'This game has no repo to read yet.');
  running.audit.add(game.id);
  Object.assign(st, { status: 'running', startedAt: Date.now(), error: null, runModel: st.model || db.settings.auditModel || 'opus' });
  save(); emit(game.id); changed();
  audit(game, { scheduled }).catch((err) => Object.assign(st, { status: 'error', error: err.message })).finally(() => {
    running.audit.delete(game.id);
    if (st.status === 'running') st.status = 'done';
    st.nextAt = gdd.nextRun(st);
    save(); emit(game.id); changed();
  });
  return publicState(game);
}

async function audit(game, { scheduled }) {
  const st = state(game);
  const { files, commit } = await gdd.pullLatest(game);
  const ev = evidence(game);
  const acct = must(account(), 'No logged-in account has usage free right now.');
  const prior = st.loops.length ? `Loops from the last audit (reuse their ids when it's the same loop; the director may have tuned them):\n${st.loops.map(loopText).join('\n')}` : 'This is the first audit: find the loops.';
  const prompt = `${game.subdir ? `This game's own folder is ${game.subdir}/; the apps that load it are elsewhere in this repo.\n\n` : ''}Audit the gameplay loops of "${game.name}" for its director. The question is whether the design is coherent and delivers a compelling, repeatable loop. Mechanics change as the director tests them, and that's expected: it is not drift. Drift is when the design stops holding together (a loop with no readable question, an answer that is decided before the player acts, feedback out of proportion, a system that feeds no loop, an answer that feeds nothing at the next time scale).

Write for a busy director: short plain sentences, no jargon beyond the framework's own words, every finding one sentence.

${FRAMEWORK}

Read the GDD (plain text):
${files.map((f) => `- ${f}`).join('\n') || '(no GDD found: work from the code and the notes)'}
Then read the code that runs each loop${commit ? ` (repo at ${commit})` : ''}: where its rules, timings, numbers and feedback live.

1. Name the game's loops (3-6) across the time scales: moment, encounter, session, meta. Each tests one skill. Mark the ones that make up the core skill and retention curves.
2. Score each loop on the six stage tests (0-3), saying what each score rests on. Playtest notes, video reviews and the director's verdicts outrank code reading; an assumption scores no higher than 1 unless the code makes it plain.
3. Map the playtest results and director reviews below onto the loops: what each says, how it reads by the framework, and what it implies.
4. ${MODEL_RULES}
5. Suggest up to 4 next iterations per loop, from the weakest stages and the evidence; give slider values where it's a tuning change.
6. Sort every ticket under "Recent tickets" by the loop it serves, as groundwork (support), or as serving none of them (off), with why.
7. Give the coherence verdict: the core loop as a player meets it today, where it stops holding together, and what recent mechanic changes did to it.
8. Rank the 3-6 actions that matter most across all loops (now / next / later). Prefer what restores a broken link in a core loop over polish, and say when the next step is the director playing it rather than more building.

${evidenceText(ev)}
${prior}

Recent tickets (last 3 weeks, and everything still open):
${ev.recent.map((t) => `#${t.num} [${t.status}] ${t.title}`).join('\n') || '(none)'}
${jungledocs.forRun(game).text}`;
  const { result } = await claude.runQuick({
    account: acct,
    cwd: game.repoPath,
    args: ['--model', st.runModel, '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', '--add-dir', gdd.gddDirOf(game), ...jungledocs.forRun(game).args, '--json-schema', JSON.stringify(AUDIT_SCHEMA)],
    prompt,
  });
  if (result) recordUsage({ account: acct, gameId: game.id, kind: 'loop-audit', result });
  const out = result?.structured_output;
  must(out?.loops?.length, clip(result?.result, 300) || 'The audit returned nothing.');
  applyAudit(game, out, { model: st.runModel, account: acct.name, commit, scheduled, recent: ev.recent });
}

export function applyAudit(game, out, meta) {
  const st = state(game);
  const at = Date.now();
  const old = new Map(st.loops.map((l) => [l.id, l]));
  const loops = [];
  const idOf = new Map(); // the ids Claude used → the ids kept
  for (const r of out.loops) {
    let id = old.has(r.id) ? r.id : slug(r.id || r.name);
    while (loops.some((l) => l.id === id)) id = `${id}-2`;
    idOf.set(r.id, id);
    const prev = old.get(id);
    // Parameters: the base is what the code says now. A draft the director set survives, unless the
    // change it was locked in for has landed (the code now has that value).
    const params = [];
    for (const p of r.params || []) {
      const np = cleanParam(p, 'audit');
      if (!np || params.some((x) => x.key === np.key)) continue;
      const was = prev?.params.find((x) => x.key === np.key);
      if (was) {
        Object.assign(np, { min: Math.min(np.min, was.min), max: Math.max(np.max, was.max) });
        const landed = was.locked && Math.abs(was.locked.value - np.base) < 1e-9;
        if (!landed && was.value !== was.base) np.value = Math.min(np.max, Math.max(np.min, was.value));
        if (was.locked && !landed) np.locked = was.locked;
      }
      params.push(np);
    }
    // Sliders the director asked for in chat stay unless the audit read them afresh.
    for (const p of prev?.params || []) if (p.origin === 'chat' && !params.some((x) => x.key === p.key)) params.push(p);
    const names = params.map((p) => p.key);
    const charts = (r.charts || []).map((c) => cleanChart(c, names, 'audit')).filter(Boolean);
    for (const c of prev?.charts || []) if (c.origin === 'chat' && !charts.some((x) => x.id === c.id) && c.series.every((s) => !checkExpr(s.expr, names))) charts.push(c);
    const tiles = (r.tiles || []).map((t) => cleanTile(t, names, 'audit')).filter(Boolean);
    for (const t of prev?.tiles || []) if (t.origin === 'chat' && !tiles.some((x) => x.id === t.id) && !checkExpr(t.expr, names)) tiles.push(t);
    const stages = STAGES.map((s) => {
      const x = (r.stages || []).find((y) => y.stage === s.id) || { score: 0, basis: 'assumption', finding: 'Not assessed.' };
      return { stage: s.id, score: Math.max(0, Math.min(3, x.score | 0)), basis: x.basis, finding: clip(x.finding, 600), fix: clip(x.fix, 400) };
    });
    loops.push({
      id, name: clip(r.name, 60), scale: SCALES.includes(r.scale) ? r.scale : 'encounter', core: !!r.core, skill: clip(r.skill, 200), question: clip(r.question, 240),
      feeds: r.feeds || '', description: clip(r.description, 500), stages,
      playtest: (r.playtest || []).slice(0, 6).map((p) => ({ source: clip(p.source, 60), says: clip(p.says, 400), interpretation: clip(p.interpretation, 400), implication: clip(p.implication, 300) })),
      iterate: (r.iterate || []).slice(0, 4).map((x) => ({ title: clip(x.title, 120), why: clip(x.why, 400), values: (x.values || []).filter((v) => names.includes(cleanKey(v.key)) && Number.isFinite(v.value)).map((v) => ({ key: cleanKey(v.key), value: v.value })) })),
      params, charts, tiles,
      chat: prev?.chat || [], pending: prev?.pending || [], locked: prev?.locked || [],
    });
    loops.at(-1).health = health(loops.at(-1));
  }
  // A loop the audit no longer names keeps its unlocked work, marked as retired.
  for (const l of st.loops) if (!loops.some((x) => x.id === l.id) && (l.pending?.length || l.params.some((p) => p.value !== p.base))) loops.push({ ...l, retired: true });
  for (const l of loops) { l.feeds = idOf.get(l.feeds) || l.feeds; if (l.feeds && !loops.some((x) => x.id === l.feeds)) l.feeds = ''; }

  // Where the work went.
  const ids = new Set(loops.map((l) => l.id));
  const title = new Map((meta.recent || []).map((t) => [t.num, t]));
  const byLoop = (out.focus?.byLoop || []).map((b) => ({ ...b, loopId: idOf.get(b.loopId) || loopFor({ loops }, b.loopId)?.id || b.loopId })).filter((b) => ids.has(b.loopId)).map((b) => ({ loopId: b.loopId, nums: [...new Set(b.nums)].filter((n) => title.has(n)) }));
  const support = [...new Set(out.focus?.support || [])].filter((n) => title.has(n));
  const off = (out.focus?.off || []).filter((o) => title.has(o.num)).map((o) => ({ num: o.num, why: clip(o.why, 200), title: title.get(o.num).title, status: title.get(o.num).status }));
  const onCount = new Set(byLoop.flatMap((b) => b.nums)).size;
  const coreIds = new Set(loops.filter((l) => l.core).map((l) => l.id));
  const coreCount = new Set(byLoop.filter((b) => coreIds.has(b.loopId)).flatMap((b) => b.nums)).size;
  const judged = onCount + off.length;
  const focus = { byLoop, support, off, onLoop: judged ? Math.round((onCount / judged) * 100) : null, core: judged ? Math.round((coreCount / judged) * 100) : null, tickets: title.size };

  const coherence = cleanCoherence(out.coherence, (ref) => idOf.get(ref) || loopFor({ loops }, ref)?.id || '');
  const actions = cleanActions(out.actions, loops, (ref) => idOf.get(ref) || loopFor({ loops }, ref)?.id || '');
  Object.assign(st, { loops, focus, coherence, actions, summary: out.summary, core: out.core, lastRunAt: at, status: 'done', model: st.model, lastModel: meta.model, account: meta.account, commit: meta.commit });
  st.history = [...(st.history || []), { at, onLoop: focus.onLoop, core: focus.core, health: Object.fromEntries(loops.filter((l) => !l.retired).map((l) => [l.id, l.health])), names: Object.fromEntries(loops.map((l) => [l.id, l.name])) }].slice(-60);
  orch.feedPost(game.id, { kind: 'system', from: 'Gameplay Loop', text: feedText(st, { scheduled: meta.scheduled, model: meta.model }) });
}

const VERDICT = { coherent: 'The loop holds together', strained: 'The loop is strained', broken: 'The loop is broken' };
const PRIORITY = { now: 'Now', next: 'Next', later: 'Later' };
const KIND = { playtest: 'Play it', tune: 'Tune', design: 'Design', park: 'Park' };

function cleanCoherence(c, idFor) {
  if (!c?.verdict) return null;
  return {
    verdict: ['coherent', 'strained', 'broken'].includes(c.verdict) ? c.verdict : 'strained',
    headline: clip(c.headline, 300), chain: clip(c.chain, 400), changes: clip(c.changes, 400),
    breaks: (c.breaks || []).slice(0, 4).map((b) => ({ loopId: idFor(b.loopId), problem: clip(b.problem, 300), fix: clip(b.fix, 300) })),
  };
}

function cleanActions(list, loops, idFor) {
  const order = { now: 0, next: 1, later: 2 };
  return (list || []).slice(0, 6).map((a) => {
    const loopId = idFor(a.loopId);
    const names = loops.find((l) => l.id === loopId)?.params.map((p) => p.key) || [];
    return {
      id: uid('act'), priority: order[a.priority] != null ? a.priority : 'next', kind: KIND[a.kind] ? a.kind : 'design',
      title: clip(a.title, 120), why: clip(a.why, 300), loopId,
      values: (a.values || []).filter((v) => names.includes(cleanKey(v.key)) && Number.isFinite(v.value)).map((v) => ({ key: cleanKey(v.key), value: v.value })),
    };
  }).sort((a, b) => order[a.priority] - order[b.priority]);
}

function feedText(st, { scheduled, model, rewrite } = {}) {
  const c = st.coherence;
  const live = st.loops.filter((l) => !l.retired);
  return [
    `Gameplay loop ${rewrite ? 'audit, rewritten for reading' : `audit${scheduled ? ' (scheduled)' : ''}`}${model ? ` (${model})` : ''}: ${c ? `${VERDICT[c.verdict]}. ${c.headline}` : st.summary}`,
    c?.chain ? `\nThe loop today: ${c.chain}` : '',
    st.actions?.length ? `\nWhat to do:\n${st.actions.map((a, i) => `${i + 1}. [${PRIORITY[a.priority]}] ${a.title}: ${a.why}`).join('\n')}` : '',
    `\nLoops: ${live.map((l) => `${l.name} ${l.health}%`).join(' · ')}. Details, sliders and Lock In are on the Gameplay Loop tab.`,
  ].filter(Boolean).join('\n');
}

// Older audits (or long ones) rewritten into the verdict and ranked actions, from what the audit
// already found: no code reading, so it's quick.
const DIGEST_SCHEMA = { type: 'object', required: ['summary', 'coherence', 'actions'], properties: { summary: AUDIT_SCHEMA.properties.summary, coherence: COHERENCE, actions: ACTIONS } };

export async function digest(gameId) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const st = state(game);
  must(st.loops.length, 'Audit the loops first.');
  must(!running.audit.has(game.id), 'An audit is running.', 409);
  const acct = must(account(), 'No logged-in account has usage free right now.');
  const live = st.loops.filter((l) => !l.retired);
  const facts = live.map((l) => `Loop id "${l.id}": ${l.name} [${l.scale}${l.core ? ', core' : ''}] health ${l.health}%. Skill: ${l.skill}. Question: ${l.question}. Feeds: ${l.feeds || 'nothing'}.
  Stage tests: ${l.stages.map((x) => `${x.stage} ${x.score}/3 (${x.basis}): ${x.finding}${x.fix ? ` Fix: ${x.fix}` : ''}`).join(' | ')}
  Playtests and reviews: ${(l.playtest || []).map((p) => `${p.source}: ${p.says} → ${p.interpretation}`).join(' | ') || 'none'}
  Suggested iterations: ${(l.iterate || []).map((x) => `${x.title} (${x.why})${x.values?.length ? ` [sliders: ${x.values.map((v) => `${v.key}=${v.value}`).join(', ')}]` : ''}`).join(' | ') || 'none'}
  Sliders: ${l.params.map((p) => `${p.key} = ${p.base}`).join(', ') || 'none'}`).join('\n');
  const { result } = await claude.runQuick({
    account: acct,
    args: ['--model', db.settings.reportModel || 'sonnet', '--tools', 'Read', '--permission-mode', 'dontAsk', '--json-schema', JSON.stringify(DIGEST_SCHEMA)],
    prompt: `The director of "${game.name}" found this gameplay loop audit hard to read. Rewrite its findings into a verdict and a short ranked action list. Don't add findings it doesn't support.

The question is whether the design is coherent and delivers a compelling, repeatable loop. Mechanics change as the director tests them: that's expected, not drift. Drift is the design no longer holding together. Short plain sentences.

${FRAMEWORK}

The audit's summary: ${st.summary}
Core: ${st.core ? `skill: ${st.core.skill}; skill curve: ${st.core.skillCurve}; retention: ${st.core.retention}; drift: ${st.core.drift}` : 'none'}
Work sorted by loop: ${st.focus ? `${st.focus.onLoop}% of non-groundwork tickets on a loop; ${st.focus.support.length} groundwork; serving no loop: ${st.focus.off.map((o) => `#${o.num} ${o.title} (${o.why})`).join('; ') || 'none'}` : 'not sorted'}

${facts}`,
  });
  if (result) recordUsage({ account: acct, gameId: game.id, kind: 'loop-digest', result });
  const out = must(result?.structured_output?.coherence && result.structured_output, clip(result?.result, 300) || 'Nothing came back.');
  const idFor = (ref) => loopFor(st, ref)?.id || '';
  Object.assign(st, { summary: out.summary, coherence: cleanCoherence(out.coherence, idFor), actions: cleanActions(out.actions, st.loops, idFor) });
  save(); emit(game.id); changed();
  orch.feedPost(game.id, { kind: 'system', from: 'Gameplay Loop', text: feedText(st, { rewrite: true }) });
  return publicState(game);
}

// An action from the list: queued to lock in, marked done (a playtest the director ran), or set aside.
export function act(gameId, actionId, what) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const st = state(game);
  const a = must((st.actions || []).find((x) => x.id === actionId), 'Unknown action', 404);
  if (what === 'adopt') {
    const loop = must(st.loops.find((l) => l.id === a.loopId) || st.loops.find((l) => l.core && !l.retired) || st.loops[0], 'No loop to add it to.');
    (loop.pending ||= []).push({ id: uid('chg'), text: `${a.title}: ${a.why}`, from: 'action', at: Date.now(), actionId: a.id });
    a.state = 'queued';
  } else if (what === 'done' || what === 'dismiss') a.state = what === 'done' ? 'done' : 'dismissed';
  else if (what === 'restore') {
    delete a.state;
    for (const l of st.loops) l.pending = (l.pending || []).filter((n) => n.actionId !== a.id);
  } else must(false, 'Unknown step');
  a.at = Date.now();
  save(); emit(game.id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Tuning

function loopOf(game, loopId) { return must(state(game).loops.find((l) => l.id === loopId), 'Unknown loop', 404); }

export function setValues(gameId, loopId, { values = {}, reset = false } = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const loop = loopOf(game, loopId);
  for (const p of loop.params) {
    if (reset) { p.value = p.base; continue; }
    if (!(p.key in values)) continue;
    const v = Number(values[p.key]);
    if (Number.isFinite(v)) p.value = Math.min(p.max, Math.max(p.min, v));
  }
  save();
  emit(game.id);
  return { ok: true };
}

export function addNote(gameId, loopId, text, from = 'director') {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const loop = loopOf(game, loopId);
  text = String(text || '').trim();
  must(text, 'Write the change first.');
  (loop.pending ||= []).push({ id: uid('chg'), text: text.slice(0, 1500), from, at: Date.now() });
  save(); emit(game.id);
  return { ok: true };
}

export function dropNote(gameId, loopId, noteId) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const loop = loopOf(game, loopId);
  loop.pending = (loop.pending || []).filter((n) => n.id !== noteId);
  save(); emit(game.id);
  return { ok: true };
}

export function removeChart(gameId, loopId, chartId) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const loop = loopOf(game, loopId);
  loop.charts = loop.charts.filter((c) => c.id !== chartId);
  loop.tiles = (loop.tiles || []).filter((t) => t.id !== chartId);
  save(); emit(game.id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Asking one loop

export function ask(gameId, loopId, text) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const loop = loopOf(game, loopId);
  text = String(text || '').trim();
  must(text, 'Ask something first.');
  const key = `${game.id}:${loop.id}`;
  must(!running.chat.has(key), 'Still answering the last question on this loop.', 409);
  const q = { id: uid('m'), role: 'director', text: text.slice(0, 4000), at: Date.now() };
  const a = { id: uid('m'), role: 'claude', text: '', at: Date.now(), status: 'thinking' };
  loop.chat = [...(loop.chat || []), q, a].slice(-40);
  running.chat.add(key);
  save(); emit(game.id);
  answer(game, loop, q, a).catch((err) => Object.assign(a, { status: 'error', text: err.message })).finally(() => {
    running.chat.delete(key);
    if (a.status === 'thinking') a.status = 'done';
    a.at = Date.now();
    save(); emit(game.id);
  });
  return { ok: true };
}

async function answer(game, loop, q, a) {
  if (game.runner === 'cloud' && game.repoPath) await git.syncClone(game.repoPath, game.baseBranch).catch(() => {});
  const st = state(game);
  const acct = must(account(), 'No logged-in account has usage free right now.');
  const ev = evidence(game);
  const history = loop.chat.filter((m) => m !== q && m !== a && m.text).slice(-12).map((m) => `${m.role === 'director' ? 'Director' : 'You'}: ${clip(m.text, 1200)}`).join('\n');
  const prompt = `${game.subdir ? `This game's own folder is ${game.subdir}/; the apps that load it are elsewhere in this repo.\n\n` : ''}The director of "${game.name}" is asking about one of its gameplay loops, on the Gameplay Loop tab. Answer from the code, the GDD and the evidence, and give them what makes the answer usable: when a number, curve or comparison would help, add the slider(s) for the parameters involved (read from the code, with file:line) and a graph whose formula shows it, so they can tune it and watch it move. Update or replace a graph by its id when that's clearer than adding one. Move sliders only when they ask for a change or a scenario. Keep to this loop's skill and the game's core curves; if the question pulls away from them, say so.

${FRAMEWORK}

${MODEL_RULES}
Formulas may use this loop's parameter keys (including any you add now) and x.

The game's core: ${st.core ? `skill: ${st.core.skill}; skill curve: ${st.core.skillCurve}; retention: ${st.core.retention}` : '(not audited yet)'}
Other loops: ${st.loops.filter((l) => l.id !== loop.id).map((l) => `${l.id} ${l.name} [${l.scale}]`).join(', ') || '(none)'}

This loop:
${loopText(loop)}
  stages: ${(loop.stages || []).map((s) => `${s.stage} ${s.score}/3: ${clip(s.finding, 200)}`).join(' | ')}

GDD: ${gdd.gddDirOf(game)}
${evidenceText(ev)}
${history ? `The conversation so far:\n${history}\n\n` : ''}The director asks: ${q.text}
${jungledocs.forRun(game).text}`;
  const { result } = await claude.runQuick({
    account: acct,
    cwd: game.repoPath,
    args: ['--model', db.settings.loopChatModel || 'sonnet', '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', '--add-dir', gdd.gddDirOf(game), ...jungledocs.forRun(game).args, '--json-schema', JSON.stringify(CHAT_SCHEMA)],
    prompt,
  });
  if (result) recordUsage({ account: acct, gameId: game.id, kind: 'loop-chat', result });
  const out = result?.structured_output;
  must(out?.reply, clip(result?.result, 300) || 'No answer came back.');
  const did = [];
  for (const p of out.params || []) {
    const np = cleanParam(p, 'chat');
    if (!np) continue;
    const was = loop.params.find((x) => x.key === np.key);
    if (was) { Object.assign(was, { label: np.label, min: Math.min(np.min, was.min), max: Math.max(np.max, was.max), step: np.step, unit: np.unit || was.unit, source: np.source || was.source, affects: np.affects || was.affects }); did.push(`updated the ${np.label} slider`); }
    else { loop.params.push(np); did.push(`added a ${np.label} slider`); }
  }
  const names = loop.params.map((p) => p.key);
  const rm = new Set((out.removeCharts || []).map(cleanKey));
  if (rm.size) { loop.charts = loop.charts.filter((c) => !rm.has(c.id)); did.push(`removed ${rm.size} graph${rm.size > 1 ? 's' : ''}`); }
  for (const c of out.charts || []) {
    const nc = cleanChart(c, names, 'chat');
    if (!nc) continue;
    const i = loop.charts.findIndex((x) => x.id === nc.id);
    if (i >= 0) { loop.charts[i] = { ...nc, origin: loop.charts[i].origin }; did.push(`updated "${nc.title}"`); } else { loop.charts.push(nc); did.push(`added "${nc.title}"`); }
  }
  for (const t of out.tiles || []) {
    const nt = cleanTile(t, names, 'chat');
    if (!nt) continue;
    loop.tiles ||= [];
    const i = loop.tiles.findIndex((x) => x.id === nt.id);
    if (i >= 0) loop.tiles[i] = nt; else loop.tiles.push(nt);
    did.push(`${i >= 0 ? 'updated' : 'added'} the ${nt.label} number`);
  }
  const moved = [];
  for (const s of out.set || []) {
    const p = loop.params.find((x) => x.key === cleanKey(s.key));
    if (p && Number.isFinite(s.value)) { p.value = Math.min(p.max, Math.max(p.min, s.value)); moved.push(`${p.label} → ${p.value}${p.unit ? ` ${p.unit}` : ''}`); }
  }
  if (moved.length) did.push(`moved ${moved.join(', ')}`);
  if (out.change?.trim()) { (loop.pending ||= []).push({ id: uid('chg'), text: out.change.trim().slice(0, 1500), from: 'chat', at: Date.now() }); did.push('added a change to lock in'); }
  Object.assign(a, { text: out.reply, did, status: 'done' });
}

// ---------------------------------------------------------------------------
// Lock In Changes: the director's tuning and decisions become board tasks.

export function pendingOf(game) {
  return state(game).loops.map((l) => ({
    loop: l,
    params: l.params.filter((p) => p.value !== p.base && !(p.locked && p.locked.value === p.value)),
    notes: l.pending || [],
  })).filter((x) => x.params.length || x.notes.length);
}

export function lockIn(gameId) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const st = state(game);
  must(!running.lock.has(game.id), 'Already locking in.', 409);
  const pending = pendingOf(game);
  must(pending.length, 'Nothing to lock in: move a slider or add a change first.');
  running.lock.add(game.id);
  Object.assign(st, { lock: { status: 'running', startedAt: Date.now() } });
  save(); emit(game.id);
  lock(game, pending).catch((err) => { st.lock = { status: 'error', error: err.message, at: Date.now() }; }).finally(() => {
    running.lock.delete(game.id);
    save(); emit(game.id); changed();
  });
  return { ok: true };
}

async function lock(game, pending) {
  const st = state(game);
  const acct = must(account(), 'No logged-in account has usage free right now.');
  const vars = (l, which) => LM.scope(l.params, which);
  const body = pending.map(({ loop, params, notes }) => {
    const tiles = (loop.tiles || []).map((t) => { const b = LM.value(t.expr, vars(loop, 'base')); const d = LM.value(t.expr, vars(loop, 'draft')); return b !== d ? `${t.label}: ${fmt(b)} → ${fmt(d)}${t.unit ? ` ${t.unit}` : ''}` : null; }).filter(Boolean);
    const chat = (loop.chat || []).filter((m) => m.text && m.at > (st.lockedAt || 0)).slice(-10).map((m) => `${m.role === 'director' ? 'Director' : 'Claude'}: ${clip(m.text, 700)}`);
    return `Loop id "${loop.id}" (${loop.name}) [${loop.scale}${loop.core ? ', core' : ''}], skill: ${loop.skill}; question: ${loop.question}
${params.length ? `Tuning (code → director's value):\n${params.map((p) => `- ${p.label} (${p.key}): ${p.base} → ${p.value}${p.unit ? ` ${p.unit}` : ''}, at ${p.source || 'unknown location'}. ${p.affects || ''}`).join('\n')}` : ''}
${tiles.length ? `What the model says this does: ${tiles.join('; ')}` : ''}
${notes.length ? `Decided changes:\n${notes.map((n) => `- ${n.text}`).join('\n')}` : ''}
${chat.length ? `The discussion behind it:\n${chat.join('\n')}` : ''}`;
  }).join('\n\n');
  const { result } = await claude.runQuick({
    account: acct,
    cwd: game.repoPath,
    args: ['--model', db.settings.reportModel || 'sonnet', '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', '--json-schema', JSON.stringify(LOCK_SCHEMA)],
    prompt: `${game.subdir ? `This game's own folder is ${game.subdir}/.\n\n` : ''}The director of "${game.name}" tuned its gameplay loops on the Gameplay Loop tab and pressed "Lock In Changes". Turn what they changed and decided into board tasks for the team. Interpret it: say what the change does for the player in terms of the loop's skill, how open the answer stays, the feedback dose, pacing and the retention curve, so the agent doing it knows what to protect. Group parameters that live in one system into one task; give each decided change its own task. Each task names the files and values (from → to), and how to check it in a playtest (what a player should notice, which near-wins or failures to watch). Check the code where a location is missing. At most 10 tasks.

${body}`,
  });
  if (result) recordUsage({ account: acct, gameId: game.id, kind: 'loop-lock', result });
  const out = result?.structured_output;
  must(out?.tasks?.length, clip(result?.result, 300) || 'No tasks came back.');
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const titles = new Set(db.tasks.filter((t) => t.gameId === game.id && t.status !== 'done').map((t) => norm(t.title)));
  const added = [];
  for (const t of out.tasks) {
    if (!t.title?.trim() || titles.has(norm(t.title))) continue;
    titles.add(norm(t.title));
    const loop = loopFor(st, t.loopId);
    t.loopId = loop?.id || t.loopId;
    const task = orch.addTask(game.id, { title: t.title.trim().slice(0, 200), detail: `${t.detail}\n\nFrom the Gameplay Loop tab${loop ? ` (${loop.name}, ${loop.scale} loop)` : ''}: locked in by the director.`, createdBy: 'Gameplay Loop' });
    added.push({ num: task.num, title: task.title, loopId: t.loopId });
  }
  const at = Date.now();
  for (const { loop, params, notes } of pending) {
    const nums = added.filter((x) => x.loopId === loop.id).map((x) => x.num);
    for (const p of params) p.locked = { value: p.value, at, tasks: nums };
    (loop.locked ||= []).push(...notes.map((n) => ({ ...n, lockedAt: at, tasks: nums })));
    for (const n of notes) { const a = (st.actions || []).find((y) => y.id === n.actionId); if (a) Object.assign(a, { state: 'locked', tasks: nums, at }); }
    loop.locked = loop.locked.slice(-30);
    loop.pending = [];
  }
  st.lockedAt = at;
  st.lock = { status: 'done', at, summary: out.summary, tasks: added };
  orch.feedPost(game.id, { kind: 'task', from: 'Gameplay Loop', text: `Locked in loop changes: ${out.summary}\nAdded ${added.map((x) => `#${x.num}`).join(', ') || 'nothing new (already on the board)'}.` });
}

// Claude sometimes decorates an id ("loop-swing" for "swing") or gives the name.
function loopFor(st, ref) {
  const k = slug(ref);
  return st.loops.find((l) => l.id === ref) || st.loops.find((l) => l.id === k || slug(l.name) === k) || st.loops.find((l) => k.endsWith(`-${l.id}`) || k.startsWith(`${l.id}-`)) || null;
}

const fmt = (v) => (v == null ? '–' : Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100);

// ---------------------------------------------------------------------------
// For triage: the loops, so new tickets say when they feed none of them.

export function triageNote(game) {
  const st = db.gameLoops?.[game.id];
  const live = st?.loops?.filter((l) => !l.retired) || [];
  if (!live.length) return '';
  return `\nThe game's gameplay loops (from the director's Gameplay Loop tab): ${live.map((l) => `${l.name} [${l.scale}${l.core ? ', core' : ''}]: ${l.skill}`).join('; ')}.${st.core?.skillCurve ? ` Core skill curve: ${st.core.skillCurve}` : ''} Mechanics changing as the director tests them is expected. When a task adds a system or content that feeds none of these loops and isn't groundwork (builds, crashes, performance, platform), end its detail with "Off-loop: <which loop it could feed, or why it's still worth doing>", so the director can keep the design coherent.\n`;
}

// ---------------------------------------------------------------------------
// Schedule and state for the UI

export function configure(gameId, body = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const st = state(game);
  if (body.every !== undefined) st.every = gdd.SCHEDULES[body.every] ? body.every : 'off';
  if (body.at !== undefined) st.at = must(/^([01]?\d|2[0-3]):([0-5]\d)$/.test(String(body.at)) && String(body.at).padStart(5, '0'), 'Times look like 09:00.');
  if (body.day !== undefined) st.day = Math.min(6, Math.max(0, Number(body.day) || 0));
  if (body.model !== undefined) st.model = ['', 'opus', 'sonnet', 'fable'].includes(body.model) ? body.model : '';
  st.nextAt = gdd.nextRun(st);
  save(); emit(game.id);
  return publicState(game);
}

export function publicState(game) {
  const st = state(game);
  return {
    ...st,
    running: running.audit.has(game.id),
    asking: st.loops.filter((l) => running.chat.has(`${game.id}:${l.id}`)).map((l) => l.id),
    pending: pendingOf(game).map((x) => ({ loopId: x.loop.id, params: x.params.length, notes: x.notes.length })),
    stages: STAGES, scales: SCALES, schedules: gdd.SCHEDULES, defaultModel: db.settings.auditModel || 'opus',
    tasks: Object.fromEntries(db.tasks.filter((t) => t.gameId === game.id && (t.createdBy === 'Gameplay Loop' || (st.focus?.off || []).some((o) => o.num === t.num))).map((t) => [t.num, { status: t.status, title: t.title }])),
  };
}

export function init() {
  for (const st of Object.values(db.gameLoops || {})) {
    if (st.status === 'running') Object.assign(st, { status: 'error', error: 'Ballast restarted during the audit. Run it again.' });
    if (st.lock?.status === 'running') st.lock = { status: 'error', error: 'Ballast restarted while locking in. Press Lock In Changes again.' };
    for (const l of st.loops || []) for (const m of l.chat || []) if (m.status === 'thinking') Object.assign(m, { status: 'error', text: 'Ballast restarted before this was answered. Ask again.' });
  }
  setInterval(() => {
    for (const game of db.games) {
      const st = db.gameLoops?.[game.id];
      if (!st || st.every === 'off' || !st.nextAt || Date.now() < st.nextAt || running.audit.has(game.id)) continue;
      if ((game.status || 'active') !== 'active') { st.nextAt = gdd.nextRun(st); continue; }
      try { startAudit(game.id, { scheduled: true }); } catch (err) { st.nextAt = gdd.nextRun(st); st.error = err.message; }
    }
  }, 60e3).unref();
}
