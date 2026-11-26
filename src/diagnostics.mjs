// Diagnostics for conversation mode: a read-only snapshot of Ballast's live state for one game, written
// as plain files a Claude run can read, so "why isn't X working?" can be traced to its cause: agents'
// live state and what they wait on, accounts and limits, the board, recent errors, Ballast's logs,
// schedules, recent runs, and (for troubleshooting questions) live checks of the network, the repo
// clone and the CLI. Secrets are never written: no tokens, keys, cookies or webhook URLs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { db, paths, HOME, usageFile, transcriptFile, readJsonlTail } from './store.mjs';
import * as orch from './orchestrator.mjs';
import * as pace from './pace.mjs';
import * as claude from './claude.mjs';

export const SOURCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = Date.now();
const when = (t) => (t ? new Date(t).toLocaleString() : '-');
const ago = (t) => { if (!t) return '-'; const m = Math.round((Date.now() - t) / 60e3); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const SECRET = /token|secret|password|passwd|apikey|api_key|cookie|webhook|authorization|credential|fileKey|agentKey/i;

// Deep copy without secrets: secret-looking keys masked, URLs with credentials or query strings trimmed.
function clean(v, key = '') {
  if (v == null) return v;
  if (SECRET.test(key)) return v ? '[hidden]' : v;
  if (typeof v === 'string') return v.replace(/(https?:\/\/)[^/\s:@]+:[^@\s]+@/g, '$1[hidden]@').replace(/([?&](?:key|token|sig|signature|access_token)=)[^&\s]+/gi, '$1[hidden]');
  if (Array.isArray(v)) return v.map((x) => clean(x));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'secrets').map(([k, x]) => [k, clean(x, k)]));
  return v;
}

function run(cmd, args, cwd, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd) }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err?.killed ? 'timed out' : err?.message) || '').trim() });
    });
  });
}

const tailFile = (file, lines) => { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines).join('\n'); } catch { return '(no file)'; } };

// Live checks: is GitHub reachable, is the game's clone healthy, are the tools there.
async function checks(game) {
  const out = [];
  const add = (name, r) => out.push(`- **${name}**: ${r.ok ? 'OK' : 'FAILED'}${r.out ? `\n  ${r.out.split('\n').slice(0, 6).join('\n  ')}` : ''}${!r.ok && r.err ? `\n  error: ${r.err.split('\n').slice(-3).join(' | ')}` : ''}`);
  const host = game.github ? 'github.com' : null;
  const tasks = [];
  if (host) tasks.push(dns.lookup(host).then((a) => add(`DNS lookup of ${host}`, { ok: true, out: a.address }), (e) => add(`DNS lookup of ${host}`, { ok: false, err: e.message })));
  if (game.repoPath && fs.existsSync(game.repoPath)) {
    tasks.push(run('git', ['-C', game.repoPath, 'ls-remote', '--heads', 'origin', game.baseBranch || 'HEAD'], undefined, 10000).then((r) => add('Remote reachable (git ls-remote)', r)));
    tasks.push(run('git', ['-C', game.repoPath, 'status', '--short', '--branch'], undefined, 8000).then((r) => add(`Clone status (${game.repoPath})`, { ...r, out: r.out.split('\n').slice(0, 12).join('\n') })));
    tasks.push(run('git', ['-C', game.repoPath, 'log', '-3', '--format=%h %cr %s'], undefined, 8000).then((r) => add('Clone: latest commits', r)));
    tasks.push(run('git', ['-C', game.repoPath, 'worktree', 'list'], undefined, 8000).then((r) => add('Worktrees', r)));
  } else add('Game folder', { ok: false, err: `missing: ${game.repoPath || '(none set)'}` });
  tasks.push(run(claude.resolveClaude(), ['--version'], undefined, 15000).then((r) => add(`Claude CLI (${claude.resolveClaude()})`, r)));
  if (game.runner === 'cloud') tasks.push(run('gh', ['auth', 'status', '--hostname', 'github.com'], undefined, 10000).then((r) => add('GitHub CLI sign-in', { ok: r.ok, out: (r.out || r.err).match(/Logged in to \S+ account \S+/)?.[0] || '', err: r.ok ? '' : r.err })));
  await Promise.all(tasks);
  return out.join('\n');
}

