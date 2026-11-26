// Level audit (Roadmap tab): an honest, evidence-based reading of where each feature really is,
// L0-L3, from the latest GDD, the repo as a player would meet it, and the director's own verdicts.
//
// The roadmap's own level is a starting estimate raised whenever a level's tickets are all done, and
// agents close their own tickets, so it drifts upward (a week-old game with every feature at "Ship").
// The audit sets each feature's level from evidence and may lower it. Tickets done before the audit no
// longer count toward levels; only work done after it does, until the next audit checks that too.
import path from 'node:path';
import { db, save } from './store.mjs';
import { changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import * as roadmap from './roadmap.mjs';
import * as gdd from './gddreview.mjs';
import * as perf from './perf.mjs';
import * as pace from './pace.mjs';
import * as jungledocs from './jungledocs.mjs';
import * as gates from './gates.mjs';
import { recordUsage } from './usage.mjs';

const must = (v, msg, status = 400) => { if (!v) throw Object.assign(new Error(msg), { status }); return v; };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };

const SCHEMA = {
  type: 'object',
  required: ['summary', 'features'],
  properties: {
    summary: { type: 'string', description: 'Three or four sentences for the director: where the game really is, plainly.' },
    features: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'level', 'confidence', 'evidence', 'missing', 'next'],
        properties: {
          id: { type: 'string', description: 'The feature id given in the list.' },
          level: { type: 'integer', minimum: -1, maximum: 3, description: 'Highest level fully met, by the rules. -1 if a player cannot do it at all yet.' },
          confidence: { enum: ['high', 'medium', 'low'] },
          evidence: { type: 'array', items: { type: 'string' }, description: '2-6 short facts with file paths: what is wired into the game a player runs, what only exists in rules, tests or debug tools, and what the director said.' },
          missing: { type: 'string', description: 'What stops the next level, in one or two sentences.' },
          next: {
            type: 'array', maxItems: 4,
            description: 'Board-sized tasks that take it to the next level. Empty at L3.',
            items: { type: 'object', required: ['title', 'detail'], properties: { title: { type: 'string', description: 'Starts with the department tag, e.g. "[gameplay] …".' }, detail: { type: 'string', description: 'What to do and how to check it by playing.' } } },
          },
        },
      },
    },
  },
};

const RULES = `Levels, met only with evidence (round down when unsure):
- L0 Greybox: a player can do it in the game they run (the real client, reached through normal play). Placeholder art and rough logic are fine. Code that only exists in shared rules, tests, tools, a debug menu or an unregistered module is not L0: that feature is -1.
- L1 Functional: works end to end in the real game with its real rules (in multiplayer when the feature is multiplayer), reached without debug steps, with no open bug or blocked ticket that breaks it.
- L2 Polished: tuned and feels good, with target-quality art and audio. This needs the director's evidence: an approved review or a positive playtest note about it. A review sent back, a "changes to #…" ticket, or a playtest note criticising it means it is not L2. Art made from code or primitives, or placeholder sounds, is not target quality unless the director approved it.
- L3 Ship: within the performance budgets on the target headset (profiler runs), edge cases and accessibility handled, final content, nothing open against it.
Tickets marked done are not evidence on their own: agents close their own tickets. Check the code. Judge each feature on its own; don't let one feature's polish lift another.`;

