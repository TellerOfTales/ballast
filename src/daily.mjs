// The director's daily update, posted in each game's Feed at the time set in Settings: what got done,
// what to check, what's still in progress and how the player experience changes, in plain words. A
// quiet day gets a one-line note without a Claude run. While the director is away (away.mjs) the
// updates keep coming, Ballast keeps each board stocked with review-free improvement work, and the
// first update after they're back covers the whole time away.
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { db, save } from './store.mjs';
import { changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import * as pace from './pace.mjs';
import * as perf from './perf.mjs';
import * as away from './away.mjs';
import * as jungledocs from './jungledocs.mjs';
import { recordUsage } from './usage.mjs';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const must = (v, msg, status = 400) => { if (!v) throw Object.assign(new Error(msg), { status }); return v; };
const strip = (title) => String(title || '').replace(/^\s*\[[^\]]+\]\s*/, '');
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
const live = () => db.games.filter((g) => (g.status || 'active') === 'active' || g.status === 'shipped');
export const settings = () => ({ on: true, at: db.settings.workHours?.end || '18:00', ...(db.settings.dailyReport || {}) });

function account() {
  return db.accounts.filter((a) => a.loggedIn && !(a.limitedUntil > Date.now()) && orch.utilization(a) * 100 < (db.settings.limitGuardPct || 95)).sort(pace.compareAccounts)[0] || null;
}

// ---------------------------------------------------------------------------
// The daily update

function facts(game, since) {
  const tasks = db.tasks.filter((t) => t.gameId === game.id);
  const name = (id) => db.agents.find((a) => a.id === id)?.name || 'an agent';
  const done = tasks.filter((t) => t.status === 'done' && !t.cancelled && t.doneAt >= since);
  const review = tasks.filter((t) => t.status === 'review' || (t.review?.state === 'pending' && t.doneAt >= since));
  const claimed = tasks.filter((t) => t.status === 'claimed');
  const blocked = tasks.filter((t) => t.status === 'blocked' && (t.updatedAt || 0) >= since);
  const notes = orch.readFeed(game.id, 2000).filter((e) => e.kind === 'note' && !e.to && (e.ts || 0) >= since).slice(-6);
  let runs = [];
  try { runs = perf.runs(game.id).filter((r) => !r.hidden && r.at >= since); } catch { /* no runs */ }
  return {
    done, review, claimed, blocked, notes, runs,
    questions: db.inbox.filter((q) => q.gameId === game.id && q.status === 'open').length,
    interventions: (db.interventions || []).filter((i) => i.gameId === game.id && i.status === 'open').map((i) => i.title),
    gdd: game.gddReview?.last && game.gddReview.last.at >= since && !game.gddReview.last.skipped ? game.gddReview.last : null,
    audit: game.roadmap?.audit?.at >= since ? game.roadmap.audit : null,
    name,
  };
}