// Writes the snapshot for one game; returns the folder. `live` adds the network and repo checks.
export async function snapshot(game, { live = false } = {}) {
  const dir = path.join(paths.tmp, `diagnostics-${game.id}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const w = (name, text) => fs.writeFileSync(path.join(dir, name), typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  const agents = db.agents.filter((a) => a.gameId === game.id);
  const tasks = db.tasks.filter((t) => t.gameId === game.id);

  // Ballast itself
  const head = await run('git', ['-C', SOURCE_DIR, 'log', '-1', '--format=%h %cd %s', '--date=short'], undefined, 5000);
  const dirty = await run('git', ['-C', SOURCE_DIR, 'status', '--short'], undefined, 5000);
  w('ballast.md', `# Ballast
- Snapshot taken: ${when(Date.now())}
- Ballast running since: ${when(startedAt)} (${ago(startedAt)})
- Source: ${SOURCE_DIR} at ${head.out || '?'}${dirty.out ? `, with uncommitted changes in: ${dirty.out.split('\n').map((l) => l.slice(3)).join(', ')}` : ''}
- Data: ${HOME}
- Node ${process.versions.node} on ${os.platform()} ${os.release()}, ${Math.round(os.freemem() / 1e9)} GB RAM free
- Settings: ${JSON.stringify(clean(db.settings))}`);

  // This game
  const { roadmap: rm, ...gameRest } = game;
  w('game.json', clean({ ...gameRest, roadmap: rm ? { status: rm.status, error: rm.error, breakdownAt: rm.breakdownAt, audit: rm.audit && { ...rm.audit, summary: undefined }, features: (rm.features || []).map((f) => ({ name: f.name, base: f.base, verified: f.verified && { level: f.verified.level, at: f.verified.at, by: f.verified.by } })), milestones: (rm.milestones || []).map((m) => ({ name: m.name, core: m.core, other: m.other, reachedAt: m.reachedAt })) } : null }));

  // Agents, live
  w('agents.md', `# Agents on ${game.name}\n\n${agents.map((a) => {
    const d = orch.agentDiagnostics(a);
    return `## ${a.name}${a.retired ? ' (retired)' : ''}${a.parentId ? ` (delegate of ${db.agents.find((x) => x.id === a.parentId)?.name || '?'})` : ''}
- Status: **${d.status}**${d.error ? `, error: ${d.error}` : ''}${d.paused ? ', paused' : ''}
- Model: ${a.model || '(game default)'} · role: ${a.role || '-'} · last active ${ago(a.lastActive)}
- Running now: ${d.running ? `yes, since ${ago(d.runningSince)}` : 'no'}${d.cloud ? ` · cloud session working since ${ago(d.cloud.since)} on ${d.cloud.items.join(', ')} (${d.cloud.url})` : ''}${d.dispatching ? ' · handing work to its cloud session' : ''}
- Cloud session linked: ${d.cloudLinked ? 'yes' : 'no'}
- Queue: ${d.queue.length ? d.queue.map((q) => `${q.kind}${q.direct ? ' (from the director)' : ''}`).join(', ') : 'empty'}${d.waiting ? `\n- Waiting to ${d.waiting.what}: waits for ${d.waiting.why}` : ''}
- Holds tickets: ${d.heldTasks.join(', ') || 'none'}
- Account: ${d.account ? `${d.account.name}, ${d.account.loggedIn ? 'signed in' : 'SIGNED OUT'}${d.account.limited ? ', AT ITS USAGE LIMIT' : ''}${d.account.overGuard ? ', over the autopilot guard' : ''}, ${d.account.load} of ${d.account.max} sessions running` : 'missing'}
- Usage policy on that account now: ${d.policy ? Object.entries(d.policy).filter(([, v]) => v).map(([k, v]) => (v === true ? k : `${k}=${v}`)).join(', ') || 'nothing in force' : '-'}${d.cacheDeferred ? `\n- Held back to keep its prompt cache warm: ${JSON.stringify(d.cacheDeferred)}` : ''}`;
  }).join('\n\n') || '(no agents)'}`);

  // Accounts
  w('accounts.md', `# Accounts\n\n${db.accounts.map((a) => {
    const p = pace.accountPace(a);
    return `- **${a.name}**: ${a.loggedIn ? 'signed in' : 'SIGNED OUT'}; session ${Math.round(p.session?.used ?? 0)}%, weekly ${Math.round(p.weekly?.used ?? 0)}% (${pace.describeWeekly(p) || 'pace unknown'}), weekly resets ${when(p.weekly?.resetsAt)}; limits last read ${ago(a.usage?.updatedAt)}${a.limitedUntil > Date.now() ? `; LIMITED until ${when(a.limitedUntil)} (${a.limitReason || ''})` : ''}; max ${a.maxConcurrent || db.settings.maxConcurrentPerAccount} parallel${a.cloudError ? `; claude.ai sync error: ${a.cloudError}` : ''}`;
  }).join('\n')}`);

  // Board
  const by = (s) => tasks.filter((t) => t.status === s);
  const stale = (db.settings.cloudTaskTimeoutMin || 240) * 60e3;
  w('board.md', `# Board: ${game.name}
