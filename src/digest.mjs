// Daily digest and weekly report: what an author developer reads on their phone.
// The digest is plain numbers (no Claude run): what finished, what needs you, what's blocked,
// how much usage is left. The weekly report has Claude write a devlog and social posts per game
// from the week's finished work, aimed at the audiences its Bartle Audit found.
import { db, save, uid } from './store.mjs';
import { changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import { recordUsage } from './usage.mjs';
import { inWorkHours } from './reports.mjs';

const DAY = 86400e3;
const live = () => db.games.filter((g) => (g.status || 'active') !== 'archived');
const pct = (acct, key) => { const w = acct.usage?.windows?.[key]; return w?.utilization == null ? null : Math.round(w.utilization * 100); };
const strip = (title) => title.replace(/^\s*\[[^\]]+\]\s*/, '');

export function buildDigest(since = Date.now() - DAY) {
  const games = live().map((g) => {
    const tasks = db.tasks.filter((t) => t.gameId === g.id);
    return {
      id: g.id,
      name: g.name,
      status: g.status || 'active',
      done: tasks.filter((t) => t.status === 'done' && t.doneAt >= since).map((t) => ({ num: t.num, title: strip(t.title) })),
      blocked: tasks.filter((t) => t.status === 'blocked').map((t) => ({ num: t.num, title: strip(t.title), why: t.blockReason || '' })),
      reviews: tasks.filter((t) => t.review?.state === 'pending').length,
      questions: db.inbox.filter((q) => q.gameId === g.id && q.status === 'open').length,
      deptNotes: (db.deptNotes || []).filter((n) => n.gameId === g.id && n.status === 'new').length,
      needsYou: (db.interventions || []).filter((i) => i.gameId === g.id && i.status === 'open').map((i) => i.title),
      open: tasks.filter((t) => t.status === 'open' || t.status === 'claimed').length,
      builds: db.builds.filter((b) => b.gameId === g.id && b.startedAt >= since).map((b) => b.status),
      releases: (g.releases || []).filter((r) => r.at >= since),
    };
  });
  const accounts = db.accounts.filter((a) => a.loggedIn).map((a) => ({ name: a.name, session: pct(a, 'five_hour'), weekly: pct(a, 'seven_day'), limited: a.limitedUntil > Date.now() }));
  const done = games.reduce((n, g) => n + g.done.length, 0);
  const needs = games.reduce((n, g) => n + g.reviews + g.questions + g.needsYou.length, 0);
  return { id: uid('dig'), kind: 'daily', at: Date.now(), since, games, accounts, headline: `${done} task${done === 1 ? '' : 's'} finished${needs ? `, ${needs} thing${needs === 1 ? '' : 's'} waiting for you` : ''}` };
}

function digestText(d) {
  const lines = [`Ballast daily digest: ${d.headline}`];
  for (const g of d.games) {
    if (!g.done.length && !g.blocked.length && !g.reviews && !g.questions && !g.builds.length && !g.needsYou.length) continue;
    lines.push('', `${g.name}${g.status !== 'active' ? ` (${g.status})` : ''}: ${g.done.length} done, ${g.open} open`);
    for (const n of g.needsYou) lines.push(`  🙋 Needs you: ${n}`);
    for (const t of g.done.slice(0, 8)) lines.push(`  ✓ #${t.num} ${t.title}`);
    if (g.done.length > 8) lines.push(`  … and ${g.done.length - 8} more`);
    for (const t of g.blocked.slice(0, 5)) lines.push(`  ⛔ #${t.num} ${t.title}${t.why ? `: ${t.why.slice(0, 120)}` : ''}`);
    if (g.reviews || g.questions) lines.push(`  ⏳ ${[g.reviews && `${g.reviews} to review`, g.questions && `${g.questions} question${g.questions > 1 ? 's' : ''} in your Inbox`].filter(Boolean).join(', ')}`);
    if (g.builds.length) lines.push(`  🔨 builds: ${g.builds.join(', ')}`);
  }
  if (d.accounts.length) lines.push('', `Usage: ${d.accounts.map((a) => `${a.name} ${a.session ?? '?'}% session / ${a.weekly ?? '?'}% weekly${a.limited ? ' (out)' : ''}`).join(' · ')}`);
  return lines.join('\n');
}

async function post(text) {
  const url = db.settings.reportWebhook?.trim();
  if (!url) return null;
  try {
    // Discord caps a message at 2000 characters, Slack takes "text".
    for (let i = 0; i < text.length; i += 1900) {
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text.slice(i, i + 1900), content: text.slice(i, i + 1900) }) });
    }
    return null;
  } catch (err) { return err.message; }
}

export async function digestNow() {
  const last = db.digests.filter((d) => d.kind === 'daily').at(-1);
  const d = buildDigest(last ? Math.max(last.at, Date.now() - 3 * DAY) : Date.now() - DAY);
  d.shareError = await post(digestText(d));
  db.digests.push(d);
  db.digests = db.digests.slice(-60);
  save();
  changed();
  return d;
}

// ---------------------------------------------------------------------------
// Weekly report