function prompt(game, f, { since, awayPeriod }) {
  const task = (t) => `- #${t.num} ${strip(t.title)}${t.summary ? `\n  What the agent reported: ${clip(t.summary, 700)}` : ''}${t.review?.state === 'changes' ? '\n  (the director sent this back for changes)' : ''}`;
  return `Write today's update for ${orch.directorName()}, the solo developer of "${game.name}", about what their AI team did ${awayPeriod ? `while they were ${away.REASONS[awayPeriod.reason] || 'away'} (${awayPeriod.from} to ${awayPeriod.to})` : `since ${new Date(since).toLocaleString()}`}.

They are a game director, not a programmer: write in plain words about the game as a player meets it. No file names, code, function names or tooling jargon; ticket numbers only in brackets, like (#12). Be honest: if an agent's report says something is untested, partial or a placeholder, say so. Don't invent anything that isn't below.

Use exactly these sections (leave a section out if it has nothing):
## In one line
One sentence: the day's biggest change for players.
## What changed for players
What a player will notice now that they couldn't before, grouped by experience (moving around, the match, the look, the sound…), most noticeable first. Say how it feels or plays differently, not what was coded.
## Worth checking
What to try next time they play, and exactly where to look and what "good" looks like. Lead with anything waiting for their review.
## Still in progress
What's being worked on now, one line each, in player terms.
## Needs you
Only what is truly waiting on them, briefly.
Keep it under 350 words.

Finished:
${f.done.map(task).join('\n') || '(nothing)'}

Waiting for the director's review:
${f.review.map((t) => `- #${t.num} ${strip(t.title)}`).join('\n') || '(nothing)'}

In progress now:
${f.claimed.map((t) => `- #${t.num} ${strip(t.title)} (${f.name(t.claimedBy)})`).join('\n') || '(nothing)'}

Became blocked:
${f.blocked.map((t) => `- #${t.num} ${strip(t.title)}: ${clip(t.blockReason, 200)}`).join('\n') || '(nothing)'}

Waiting on the director: ${f.questions} open question(s) in their Inbox${f.interventions.length ? `; requests that need them: ${f.interventions.join('; ')}` : ''}.
${f.notes.length ? `\nThe director's own notes in this period (for context):\n${f.notes.map((n) => `- note #${n.num}: ${clip(n.text, 300)}`).join('\n')}\n` : ''}${f.runs.length ? `\nHeadset profiler runs in this period: ${f.runs.map((r) => `${r.budgets.filter((b) => b.pass).length} of ${r.budgets.length} performance budgets met`).join('; ')}.\n` : ''}${f.gdd ? `\nThe GDD check found: ${clip(f.gdd.summary, 400)}\n` : ''}${f.audit ? `\nThe level audit found: ${clip(f.audit.summary, 400)}\n` : ''}`;
}

const running = new Set();

// Writes one game's update and posts it in its Feed. `awayPeriod` makes it the welcome-back update.
export async function writeReport(gameId, { awayPeriod = null, scheduled = false } = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  if (running.has(game.id)) return { running: true };
  running.add(game.id);
  const state = (game.dailyReport ||= {});
  const since = awayPeriod ? new Date(`${awayPeriod.from}T00:00`).getTime() : Math.max(state.lastAt || 0, Date.now() - (scheduled ? 2 * DAY : DAY));
  try {
    const f = facts(game, since);
    const quiet = !f.done.length && !f.claimed.length && !f.review.length && !f.blocked.length;
    let text;
    if (quiet) {
      text = `Quiet ${awayPeriod ? 'time away' : 'day'}: nothing finished or in progress on ${game.name}.${f.questions ? ` ${f.questions} question${f.questions > 1 ? 's' : ''} wait in your Inbox.` : ''}`;
    } else {
      const acct = must(account(), 'No logged-in account has usage free right now.');
      const { result } = await claude.runQuick({
        account: acct,
        args: ['--model', db.settings.reportModel || 'sonnet', '--tools', 'Read', '--permission-mode', 'dontAsk'],
        prompt: prompt(game, f, { since, awayPeriod }),
      });
      if (result) recordUsage({ account: acct, gameId: game.id, kind: 'daily-report', result });
      text = String(result?.result || '').trim();
      must(text, 'The update came back empty.');
    }
    orch.feedPost(game.id, { kind: 'report', from: awayPeriod ? 'While you were away' : 'Daily update', text, since });
    Object.assign(state, { lastAt: Date.now(), lastDay: away.dayKey(), error: null });
    return { ok: true };
  } catch (err) {
    state.error = err.message;
    if (!scheduled) throw err;
    return { error: err.message };
  } finally {
    running.delete(game.id);
    save();
    changed();
  }
}

export async function writeAll() {
  for (const g of live()) await writeReport(g.id).catch((err) => console.error('[ballast] daily update', g.name, err.message));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Away work: keep the board stocked with review-free improvements while the director is away

let latestEngine = { at: 0, version: null };
function engineLatest() {
  if (Date.now() - latestEngine.at < 6 * HOUR) return Promise.resolve(latestEngine.version);
  return new Promise((resolve) => exec('npm view @thecompanylive/jungle-engine-client version --registry=https://npm.pkg.github.com', { timeout: 30e3, windowsHide: true }, (err, out) => {
    latestEngine = { at: Date.now(), version: err ? null : String(out).trim().split('\n').pop() || null };
    resolve(latestEngine.version);
  }));
}
function engineInUse(game) {
  try { return JSON.parse(fs.readFileSync(path.join(game.repoPath, 'package-lock.json'), 'utf8')).packages?.['node_modules/@jungle/engine-client']?.version || null; } catch { return null; }
}

const AWAY_SCHEMA = {
  type: 'object',
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array', maxItems: 8,
      items: {
        type: 'object',
        required: ['title', 'detail', 'kind'],
        properties: {
          title: { type: 'string', description: 'Starts with a department tag: [gameplay], [art], [audio], [ui], [backend], [qa] or [docs] (not the kind), e.g. "[qa] …".' },
          detail: { type: 'string', description: 'What to do, and how the agent checks it is done without the director.' },
          kind: { enum: ['engine', 'asset-quality', 'qa', 'simulation', 'performance', 'robustness', 'docs'] },
        },
      },
    },
  },
};