Counts: ${['open', 'claimed', 'review', 'blocked', 'done'].map((s) => `${s} ${by(s).length}`).join(', ')}

## In progress
${by('claimed').map((t) => `- #${t.num} ${t.title} · ${db.agents.find((a) => a.id === t.claimedBy)?.name || 'nobody'} · claimed ${ago(t.claimedAt)}${Date.now() - (t.claimedAt || 0) > stale ? ' · OVER THE CLOUD TIMEOUT' : ''}${t.nudges ? ` · nudged ${t.nudges}×` : ''}`).join('\n') || '(none)'}

## Open (top 30 by priority)
${by('open').sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1) || a.num - b.num).slice(0, 30).map((t) => `- #${t.num} [p${t.priority ?? 1}] ${t.title}${t.assignee ? ` (for ${db.agents.find((a) => a.id === t.assignee)?.name})` : ''}`).join('\n') || '(none)'}

## Blocked
${by('blocked').map((t) => `- #${t.num} ${t.title}: ${(t.blockReason || '').slice(0, 300)}${t.human ? ' · waiting on a Human Intervention' : ''}${t.triage?.status ? ` · triage ${t.triage.status}` : ''}`).join('\n') || '(none)'}

## Awaiting review
${by('review').map((t) => `- #${t.num} ${t.title} · since ${ago(t.review?.since)}`).join('\n') || '(none)'}`);

  // Feed: errors and system messages, and the latest of everything
  const feed = orch.readFeed(game.id, 3000);
  const fmt = (e) => `- ${when(e.ts || e.at)} [${e.kind}${e.from ? ` ${e.from}` : ''}] ${String(e.text || '').replace(/\s+/g, ' ').slice(0, 400)}`;
  const problems = feed.filter((e) => e.kind === 'error' || e.error || /✗|fail|error|couldn't|could not|timed out|refused|unable/i.test(e.text || ''));
  w('feed-problems.md', `# Feed entries that report a problem (latest 80)\n\n${problems.slice(-80).map(fmt).join('\n') || '(none)'}`);
  w('feed-latest.md', `# Latest 80 feed entries\n\n${feed.slice(-80).map(fmt).join('\n')}`);

  // Ballast's logs
  w('server-errors.log', tailFile(path.join(HOME, 'server.err.log'), 300));
  w('server.log', tailFile(path.join(HOME, 'server.log'), 200));

  // Schedules and background jobs
  const builds = (db.builds || []).filter((b) => b.gameId === game.id).slice(-8);
  w('schedules.md', `# Schedules and background jobs
- Autopilot: ${game.autopilot ? 'on' : 'OFF'}${game.jungle?.waitingForMerge ? ` (waiting for ${game.jungle.pr || 'its pull request'} to merge)` : ''}; automatic turns today ${game.autoTurns?.count ?? 0} of ${db.settings.autopilotDailyTurns}
- Game status: ${game.status || 'active'}
- Work hours: ${JSON.stringify(db.settings.workHours)}
- Check-in builds: ${(game.build?.checkins || []).join(', ') || 'none'}; command: ${game.build?.command || '(none)'}
- Recent builds:\n${builds.map((b) => `  - ${when(b.startedAt)} ${b.status}${b.error ? `: ${String(b.error).slice(0, 300)}` : ''}`).join('\n') || '  (none)'}
- GDD re-evaluation: ${JSON.stringify(clean(game.gddReview ? { ...game.gddReview, last: game.gddReview.last && { ...game.gddReview.last, summary: undefined } } : null))}
- Level audit: ${JSON.stringify(clean(rm?.audit ? { ...rm.audit, summary: undefined } : null))}
- Usage reports every ${db.settings.usageReportMin} min; last ${ago(db.usageReports.at(-1)?.at)}
- Human Interventions open: ${(db.interventions || []).filter((i) => i.gameId === game.id && i.status === 'open').length}; open questions: ${db.inbox.filter((q) => q.gameId === game.id && q.status === 'open').length}`);

  // Recent Claude runs Ballast made, and agents' latest transcript lines
  const usage = readJsonlTail(usageFile, 3000).filter((u) => u.gameId === game.id || !u.gameId).slice(-60);
  w('runs.md', `# Ballast's latest Claude runs (this game and housekeeping)\n\n${usage.map((u) => `- ${when(u.ts)} ${u.kind} on ${db.accounts.find((a) => a.id === u.accountId)?.name || '?'}: ${u.input + u.cacheRead + u.cacheWrite} in (${u.cacheRead} cached), ${u.output} out`).join('\n')}`);
  const tr = agents.filter((a) => !a.retired).map((a) => {
    const lines = readJsonlTail(transcriptFile(a.id), 25).map((e) => `  - ${when(e.ts || e.at)} ${e.kind || e.type || ''}: ${String(e.text || e.summary || '').replace(/\s+/g, ' ').slice(0, 240)}`);
    return `## ${a.name}\n${lines.join('\n') || '  (no transcript on this PC: cloud agents work on claude.ai)'}`;
  });
  w('transcripts.md', `# Latest transcript lines per agent\n\n${tr.join('\n\n')}`);

  if (live) w('checks.md', `# Live checks, run ${when(Date.now())}\n\n${await checks(game)}`);

  w('index.md', `# Ballast diagnostics for "${game.name}"
Taken ${when(Date.now())}. Read-only: nothing here changes Ballast.

- ballast.md: Ballast's version, uptime, data folder and settings
- game.json: this game's record (settings, schedules, roadmap levels)
- agents.md: every agent's live state: running, queued and why it waits, held tickets, account load, usage rules in force
- accounts.md: every account's sign-in, limits, pace and errors
- board.md: in-progress (with claim age), open, blocked (with reasons) and review tickets
- feed-problems.md / feed-latest.md: feed entries reporting problems, and the latest entries
- server-errors.log / server.log: Ballast's own logs
- schedules.md: autopilot, builds, GDD re-evaluation, level audit, reports
- runs.md: Ballast's latest Claude runs with token and cache counts
- transcripts.md: agents' latest transcript lines (agents on this PC)${live ? '\n- checks.md: live checks just run: GitHub lookup, remote reachable, clone state, worktrees, CLI versions' : ''}

Ballast's source code is in ${SOURCE_DIR} (src/ for the server, public/ for the app).`);
  return dir;
}

// Questions about Ballast not behaving get the live checks too (they take a few seconds).
export const looksLikeTroubleshooting = (text) => /\b(not|isn'?t|aren'?t|doesn'?t|don'?t|won'?t|wasn'?t|didn'?t|can'?t|cannot|never|stuck|hang|hung|frozen|broken|bug|error|fail|crash|wrong|why|diagnos|troubleshoot|debug|queue|waiting|claim|idle|restart|offline|down)\b/i.test(text || '');