const strs = { type: 'array', items: { type: 'string' } };
const WEEKLY_SCHEMA = {
  type: 'object',
  required: ['headline', 'devlog', 'posts', 'clips', 'nextWeek'],
  properties: {
    headline: { type: 'string', description: 'One line on what this week meant for the game, for players.' },
    devlog: { type: 'string', description: 'A devlog post in Markdown, 250-450 words, written by the developer in first person for players.' },
    posts: { type: 'array', items: { type: 'object', required: ['channel', 'text'], properties: { channel: { type: 'string' }, text: { type: 'string' } } }, description: '3-5 ready-to-post social posts, each for a named channel.' },
    clips: { ...strs, description: 'Moments worth capturing as short clips or screenshots this week, from what was built.' },
    nextWeek: { ...strs, description: 'What players can look forward to next, from the open board (no promises the board does not support).' },
  },
};

function weeklyPrompt(g, since) {
  const tasks = db.tasks.filter((t) => t.gameId === g.id);
  const done = tasks.filter((t) => t.status === 'done' && t.doneAt >= since);
  const audit = [...db.audits].reverse().find((a) => a.gameId === g.id && a.status === 'done')?.result;
  const caps = db.artifacts.filter((a) => a.gameId === g.id && (a.createdAt || 0) >= since).map((a) => a.title).slice(-30);
  return `Write this week's devlog and social posts for "${g.name}", made by a solo developer (an author developer building it with AI agents; don't dwell on the AI, players care about the game).

Game brief:
${g.brief?.trim().slice(0, 2500) || '(none)'}
${audit ? `\nAudience (Bartle Audit): ${audit.positioning}\n${audit.top.map((t) => `- ${t.subtype}: ${t.pitch} Channels: ${t.channels.slice(0, 3).join('; ')}. Say: ${t.say.slice(0, 3).join('; ')}. Avoid: ${t.avoid.slice(0, 3).join('; ')}`).join('\n')}\nWrite the posts for these audiences and their channels.\n` : '\nNo audience audit yet: aim the posts at the players the brief describes.\n'}
${(g.releases || []).filter((r) => r.at >= since).map((r) => `Released this week: ${[r.version, r.platforms, r.url].filter(Boolean).join(' · ')}\n`).join('')}
Finished this week (${done.length}):
${done.slice(-80).map((t) => `- ${strip(t.title)}${t.summary ? `: ${t.summary.replace(/\s+/g, ' ').slice(0, 240)}` : ''}`).join('\n') || '(nothing)'}

Captures and artifacts made this week:
${caps.map((c) => `- ${c}`).join('\n') || '(none)'}

Still on the board:
${tasks.filter((t) => t.status === 'open' || t.status === 'claimed').slice(0, 40).map((t) => `- ${strip(t.title)}`).join('\n') || '(nothing)'}

Write about what a player would notice and feel, not file names or code. Be concrete and honest; don't invent features that aren't in the list.`;
}

export async function weeklyNow({ since = Date.now() - 7 * DAY } = {}) {
  const report = { id: uid('wk'), kind: 'weekly', at: Date.now(), since, status: 'running', games: [] };
  db.weeklyReports.push(report);
  db.weeklyReports = db.weeklyReports.slice(-26);
  save();
  changed();
  const digest = buildDigest(since);
  for (const g of live()) {
    const d = digest.games.find((x) => x.id === g.id);
    const entry = { gameId: g.id, name: g.name, done: d.done.length, builds: d.builds.length, releases: d.releases.length };
    report.games.push(entry);
    if (!d.done.length && !d.releases.length) { entry.skipped = 'Nothing finished this week.'; continue; }
    try {
      const acct = db.accounts.filter((a) => a.loggedIn && !(a.limitedUntil > Date.now())).sort((a, b) => orch.utilization(a) - orch.utilization(b))[0];
      if (!acct) throw new Error('No logged-in account has usage free right now.');
      const { result } = await claude.runQuick({ account: acct, args: ['--model', db.settings.weeklyModel || 'sonnet', '--tools', 'Read', '--json-schema', JSON.stringify(WEEKLY_SCHEMA)], prompt: weeklyPrompt(g, since) });
      if (result) recordUsage({ account: acct, gameId: g.id, kind: 'weekly', result });
      if (!result?.structured_output?.devlog) throw new Error('The writer returned nothing.');
      entry.out = result.structured_output;
    } catch (err) { entry.error = err.message; }
    changed();
  }
  report.status = 'done';
  const lines = [`Ballast weekly report: ${digest.headline} this week`];
  for (const e of report.games) lines.push(`• ${e.name}: ${e.done} done${e.out ? `. ${e.out.headline}` : e.skipped ? '' : e.error ? ` (report failed: ${e.error})` : ''}`);
  report.shareError = await post(lines.join('\n'));
  save();
  changed();
  return report;
}

// ---------------------------------------------------------------------------
// Schedule: the digest at the start of your working day, the weekly report at its set time.

const todayAt = (hm) => { const [h, m] = hm.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
let busy = false;

export async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    const day = new Date().toDateString();
    const w = db.settings.workHours || {};
    if (db.settings.digestDaily !== false && inWorkHours() && db.settings.lastDigestDay !== day && now >= todayAt(w.start || '09:00')) {
      db.settings.lastDigestDay = day;
      await digestNow();
    }
    const wk = db.settings.weeklyReport || { day: 5, time: '16:00' };
    if (wk.day != null && new Date().getDay() === Number(wk.day) && now >= todayAt(wk.time || '16:00') && db.settings.lastWeeklyDay !== day) {
      db.settings.lastWeeklyDay = day;
      save();
      await weeklyNow();
    }
  } catch (err) { console.error('[ballast] digest', err.message); } finally { busy = false; }
}

export function init() {
  for (const r of db.weeklyReports.filter((x) => x.status === 'running')) r.status = 'done';
  setInterval(() => tick(), 60e3).unref();
}