const claimable = (game) => db.tasks.filter((t) => t.gameId === game.id && t.status === 'open' && !t.assignee && !away.needsDirector(game, t));

export async function awayWork(gameId) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const a = must(away.current(), 'The director isn\'t away.');
  const st = (game.awayWork ||= {});
  if (st.running) return st;
  st.running = true;
  try {
    const [latest, used] = [await engineLatest(), engineInUse(game)];
    const board = db.tasks.filter((t) => t.gameId === game.id && t.status !== 'done').map((t) => `#${t.num} [${t.status}] ${t.title}`).slice(-120).join('\n');
    const recent = db.tasks.filter((t) => t.gameId === game.id && t.status === 'done' && !t.cancelled).sort((x, y) => (y.doneAt || 0) - (x.doneAt || 0)).slice(0, 40).map((t) => `#${t.num} ${t.title}`).join('\n');
    const acct = must(account(), 'No logged-in account has usage free right now.');
    const { result } = await claude.runQuick({
      account: acct,
      cwd: game.repoPath,
      args: ['--model', db.settings.reportModel || 'sonnet', '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', ...jungledocs.forRun(game).args, '--json-schema', JSON.stringify(AWAY_SCHEMA)],
      prompt: `The director of "${game.name}" is ${away.REASONS[a.reason] || 'away'} until ${a.to} and can't review, playtest or decide anything until then. Their AI team is running out of work it can do without them. You are in the repo${game.subdir ? ` (this game's folder is ${game.subdir}/)` : ''}: look at it and propose up to 8 board tasks an agent can finish AND verify on its own that make the project better.

Good kinds of work:
- Engine: ${used ? `the project runs Jungle Engine ${used}${latest ? `; the latest published release is ${latest}` : ''}. ${latest && used !== latest ? 'Evaluate the upgrade on a branch: what changed, what breaks, tests and checks green, then report.' : 'Check the code still follows the engine\'s current public APIs and rules.'}` : 'keep dependencies current where safe and verifiable.'}
- Asset quality within the current approved style: budgets (triangles, texture sizes, draw calls), import settings, compression, LODs, missing or broken references. No new art direction or redesigns.
- QA: automated tests and regression checks for recently finished features, robot/scripted checks, flaky test fixes.
- Headset and bot simulations: scripted or bot-driven sessions, simulated Quest load, profiler captures, multiplayer soak runs.
- Performance, robustness, error handling, and docs that help agents work.
Never: new features, design or art-direction choices, or anything that needs the director's approval, playtest or decision. Don't repeat what's already on the board, including work that is done but waiting for the director's review (an engine upgrade already in review, for example).

Board (not done):
${board || '(empty)'}

Recently finished:
${recent || '(nothing)'}
${jungledocs.forRun(game).text}`,
    });
    if (result) recordUsage({ account: acct, gameId: game.id, kind: 'away-work', result });
    const out = result?.structured_output;
    must(out, result?.result?.slice(0, 300) || 'No tasks came back.');
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const titles = new Set(db.tasks.filter((t) => t.gameId === game.id).map((t) => norm(t.title)));
    const added = [];
    for (const t of out.tasks || []) {
      if (!t.title?.trim() || titles.has(norm(t.title))) continue;
      titles.add(norm(t.title));
      const task = orch.addTask(game.id, { title: t.title.trim().slice(0, 200), detail: `${t.detail}\n\nAdded while the director is away: finish and verify it without them.`, createdBy: 'Away work' });
      added.push(task);
    }
    Object.assign(st, { lastAt: Date.now(), added: added.map((t) => t.num), error: null });
    if (added.length) orch.feedPost(game.id, { kind: 'task', from: 'Away work', text: `While you're away, the team has review-free work to do:\n${added.map((t) => `- #${t.num} ${t.title}`).join('\n')}` });
    return st;
  } catch (err) {
    st.error = err.message;
    st.lastAt = Date.now(); // don't retry every tick after a failure
    return st;
  } finally {
    st.running = false;
    save();
    changed();
  }
}

// ---------------------------------------------------------------------------
// Schedule

function todayAt(hm) {
  const [h, m] = (TIME_RE.test(hm || '') ? hm : '18:00').split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    // Away starts and ends: tell each game's feed, and write the welcome-back update on return.
    const a = away.current();
    const was = db.settings.awaySeen || null;
    if (a && (!was || was.from !== a.from || was.to !== a.to)) {
      db.settings.awaySeen = { ...a };
      save();
      for (const g of live()) orch.feedPost(g.id, { kind: 'system', text: `You're ${away.REASONS[a.reason] || 'away'} until ${a.to}${a.note ? ` (${a.note})` : ''}. Agents leave work that needs you on the board and do review-free work instead; Ballast adds improvement tasks when a board runs low. Daily updates keep coming.` });
    } else if (!a && was) {
      db.settings.awaySeen = null;
      save();
      for (const g of live()) await writeReport(g.id, { awayPeriod: was, scheduled: true });
    }
    // The daily update, once a day at the set time.
    const s = settings();
    if (s.on && Date.now() >= todayAt(s.at) && db.settings.dailyReportDay !== away.dayKey()) {
      db.settings.dailyReportDay = away.dayKey();
      save();
      for (const g of live()) if (g.dailyReport?.lastDay !== away.dayKey()) await writeReport(g.id, { scheduled: true });
    }
    // Away work: top a board up when what agents can do without the director runs low (at most every 6 h).
    if (a) {
      for (const g of db.games.filter((x) => (x.status || 'active') === 'active')) {
        const agents = db.agents.filter((x) => x.gameId === g.id && !x.retired && !x.parentId).length;
        if (!agents || Date.now() - (g.awayWork?.lastAt || 0) < 6 * HOUR) continue;
        if (claimable(g).length < Math.max(2, agents)) await awayWork(g.id);
      }
    }
  } catch (err) {
    console.error('[ballast] daily', err.message);
  } finally {
    ticking = false;
  }
}

export function configure(body = {}) {
  if (body.dailyReport) {
    const r = body.dailyReport;
    const cur = settings();
    if (r.at !== undefined) must(TIME_RE.test(String(r.at)), 'Times look like 18:00.');
    db.settings.dailyReport = { on: r.on !== undefined ? !!r.on : cur.on, at: r.at !== undefined ? String(r.at).padStart(5, '0') : cur.at };
  }
  if (body.away !== undefined) {
    if (!body.away) db.settings.away = null;
    else {
      const { from, to, reason = 'away', note = '' } = body.away;
      must(/^\d{4}-\d{2}-\d{2}$/.test(from || '') && /^\d{4}-\d{2}-\d{2}$/.test(to || ''), 'Pick the first and last day you\'re away.');
      must(from <= to, 'The last day is before the first.');
      db.settings.away = { from, to, reason: away.REASONS[reason] ? reason : 'away', note: String(note).trim().slice(0, 200) };
    }
  }
  save();
  changed();
  setTimeout(() => tick(), 500);
  return { dailyReport: settings(), away: db.settings.away || null, awayNow: away.isAway() };
}

export function init() {
  for (const g of db.games) if (g.awayWork?.running) g.awayWork.running = false;
  setInterval(() => tick(), 60e3).unref();
  setTimeout(() => tick(), 20e3).unref();
}