function evidence(game) {
  const tasks = db.tasks.filter((t) => t.gameId === game.id);
  const byNum = new Map(tasks.map((t) => [t.num, t]));
  const director = orch.directorName();
  // The director's verdicts: review send-backs ("Changes to #N"), with their words.
  const reviews = tasks.filter((t) => t.createdBy === 'Director review' || /^changes to #\d+/i.test(t.title)).map((t) => {
    const of = byNum.get(Number(t.title.match(/#(\d+)/)?.[1]));
    return { featureId: of?.featureId || null, line: `#${t.num} ${t.title} [${t.status}]: ${clip(t.detail, 500)}` };
  });
  const notes = orch.readFeed(game.id, 3000).filter((e) => e.kind === 'note' && (e.from === director || ['director', 'review', 'review-session', 'playtest'].includes(e.source))).slice(-25)
    .map((e) => `note #${e.num || '?'} (${new Date(e.ts || e.at || 0).toLocaleDateString()}): ${clip(e.text, 600)}`);
  let perfLine = '';
  try {
    const runs = perf.runs(game.id).filter((r) => !r.hidden);
    const last = runs[runs.length - 1];
    if (last) perfLine = `Latest profiler run (${new Date(last.at).toLocaleDateString()}${last.noteNum ? `, note #${last.noteNum}` : ''}): ${last.budgets.map((b) => `${b.name} ${b.value}${b.unit && !['max', 'mean'].includes(b.unit) ? b.unit : ''} ${b.pass ? 'within' : 'OVER'} budget ${b.limit ?? '?'}`).join('; ')}`;
  } catch { /* no runs */ }
  return { tasks, reviews, notes, perfLine };
}

function prompt(game, { files, commit, ev }) {
  const rm = game.roadmap;
  const feats = rm.features.map((f) => {
    const mine = ev.tasks.filter((t) => t.featureId === f.id);
    const said = roadmap.levelOf(game, f);
    const lines = mine.slice(-12).map((t) => `    #${t.num} L${t.level} [${t.status}${t.review?.state && t.review.state !== 'skipped' ? `, review ${t.review.state}` : ''}] ${t.title}${t.summary ? ` (agent's report: ${clip(t.summary, 160)})` : ''}`);
    const rv = ev.reviews.filter((r) => r.featureId === f.id).map((r) => `    director: ${r.line}`);
    return `- id ${f.id}: ${f.name} [${f.area}${f.core ? ', core' : ''}]. The roadmap says L${said}.\n  ${clip(f.summary, 240)}${f.gdd ? ` (GDD: ${f.gdd})` : ''}\n  Done means: ${[0, 1, 2, 3].map((n) => `L${n}: ${clip(f.levels[n]?.done, 160)}`).join(' | ')}${lines.length ? `\n  Tickets:\n${lines.join('\n')}` : ''}${rv.length ? `\n${rv.join('\n')}` : ''}`;
  }).join('\n');
  const unmatched = ev.reviews.filter((r) => !r.featureId).slice(-15).map((r) => `- ${r.line}`).join('\n');
  return `Audit "${game.name}" honestly: for each feature below, the highest quality level it really meets today. The director finds the roadmap says L2 or L3 for things they'd call L0, so the roadmap's own number counts for nothing here.

${RULES}

You are in the game's folder${commit ? ` (repo at ${commit})` : ''}. Read the GDD (plain text):
${files.map((f) => `- ${f}`).join('\n') || '(no GDD found: use the "done means" lines below)'}

Then read the code for each feature: find where it is wired into the client and server a player runs (entry points, registration, the scene or world that loads it), not just where its logic lives.

The director's notes and playtest feedback (newest last):
${ev.notes.join('\n') || '(none)'}
${unmatched ? `\nOther review send-backs:\n${unmatched}\n` : ''}${ev.perfLine ? `\n${ev.perfLine}\n` : ''}
Features:
${feats}

For every feature, give its id, the level, your confidence, the evidence (with file paths), what's missing for the next level, and up to 4 board-sized tasks that would get it there.`;
}

const running = new Set();

export function start(gameId, { model } = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const rm = must(game.roadmap?.features?.length && game.roadmap, 'Break down the GDD on the Roadmap tab first.');
  const a = (rm.audit ||= {});
  if (running.has(game.id)) return a;
  running.add(game.id);
  Object.assign(a, { status: 'running', startedAt: Date.now(), error: null, model: model || db.settings.auditModel || 'opus' });
  save();
  changed();
  run(game).catch((err) => Object.assign(a, { status: 'error', error: err.message })).finally(() => {
    running.delete(game.id);
    if (a.status === 'running') a.status = 'done';
    save();
    changed();
  });
  return a;
}

async function run(game) {
  const rm = game.roadmap;
  const a = rm.audit;
  const { files, commit } = await gdd.pullLatest(game);
  const ev = evidence(game);
  const acct = db.accounts.filter((x) => x.loggedIn && !(x.limitedUntil > Date.now()) && orch.utilization(x) * 100 < (db.settings.limitGuardPct || 95)).sort(pace.compareAccounts)[0];
  must(acct, 'No logged-in account has usage free right now.');
  const root = game.subdir ? path.join(game.repoPath, game.subdir) : game.repoPath;
  const { result } = await claude.runQuick({
    account: acct,
    cwd: game.subdir ? game.repoPath : root, // the whole repo: client and server apps live outside a game's folder
    args: ['--model', a.model, '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', '--add-dir', gdd.gddDirOf(game), ...jungledocs.forRun(game).args, '--json-schema', JSON.stringify(SCHEMA)],
    prompt: `${game.subdir ? `This game's own folder is ${game.subdir}/; the apps that load it are elsewhere in this repo.\n\n` : ''}${prompt(game, { files, commit, ev })}${jungledocs.forRun(game).text}`,
  });
  if (result) recordUsage({ account: acct, gameId: game.id, kind: 'level-audit', result });
  const out = result?.structured_output;
  must(out?.features?.length, result?.result?.slice(0, 300) || 'The audit returned nothing.');
  apply(game, out, { model: a.model, account: acct.name, commit });
}

export function apply(game, out, meta) {
  const rm = game.roadmap;
  const at = Date.now();
  const before = new Map(rm.features.map((f) => [f.id, roadmap.levelOf(game, f)]));
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const titles = new Set(db.tasks.filter((t) => t.gameId === game.id && t.status !== 'done').map((t) => norm(t.title)));
  // 1. Every feature's verified level.
  const rows = [];
  for (const r of out.features) {
    const f = rm.features.find((x) => x.id === r.id);
    if (!f) continue;
    const level = Math.max(-1, Math.min(3, r.level));
    f.base = level;
    f.verified = { level, at, by: 'audit', confidence: r.confidence, evidence: (r.evidence || []).slice(0, 8), missing: r.missing || '', said: before.get(f.id) };
    rows.push({ f, r, name: f.name, said: before.get(f.id), level, confidence: r.confidence });
  }
  // 2. A milestone counted as reached on inflated levels opens again, so the current one is real.
  const reopened = [];
  for (const m of rm.milestones || []) {
    if (m.reachedAt && !rm.features.every((f) => roadmap.levelOf(game, f) >= roadmap.targetOf(m, f))) { delete m.reachedAt; reopened.push(m.name); }
  }
  // 3. Gaps become tickets only up to the current milestone's target, so the board isn't flooded.
  const ms = roadmap.active(game);
  let added = 0;
  for (const { f, r, level } of rows) {
    const next = level + 1;
    if (next > 3 || next > gates.capOf(game, f)) continue; // up to the section's gate (or the milestone, gates off)
    for (const t of (r.next || []).slice(0, 4)) {
      if (!t.title?.trim() || titles.has(norm(t.title))) continue;
      titles.add(norm(t.title));
      orch.addTask(game.id, {
        title: /^\s*\[/.test(t.title) ? t.title.trim() : `[${f.area}] ${t.title.trim()}`,
        detail: `${t.detail}\n\nFeature: ${f.name}, verified at ${level < 0 ? 'not started' : `L${level}`} by the level audit; this takes it to L${next} ${roadmap.LEVELS[next].name}. Done at L${next} means: ${f.levels[next]?.done || roadmap.LEVELS[next].text}`,
        createdBy: 'Level audit',
        featureId: f.id,
        level: next,
      });
      added++;
    }
  }
  const lowered = rows.filter((x) => x.level < x.said);
  const raised = rows.filter((x) => x.level > x.said);
  const count = (key) => [-1, 0, 1, 2, 3].map((n) => [n, rows.filter((x) => x[key] === n).length]).filter(([, c]) => c).map(([n, c]) => `${c}× ${n < 0 ? 'not started' : `L${n}`}`).join(', ');
  rm.audit = { ...rm.audit, ...meta, status: 'done', at, summary: out.summary, lowered: lowered.length, raised: raised.length, added, reopened, milestone: ms?.name || null, said: count('said'), verified: count('level') };
  roadmap.tick(game);
  orch.feedPost(game.id, {
    kind: 'system',
    from: 'Level audit',
    text: [
      `Level audit (${meta.model}): ${out.summary}`,
      `\nThe roadmap said: ${rm.audit.said}\nVerified: ${rm.audit.verified}`,
      lowered.length ? `\nLowered:\n${lowered.sort((a, b) => (b.said - b.level) - (a.said - a.level)).map((x) => `- ${x.name}: L${x.said} → ${x.level < 0 ? 'not started' : `L${x.level}`}`).join('\n')}` : '',
      raised.length ? `\nRaised:\n${raised.map((x) => `- ${x.name}: L${x.said} → L${x.level}`).join('\n')}` : '',
      added ? `\nAdded ${added} ticket${added > 1 ? 's' : ''} for what's missing up to ${ms?.name || 'the current milestone'}.` : '',
      reopened.length ? `\nReopened: ${reopened.join(', ')} (it was only reached on the old levels).` : '',
    ].filter(Boolean).join('\n'),
  });
}

export function init() {
  for (const g of db.games) if (g.roadmap?.audit?.status === 'running') Object.assign(g.roadmap.audit, { status: 'error', error: 'Ballast restarted during the audit. Run it again.' });
}
