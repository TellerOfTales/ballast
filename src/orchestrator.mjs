// The brain: accounts, games, agents, the shared board, and the dispatch loop that
// turns director notes into work spread across every account.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  db, save, uid, slug, paths, appendJsonl, readJsonlTail, feedFile, transcriptFile, attachmentsDir,
} from './store.mjs';
import { bus, changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as git from './git.mjs';
import * as P from './prompts.mjs';
import { recordUsage } from './usage.mjs';
import * as cloud from './cloud.mjs';
import * as remote from './remote.mjs';
import * as review from './review.mjs';
import * as inbox from './inbox.mjs';
import * as deptnotes from './deptnotes.mjs';
import * as targets from './targets.mjs';

export const runtime = { baseUrl: '' }; // filled in by the server once it is listening
const MCP_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-server.mjs');
const BATCHABLE = new Set(['message', 'note', 'next']);

// ---------------------------------------------------------------------------
// Runtime state (not persisted)

const rt = new Map(); // agentId -> { queue, child, setup, item, result, error, ... }
const acctRunning = new Map(); // accountId -> running turn count

function R(agentId) {
  if (!rt.has(agentId)) rt.set(agentId, { queue: [], child: null, setup: false, error: null });
  return rt.get(agentId);
}

export const getGame = (id) => db.games.find((g) => g.id === id);
export const getAgent = (id) => db.agents.find((a) => a.id === id);
export const getAccount = (id) => db.accounts.find((a) => a.id === id);
const gameAgents = (gameId) => db.agents.filter((a) => a.gameId === gameId);
const gameTasks = (gameId) => db.tasks.filter((t) => t.gameId === gameId).sort((a, b) => a.num - b.num);
const openTasks = (gameId) => gameTasks(gameId).filter((t) => t.status === 'open');
const heldTask = (agentId) => db.tasks.find((t) => t.claimedBy === agentId && t.status === 'claimed');
const heldTasks = (agentId) => db.tasks.filter((t) => t.claimedBy === agentId && t.status === 'claimed');
const isLimited = (acct) => !!(acct?.limitedUntil && acct.limitedUntil > Date.now());
const isPaused = (game) => game?.status === 'paused';

// Highest utilization across the account's limit windows (session, weekly, per-model), 0..1.
export function utilization(acct) {
  const windows = Object.values(acct?.usage?.windows || {});
  return windows.length ? Math.max(...windows.map((w) => w?.utilization || 0)) : 0;
}
// Autopilot keeps its hands off accounts close to a limit; director messages still go through.
const overGuard = (acct) => utilization(acct) * 100 >= (db.settings.limitGuardPct || 95);
const agentName = (id) => getAgent(id)?.name || 'someone';
const director = () => db.settings.directorName || 'Director';
export const directorName = director;

function must(value, message) {
  if (!value) throw Object.assign(new Error(message), { status: 400 });
  return value;
}

function agentStatus(agent) {
  const r = R(agent.id);
  if (r.setup || remote.isDispatching(agent.id)) return 'setup';
  if (r.child || agent.cloud) return 'running';
  if (getGame(agent.gameId)?.runner === 'cloud' && !agent.cloudLink) return 'unlinked';
  if (isLimited(getAccount(agent.accountId))) return 'limited';
  if (r.queue.length) return 'queued';
  if (r.error) return 'error';
  if (r.paused) return 'paused';
  return 'idle';
}

export function publicState() {
  return {
    settings: db.settings,
    platform: process.platform,
    claudePath: claude.resolveClaude(),
    home: paths.state.replace(/state\.json$/, ''),
    fileKey: db.secrets.fileKey,
    accounts: db.accounts.map((a) => ({ ...a, running: accountLoad(a.id), limited: isLimited(a), guarded: overGuard(a), probing: probing.has(a.id), syncing: cloud.isSyncing(a.id) })),
    cloudArtifacts: db.cloudArtifacts,
    cloudIndex: db.cloudIndex,
    inbox: db.inbox,
    deptNotes: db.deptNotes,
    targets: db.targets,
    usageReports: db.usageReports.slice(-20),
    disciplines: review.DISCIPLINES.map(({ id, label }) => ({ id, label })),
    games: db.games,
    agents: db.agents.map((a) => {
      const r = R(a.id);
      return { ...a, status: agentStatus(a), queue: r.queue.length, error: r.error, startedAt: r.child ? r.startedAt : a.cloud?.since || null };
    }),
    // Older records predate disciplines; derive one so department tabs can file them.
    tasks: db.tasks.map((t) => (t.discipline ? t : { ...t, discipline: review.disciplineOf(t.title) })),
    builds: db.builds.slice(-300),
    artifacts: db.artifacts.map((a) => (a.discipline ? a : { ...a, discipline: review.disciplineOf(a.title) })),
  };
}

// ---------------------------------------------------------------------------
// Feed + transcripts

export function feedPost(gameId, entry) {
  const e = { id: uid('f'), ts: Date.now(), ...entry };
  appendJsonl(feedFile(gameId), e);
  bus.emit('event', { type: 'feed', gameId, entry: e });
  return e;
}

export const readFeed = (gameId, limit = 300) => readJsonlTail(feedFile(gameId), limit);
export const readTranscript = (agentId, limit = 500) => readJsonlTail(transcriptFile(agentId), limit);

function tx(agent, entry) {
  const e = { ts: Date.now(), ...entry };
  appendJsonl(transcriptFile(agent.id), e);
  bus.emit('event', { type: 'tx', agentId: agent.id, entry: e });
}

// ---------------------------------------------------------------------------
// Accounts

export async function addAccount({ name, useDefault }) {
  name = name?.trim() || `Account ${db.accounts.length + 1}`;
  if (useDefault && db.accounts.some((a) => a.isDefault)) throw Object.assign(new Error("This computer's default Claude login is already added."), { status: 400 });
  let s = slug(name);
  for (let i = 2; db.accounts.some((a) => a.slug === s); i++) s = `${slug(name)}-${i}`;
  const acct = {
    id: uid('acc'),
    name,
    slug: s,
    isDefault: !!useDefault,
    configDir: useDefault ? path.join(os.homedir(), '.claude') : path.join(paths.accounts, s),
    env: {},
    loggedIn: false,
    createdAt: Date.now(),
  };
  if (!acct.isDefault) fs.mkdirSync(acct.configDir, { recursive: true });
  db.accounts.push(acct);
  save();
  changed();
  await refreshAccount(acct.id);
  return acct;
}

export async function refreshAccount(id) {
  const acct = must(getAccount(id), 'Unknown account');
  const s = await claude.authStatus(acct);
  Object.assign(acct, {
    loggedIn: !!s.loggedIn,
    email: s.email || null,
    plan: s.subscriptionType || null,
    org: s.orgName || null,
    authMethod: s.authMethod || null,
    checkedAt: Date.now(),
  });
  save();
  changed();
  return acct;
}

export function loginAccount(id) {
  const acct = must(getAccount(id), 'Unknown account');
  const res = claude.openTerminal({ account: acct, commandArgs: ['auth', 'login'], title: `Ballast login - ${acct.name}` });
  let polls = 0;
  const timer = setInterval(async () => {
    polls++;
    const before = acct.email;
    await refreshAccount(acct.id).catch(() => {});
    if ((acct.loggedIn && acct.email !== before) || polls > 72) clearInterval(timer);
  }, 5000);
  return res;
}

export function updateAccount(id, patch) {
  const acct = must(getAccount(id), 'Unknown account');
  if (patch.name?.trim()) acct.name = patch.name.trim();
  if (patch.maxConcurrent !== undefined) acct.maxConcurrent = Math.max(1, Number(patch.maxConcurrent) || 1);
  if (patch.clearLimit) acct.limitedUntil = null;
  save();
  changed();
  pump();
  return acct;
}

export function removeAccount(id) {
  must(getAccount(id), 'Unknown account');
  if (db.agents.some((a) => a.accountId === id)) throw Object.assign(new Error('Remove this account’s agents from its games first.'), { status: 400 });
  db.accounts = db.accounts.filter((a) => a.id !== id);
  save();
  changed();
}

// ---------------------------------------------------------------------------
// Games

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// runner "local": agents run on this PC in `repoPath`. runner "cloud": agents run as Claude
// Code cloud sessions on the GitHub repo `github`; Ballast keeps its own clone for builds.
export async function createGame({ name, repoPath, isolation = 'worktree', brief = '', permissionMode, model, accountIds = [], survey = true, runner = 'local', github, baseBranch }) {
  must(name?.trim(), 'Give the game a name.');
  const cloudRun = runner === 'cloud';
  let repo = null;
  let fresh = false;
  let repoIsGit = false;
  if (cloudRun) {
    must(github?.trim(), 'Give the GitHub repo (owner/name or URL).');
    isolation = 'cloud';
  } else {
    must(repoPath?.trim(), 'Choose a repo folder.');
    repo = path.resolve(repoPath.trim());
    fresh = !fs.existsSync(repo) || fs.readdirSync(repo).length === 0;
    if (fresh) await git.initRepo(repo);
    repoIsGit = await git.isRepo(repo);
    if (isolation === 'worktree' && !repoIsGit) isolation = 'shared';
    if (isolation === 'worktree' && !(await git.hasCommits(repo))) {
      throw Object.assign(new Error('That repo has no commits yet. Commit once, or pick shared mode.'), { status: 400 });
    }
  }

  let s = slug(name);
  for (let i = 2; db.games.some((g) => g.slug === s); i++) s = `${slug(name)}-${i}`;
  const game = {
    id: uid('game'),
    name: name.trim(),
    slug: s,
    runner: cloudRun ? 'cloud' : 'local',
    repoPath: repo,
    isolation,
    integrationBranch: 'ballast/integration',
    baseBranch: cloudRun ? baseBranch?.trim() || null : repoIsGit ? await git.currentBranch(repo).catch(() => null) : null,
    brief,
    briefRev: 1,
    permissionMode: permissionMode || 'bypassPermissions',
    model: model || '',
    effort: '',
    autopilot: true,
    status: 'active',
    priority: 2,
    claimBatch: 2, // tasks an agent claims at once
    coordinatorFile: '', // repo file where the coordinating agent records each note's breakdown
    briefSuggestion: '',
    leadAgentId: null,
    noteSeq: 0,
    taskSeq: 0,
    autoTurns: { day: '', count: 0 },
    build: { command: '', outputPath: '', checkins: [], timeoutMin: 120, shareDir: '', webhookUrl: '', agentReport: false, fired: {} },
    createdAt: Date.now(),
  };
  if (cloudRun) await remote.prepareClone(game, github);
  if (isolation === 'worktree') await git.ensureBranch(repo, game.integrationBranch, 'HEAD');
  db.games.push(game);
  save();
  feedPost(game.id, {
    kind: 'system',
    text: cloudRun
      ? `Linked to github.com/${game.github} (${game.baseBranch}). Agents run as Claude cloud sessions and deliver pull requests; Ballast's copy for builds is ${game.repoPath}.`
      : fresh
        ? `New project started at ${repo}.`
        : `Linked to ${repo} (${isolation === 'worktree' ? `one git worktree per agent, landing on ${game.integrationBranch}` : 'all agents share the working tree'}).`,
  });
  for (const accountId of accountIds) await addAgent(game.id, { accountId });
  // An existing project gets surveyed first so the board and brief reflect where it really is.
  if (!fresh && survey && gameAgents(game.id).length) surveyGame(game.id);
  changed();
  return game;
}

export function surveyGame(id) {
  const game = must(getGame(id), 'Unknown game');
  const lead = must(pickTriager(game), 'Add an agent to this game first.');
  enqueue(lead, { kind: 'survey', prompt: P.survey({ game }) }, { front: true });
  feedPost(id, { kind: 'system', text: `${lead.name} is surveying the project: current state, a suggested brief, and starting board tasks.` });
}

export function updateGame(id, patch) {
  const game = must(getGame(id), 'Unknown game');
  if (patch.claimBatch !== undefined) game.claimBatch = Math.min(5, Math.max(1, Number(patch.claimBatch) || 1));
  for (const key of ['name', 'permissionMode', 'model', 'effort', 'leadAgentId', 'coordinatorFile']) {
    if (patch[key] !== undefined) game[key] = typeof patch[key] === 'string' ? patch[key].trim() : patch[key];
  }
  if (patch.autopilot !== undefined) {
    game.autopilot = !!patch.autopilot;
    if (game.autopilot) wakeIdle(game.id);
  }
  if (patch.priority !== undefined) game.priority = Math.min(3, Math.max(1, Number(patch.priority) || 2));
  if (patch.status && patch.status !== game.status) {
    game.status = patch.status === 'paused' ? 'paused' : 'active';
    feedPost(game.id, { kind: 'system', text: game.status === 'paused' ? 'Game paused. Agents finish their current turn; queued work waits.' : 'Game resumed.' });
    if (game.status === 'active') setTimeout(() => { pump(); wakeIdle(game.id); }, 100);
  }
  if (patch.review) review.setGamePolicy(game, patch.review);
  if (patch.acceptBriefSuggestion && game.briefSuggestion) patch.brief = game.briefSuggestion;
  if (patch.acceptBriefSuggestion || patch.dismissBriefSuggestion) game.briefSuggestion = '';
  if (patch.brief !== undefined && patch.brief !== game.brief) {
    game.brief = patch.brief;
    game.briefRev = (game.briefRev || 1) + 1;
    feedPost(game.id, { kind: 'system', text: 'Game brief updated. Agents get the new brief with their next message.' });
  }
  if (patch.build) {
    const b = patch.build;
    for (const key of ['command', 'outputPath', 'shareDir', 'webhookUrl']) if (b[key] !== undefined) game.build[key] = String(b[key]).trim();
    if (b.timeoutMin !== undefined) game.build.timeoutMin = Math.max(1, Number(b.timeoutMin) || 120);
    if (b.agentReport !== undefined) game.build.agentReport = !!b.agentReport;
    if (b.checkins !== undefined) {
      const list = (Array.isArray(b.checkins) ? b.checkins : String(b.checkins).split(/[\s,]+/))
        .map((t) => t.trim()).filter(Boolean);
      const bad = list.filter((t) => !TIME_RE.test(t));
      if (bad.length) throw Object.assign(new Error(`Check-in times must look like 09:00 (got ${bad.join(', ')}).`), { status: 400 });
      game.build.checkins = [...new Set(list.map((t) => t.padStart(5, '0')))].sort();
    }
  }
  save();
  changed();
  return game;
}

export function removeGame(id) {
  must(getGame(id), 'Unknown game');
  for (const agent of gameAgents(id)) stopAgent(agent.id);
  db.agents = db.agents.filter((a) => a.gameId !== id);
  db.tasks = db.tasks.filter((t) => t.gameId !== id);
  db.games = db.games.filter((g) => g.id !== id);
  save();
  changed();
}

// ---------------------------------------------------------------------------
// Agents

export async function addAgent(gameId, { accountId, name, role }) {
  const game = must(getGame(gameId), 'Unknown game');
  const acct = must(getAccount(accountId), 'Pick an account for the agent.');
  const siblings = gameAgents(gameId);
  const sameAcct = siblings.filter((a) => a.accountId === accountId).length;
  let base = name?.trim() || (sameAcct ? `${acct.name}-${sameAcct + 1}` : acct.name);
  for (let i = 2; siblings.some((a) => a.name === base || a.slug === slug(base)); i++) base = `${name?.trim() || acct.name}-${i}`;

  const agent = {
    id: uid('ag'),
    gameId,
    accountId,
    name: base,
    slug: slug(base),
    role: role?.trim() || '',
    sessionId: null,
    cwd: game.repoPath,
    branch: null,
    costUsd: 0,
    turns: 0,
    briefRevSeen: game.briefRev,
    createdAt: Date.now(),
  };
  db.agents.push(agent);
  if (!game.leadAgentId) game.leadAgentId = agent.id;
  save();

  if (game.isolation === 'worktree') {
    const r = R(agent.id);
    r.setup = true;
    changed();
    try {
      agent.branch = `ballast/${agent.slug}`;
      const wt = path.join(git.worktreeRoot(game.repoPath), agent.slug);
      await git.ensureWorktree(game.repoPath, wt, agent.branch, game.integrationBranch);
      agent.cwd = wt;
    } catch (err) {
      r.error = `Worktree setup failed: ${err.message}`;
    } finally {
      r.setup = false;
      save();
    }
  }
  feedPost(gameId, { kind: 'system', text: `${agent.name} joined on ${acct.name}${acct.email ? ` (${acct.email})` : ''}, working in ${agent.cwd}.` });
  changed();
  pump();
  return agent;
}

export function updateAgent(id, patch) {
  const agent = must(getAgent(id), 'Unknown agent');
  if (patch.name?.trim()) agent.name = patch.name.trim();
  if (patch.role !== undefined) agent.role = patch.role.trim();
  save();
  changed();
  return agent;
}

export function removeAgent(id) {
  const agent = must(getAgent(id), 'Unknown agent');
  stopAgent(id);
  releaseTasks(agent, `${agent.name} was removed`);
  db.agents = db.agents.filter((a) => a.id !== id);
  const game = getGame(agent.gameId);
  if (game?.leadAgentId === id) game.leadAgentId = gameAgents(game.id)[0]?.id || null;
  feedPost(agent.gameId, { kind: 'system', text: `${agent.name} left the game. Its worktree stays on disk.` });
  save();
  changed();
}

export function resetAgent(id) {
  const agent = must(getAgent(id), 'Unknown agent');
  must(!R(id).child, 'Stop the agent before starting a new session.');
  agent.sessionId = null;
  R(id).error = null;
  tx(agent, { kind: 'system', text: 'Session reset. The next message starts a fresh Claude session.' });
  save();
  changed();
}

// Stopping also pauses: autopilot leaves the agent alone until the director messages it
// (or presses Wake). Its claimed task goes back on the board for the others.
export function stopAgent(id) {
  const r = R(id);
  r.queue = [];
  r.paused = true;
  const agent = getAgent(id);
  if (agent?.cloud) remote.forget(agent, 'stopped by the director');
  if (agent && !r.child) releaseTasks(agent, `${agent.name} was stopped`);
  if (r.child) {
    r.stopped = true;
    claude.killTree(r.child);
  }
  changed();
}

export function openAgentTerminal(id) {
  const agent = must(getAgent(id), 'Unknown agent');
  // Cloud agents live on claude.ai; the UI opens the session page instead.
  if (getGame(agent.gameId)?.runner === 'cloud') {
    const url = agent.cloud?.url || agent.lastCloud?.url;
    must(url, 'This agent has no cloud session yet.');
    return { opened: false, url };
  }
  must(!R(id).child, 'Stop the agent first; two processes on one session would collide.');
  const acct = getAccount(agent.accountId);
  return claude.openTerminal({
    account: acct,
    cwd: agent.cwd,
    commandArgs: agent.sessionId ? ['--resume', agent.sessionId] : [],
    title: `Ballast - ${agent.name}`,
  });
}

// ---------------------------------------------------------------------------
// Existing Claude Code sessions (bring an old game's conversations into Ballast)

// Claude Code keeps each folder's sessions in <config>/projects/<path with non-alphanumerics as "-">.
const projectsDir = (acct) => path.join(acct.configDir, 'projects');
const encodeProject = (dir) => path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-');

function sessionTitle(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(96 * 1024);
    const text = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
    let summary = null;
    let first = null;
    for (const line of text.split('\n')) {
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'summary' && m.summary) summary = m.summary;
      if (!first && m.type === 'user' && !m.isMeta) {
        const c = m.message?.content;
        const t = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x) => x.type === 'text')?.text : null;
        if (t && !t.startsWith('<')) first = t;
      }
    }
    return (summary || first || '(no prompt text)').replace(/\s+/g, ' ').slice(0, 160);
  } catch {
    return '(unreadable)';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function listSessions(agentId) {
  const agent = must(getAgent(agentId), 'Unknown agent');
  const acct = getAccount(agent.accountId);
  const game = getGame(agent.gameId);
  const dirs = [...new Set([game.repoPath, agent.cwd].map((d) => path.join(projectsDir(acct), encodeProject(d))))];
  const out = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      const st = fs.statSync(file);
      out.push({ sessionId: f.slice(0, -6), dir, title: sessionTitle(file), updatedAt: st.mtimeMs, size: st.size, current: f.slice(0, -6) === agent.sessionId });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40);
}

export function adoptSession(agentId, { sessionId, dir }) {
  const agent = must(getAgent(agentId), 'Unknown agent');
  must(!R(agentId).child, 'Stop the agent before switching sessions.');
  const acct = getAccount(agent.accountId);
  must(/^[\w-]+$/.test(sessionId || ''), 'Bad session id');
  const src = path.join(dir, `${sessionId}.jsonl`);
  must(path.resolve(dir).startsWith(path.resolve(projectsDir(acct))) && fs.existsSync(src), 'Session not found for this account.');
  // Resume looks in the agent's own folder, so copy the conversation there (the original stays put).
  const destDir = path.join(projectsDir(acct), encodeProject(agent.cwd));
  if (path.resolve(destDir) !== path.resolve(dir)) {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, path.join(destDir, `${sessionId}.jsonl`));
    const extras = path.join(dir, sessionId);
    if (fs.existsSync(extras)) fs.cpSync(extras, path.join(destDir, sessionId), { recursive: true });
  }
  Object.assign(agent, { sessionId, forkNext: true });
  R(agentId).error = null;
  tx(agent, { kind: 'system', text: `Adopted existing session ${sessionId.slice(0, 8)}: ${sessionTitle(src)}. The next message continues it as a fork.` });
  save();
  changed();
  return agent;
}

// ---------------------------------------------------------------------------
// Director notes

export function saveAttachment(gameId, { name, data }) {
  must(getGame(gameId), 'Unknown game');
  must(data, 'Empty attachment');
  const dir = attachmentsDir(gameId);
  fs.mkdirSync(dir, { recursive: true });
  const safe = path.basename(String(name || 'file')).replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
  const file = `${Date.now().toString(36)}-${safe}`;
  fs.writeFileSync(path.join(dir, file), Buffer.from(data, 'base64'));
  return { name: safe, path: path.join(dir, file), url: `/files/attachments/${gameId}/${encodeURIComponent(file)}` };
}

// `source` is 'director' for notes typed in Ballast, 'studio' for cross-game notes and
// 'review' for feedback pulled from claude.ai artifacts.
export function postNote(gameId, { text = '', target = 'all', attachments = [], from = director(), source = 'director' }) {
  const game = must(getGame(gameId), 'Unknown game');
  text = text.trim();
  must(text || attachments.length, 'Write a note first.');

  if (target !== 'all') {
    const agent = must(getAgent(target), 'Unknown agent');
    must(agent.gameId === gameId, 'That agent is on another game.');
    feedPost(gameId, { kind: 'note', from, to: agent.name, toAgentId: agent.id, source, text, attachments });
    enqueue(agent, { kind: 'message', direct: true, text, prompt: P.direct({ text, director: from, attachments }) });
    return;
  }

  if (game.runner === 'cloud') {
    // Cloud sessions can't triage through Ballast's board tools, so Ballast splits the note itself.
    const note = { num: ++game.noteSeq, text, attachments, source };
    save();
    feedPost(gameId, { kind: 'note', num: note.num, from, source, text, attachments });
    if (attachments.length) feedPost(gameId, { kind: 'system', text: 'Cloud sessions can’t open files on this PC; attachments stay with the note here.' });
    remote.triage(game, note).catch((err) => feedPost(gameId, { kind: 'error', text: `Triage failed: ${err.message}` })).finally(() => wakeIdle(gameId));
    return;
  }

  const note = { num: ++game.noteSeq, text, attachments, source };
  save();
  feedPost(gameId, { kind: 'note', num: note.num, from, source, text, attachments });
  if (isPaused(game)) feedPost(gameId, { kind: 'system', text: 'This game is paused; the note runs when you resume it.' });
  const triager = pickTriager(game);
  if (!triager) {
    feedPost(gameId, { kind: 'system', text: 'No agents on this game yet. Add one from the Agents tab, then send the note again.' });
    return;
  }
  feedPost(gameId, { kind: 'system', text: `${triager.name} is coordinating note #${note.num} (most usage headroom right now): breaking it into tasks for everyone.` });
  enqueue(triager, { kind: 'triage', note, prompt: P.triage({ note, director: from, coordinatorFile: game.coordinatorFile }) }, { front: true });
}

// Cleans up a Director Review speech transcript before it's sent: fixes words the browser
// misheard, using the game's own vocabulary, without changing what the director meant.
const TIDY_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' }, changes: { type: 'string', description: 'One short line listing the main corrections.' } },
  required: ['text'],
};

export async function tidyTranscript(gameId, { text = '' }) {
  const game = must(getGame(gameId), 'Unknown game');
  must(String(text).trim(), 'The transcript is empty.');
  const acct = db.accounts.filter((a) => a.loggedIn && !isLimited(a)).sort((a, b) => utilization(a) - utilization(b))[0];
  must(acct, 'No logged-in account has usage free right now.');
  const vocab = [...new Set(gameTasks(gameId).slice(-80).map((t) => t.title.replace(/^\s*\[[^\]]+\]\s*/, '')))].join('; ');
  const { result } = await claude.runQuick({
    account: acct,
    args: ['--model', db.settings.triageModel || 'sonnet', '--tools', 'Read', '--json-schema', JSON.stringify(TIDY_SCHEMA)],
    prompt: `Tidy a speech-recognition transcript of a game director talking while playing "${game.name}".
The browser's speech recognition mishears words, splits sentences and repeats itself. Fix that:
- Correct words that were clearly misheard, using the game's own vocabulary below (character, place, item and mechanic names). "work moment" is usually "mark moment".
- Drop filler ("um", "okay so", "like") and accidental repeats; join broken sentences.
- Keep every [mm:ss] timestamp at the start of its line and every ★ marker line.
- Keep the director's meaning, opinions and wording for anything about look and feel. Never add feedback that isn't there; if a phrase is unclear, leave it as it is.

Game brief: ${game.brief?.trim().slice(0, 1500) || '(none)'}
Vocabulary from the board: ${vocab.slice(0, 4000) || '(none)'}

Transcript:
${String(text).slice(0, 30000)}`,
  });
  if (result) recordUsage({ account: acct, gameId, kind: 'triage', result });
  const out = result?.structured_output;
  must(out?.text, 'The tidy-up run returned nothing; the original transcript is unchanged.');
  return { text: out.text, changes: out.changes || '' };
}

// One note to several games at once (studio-wide direction, shared tech, art style...).
export function studioNote({ gameIds = [], text = '', attachments = [] }) {
  const targets = (gameIds.length ? gameIds : db.games.map((g) => g.id)).filter((id) => getGame(id));
  must(targets.length, 'Pick at least one game.');
  for (const id of targets) postNote(id, { text, attachments, source: 'studio' });
  return { sent: targets.length };
}

export function saveStudioAttachment({ name, data }) {
  must(data, 'Empty attachment');
  fs.mkdirSync(paths.studioAttachments, { recursive: true });
  const safe = path.basename(String(name || 'file')).replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
  const file = `${Date.now().toString(36)}-${safe}`;
  fs.writeFileSync(path.join(paths.studioAttachments, file), Buffer.from(data, 'base64'));
  return { name: safe, path: path.join(paths.studioAttachments, file), url: `/files/studio/${encodeURIComponent(file)}` };
}

// The coordinator for a note is whoever has the most usage headroom right now (an idle
// agent first); the lead only breaks ties. Cloud agents need a connected session.
export function pickTriager(game, exclude) {
  const lead = (a) => (a.id === game.leadAgentId ? -0.001 : 0);
  const agents = gameAgents(game.id).filter((a) => a.id !== exclude && (game.runner !== 'cloud' || a.cloudLink))
    .sort((a, b) => (utilization(getAccount(a.accountId)) + lead(a)) - (utilization(getAccount(b.accountId)) + lead(b)));
  const usable = agents.filter((a) => !isLimited(getAccount(a.accountId)));
  const idle = usable.filter((a) => !R(a.id).child && !R(a.id).queue.length && !R(a.id).setup && !a.cloud);
  return idle[0] || usable[0] || agents[0] || null;
}

// ---------------------------------------------------------------------------
// Dispatch

function enqueue(agent, item, { front = false, noPump = false } = {}) {
  const r = R(agent.id);
  if (item.kind === 'next' && r.queue.some((q) => q.kind === 'next')) return;
  if (item.kind !== 'next' && item.kind !== 'nudge') r.paused = false; // a real message un-pauses
  else if (r.paused) return;
  if (front) r.queue.unshift(item);
  else r.queue.push(item);
  changed();
  if (!noPump) pump();
}

// Consecutive plain messages merge into one turn so a burst of notes costs one turn.
function takeBatch(r) {
  const first = r.queue.shift();
  if (!BATCHABLE.has(first.kind)) return first;
  const items = [first];
  while (r.queue.length && BATCHABLE.has(r.queue[0].kind) && !!r.queue[0].direct === !!first.direct) items.push(r.queue.shift());
  const real = items.filter((i) => i.kind !== 'next');
  if (!real.length) return first;
  if (real.length === 1) return real[0];
  return { kind: real.some((i) => i.kind === 'note') ? 'note' : 'message', direct: !!first.direct, prompt: real.map((i) => i.prompt).join('\n\n---\n\n') };
}

// When accounts are contended, higher-priority games get the free slots first.
// Paused games only run messages the director sent straight to one agent.
export function pump() {
  const priority = (agent) => getGame(agent.gameId)?.priority ?? 2;
  const ordered = [...db.agents].sort((a, b) => priority(b) - priority(a));
  for (const agent of ordered) {
    const r = R(agent.id);
    if (r.child || r.setup || !r.queue.length || remote.isDispatching(agent.id)) continue;
    const game = getGame(agent.gameId);
    if (isPaused(game) && !r.queue[0].direct) continue;
    // A cloud agent with a live session takes direct messages as follow-ups; everything else waits.
    if (agent.cloud) {
      if (r.queue[0].direct) cloudFollowUp(agent, r.queue.shift());
      continue;
    }
    const acct = getAccount(agent.accountId);
    if (!acct || isLimited(acct)) continue;
    const max = acct.maxConcurrent || db.settings.maxConcurrentPerAccount || 2;
    if (accountLoad(acct.id) >= max) continue;
    if (game.runner === 'cloud' && !agent.cloudLink) continue; // shown as "needs session"
    if (game.runner === 'cloud') remote.dispatch(agent, r.queue.shift()).then(() => pump());
    else startTurn(agent, acct, takeBatch(r));
  }
}

async function cloudFollowUp(agent, item) {
  try {
    await remote.message(agent, item.text);
    tx(agent, { kind: 'system', text: `Sent to the cloud session: ${item.text.slice(0, 200)}` });
  } catch (err) {
    feedPost(agent.gameId, { kind: 'error', from: agent.name, agentId: agent.id, text: `Couldn't reach the cloud session: ${err.message}` });
  }
}

// Cloud agents are handed a task by Ballast instead of claiming one themselves.
export function claimForAgent(agent) {
  // Tasks assigned to this agent come first; tasks assigned to someone else are off limits.
  const open = openTasks(agent.gameId).filter((t) => !t.assignee || t.assignee === agent.id)
    .sort((a, b) => (b.assignee === agent.id) - (a.assignee === agent.id));
  const role = agent.role?.toLowerCase().split(/[^a-z]+/).filter(Boolean) || [];
  const fit = open.find((t) => t.assignee === agent.id) || open.find((t) => role.some((w) => t.title.toLowerCase().includes(w))) || open[0];
  if (!fit) return null;
  Object.assign(fit, { status: 'claimed', claimedBy: agent.id, claimedAt: Date.now(), updatedAt: Date.now() });
  save();
  changed();
  return fit;
}

export function setAgentError(id, error) {
  R(id).error = error;
  changed();
}

function writeAgentFiles(agent, game) {
  const dir = path.join(paths.agents, agent.id);
  fs.mkdirSync(dir, { recursive: true });
  const teammates = gameAgents(game.id).filter((a) => a.id !== agent.id);
  const sysFile = path.join(dir, 'system-prompt.md');
  fs.writeFileSync(sysFile, P.systemPrompt({ game, agent, teammates }));
  const mcpFile = path.join(dir, 'mcp.json');
  fs.writeFileSync(mcpFile, JSON.stringify({
    mcpServers: {
      ballast: {
        type: 'stdio',
        command: process.execPath,
        args: [MCP_SERVER],
        env: { BALLAST_URL: runtime.baseUrl, BALLAST_AGENT_ID: agent.id, BALLAST_KEY: db.secrets.agentKey },
      },
    },
  }, null, 2));
  return { sysFile, mcpFile };
}

function startTurn(agent, acct, item) {
  const game = getGame(agent.gameId);
  const r = R(agent.id);
  Object.assign(r, { error: null, item, startedAt: Date.now(), stopped: false, result: null, lastText: '' });

  if (!fs.existsSync(agent.cwd)) {
    r.error = `Working folder is missing: ${agent.cwd}`;
    tx(agent, { kind: 'error', text: r.error });
    changed();
    return;
  }

  let prompt = item.prompt;
  if (agent.sessionId && (agent.briefRevSeen || 0) < game.briefRev && game.brief?.trim()) prompt = P.briefUpdate(game.brief) + prompt;
  if (item.lost) prompt = P.sessionLost() + prompt;
  agent.briefRevSeen = game.briefRev;

  const attachDir = attachmentsDir(game.id);
  fs.mkdirSync(attachDir, { recursive: true });
  const { sysFile, mcpFile } = writeAgentFiles(agent, game);
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', game.permissionMode || 'bypassPermissions',
    '--append-system-prompt-file', sysFile,
    '--mcp-config', mcpFile,
    '--add-dir', attachDir, paths.studioAttachments,
    '--allowedTools', 'mcp__ballast',
  ];
  if (game.model) args.push('--model', game.model);
  if (game.effort) args.push('--effort', game.effort);
  if (agent.sessionId) {
    args.push('--resume', agent.sessionId);
    // An adopted session is forked on first use so the original conversation stays untouched.
    if (agent.forkNext) {
      args.push('--fork-session');
      agent.forkNext = false;
    }
  } else args.push('--session-id', crypto.randomUUID(), '--name', `Ballast · ${game.name} · ${agent.name}`);

  acctRunning.set(acct.id, (acctRunning.get(acct.id) || 0) + 1);
  tx(agent, { kind: 'prompt', itemKind: item.kind, text: prompt });
  const { child, done } = claude.runTurn({
    args,
    cwd: agent.cwd,
    env: claude.accountEnv(acct, { BALLAST_AGENT_ID: agent.id }),
    prompt,
    onMessage: (msg) => onMessage(agent, acct, msg),
  });
  r.child = child;
  changed();
  done.then((res) => finishTurn(agent, acct, item, res));
}

function summarizeTool(name, input = {}) {
  const short = name.replace(/^mcp__ballast__/, 'ballast.').replace(/^mcp__/, '');
  const detail =
    input.command || input.file_path || input.path || input.pattern || input.description ||
    input.title || input.url || input.query || (input.task_id ? `#${input.task_id}` : '') || input.text || '';
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return { name: short, detail: text.replace(/\s+/g, ' ').slice(0, 220) };
}

function onMessage(agent, acct, msg) {
  const r = R(agent.id);
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        if (agent.sessionId !== msg.session_id) {
          agent.sessionId = msg.session_id;
          save();
        }
        tx(agent, { kind: 'system', text: `Session ${msg.session_id?.slice(0, 8)} · ${msg.model || ''} · ${msg.permissionMode || ''}` });
      }
      break;
    case 'assistant':
      if (msg.parent_tool_use_id) break;
      for (const c of msg.message?.content || []) {
        if (c.type === 'text' && c.text.trim()) {
          r.lastText = c.text;
          tx(agent, { kind: 'text', text: c.text });
        } else if (c.type === 'tool_use') {
          tx(agent, { kind: 'tool', ...summarizeTool(c.name, c.input) });
        }
      }
      break;
    case 'user':
      if (msg.parent_tool_use_id || !Array.isArray(msg.message?.content)) break;
      for (const c of msg.message.content) {
        if (c.type !== 'tool_result') continue;
        const text = typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text || `[${x.type}]`).join('\n');
        tx(agent, { kind: 'tool_result', ok: !c.is_error, text: text.slice(0, 800) });
      }
      break;
    case 'rate_limit_event':
      updateUsage(acct, msg.rate_limit_info || {});
      break;
    case 'result':
      r.result = msg;
      break;
  }
}

// Called with every rate_limit_event: the server's own view of the session (five_hour),
// weekly (seven_day) and any per-model windows for this account.
export function updateUsage(acct, info) {
  acct.usage = {
    status: info.status,
    type: info.rateLimitType,
    resetsAt: info.resetsAt,
    windows: info.unifiedWindows || {},
    overage: info.isUsingOverage ? 'using' : info.overageStatus || null,
    updatedAt: Date.now(),
  };
  if (info.status === 'rejected') markLimited(acct, (info.resetsAt || 0) * 1000 || Date.now() + 3600e3, 'usage limit');
  save();
  changed();
}

// Local turns plus cloud sessions: both draw on the same account limits.
function accountLoad(id) {
  return (acctRunning.get(id) || 0) + db.agents.filter((a) => a.accountId === id && (a.cloud || remote.isDispatching(a.id))).length;
}
// The next scheduled check-in build today or tomorrow, as { time: "12:00", minutes }.
export function nextDelivery(game) {
  const times = game?.build?.checkins || [];
  if (!times.length) return null;
  const now = new Date();
  const slots = times.flatMap((t) => [0, 1].map((day) => {
    const [h, m] = t.split(':').map(Number);
    return { time: t, at: new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, h, m).getTime() };
  })).filter((s) => s.at > now.getTime()).sort((a, b) => a.at - b.at);
  return slots[0] ? { time: slots[0].time, at: slots[0].at, minutes: Math.round((slots[0].at - now.getTime()) / 60e3) } : null;
}

export const isAccountBusy =(id) => accountLoad(id) > 0;

// Limits only arrive with a model call, so an idle account gets a one-word probe on a
// small model to keep its session/weekly numbers current (about a fifth of a cent).
const probing = new Set();
export async function probeAccount(id) {
  const acct = must(getAccount(id), 'Unknown account');
  if (probing.has(id)) return acct;
  probing.add(id);
  changed();
  try {
    const { result, stderr } = await claude.runQuick({
      account: acct,
      args: ['--model', 'haiku', '--tools', 'Read'],
      prompt: 'Reply with just: ok',
      onMessage: (msg) => { if (msg.type === 'rate_limit_event') updateUsage(acct, msg.rate_limit_info || {}); },
    });
    if (result) recordUsage({ account: acct, kind: 'probe', result });
    acct.usage = { ...(acct.usage || {}), probedAt: Date.now() };
    if (!result && /not logged in|\/login|authenticat/i.test(stderr)) acct.loggedIn = false;
    save();
  } finally {
    probing.delete(id);
    changed();
  }
  return acct;
}

const LIMIT_RE =/usage limit|rate.?limit|limit reached|out of (extra )?usage|\b429\b/i;

function finishTurn(agent, acct, item, res) {
  const r = R(agent.id);
  acctRunning.set(acct.id, Math.max(0, (acctRunning.get(acct.id) || 1) - 1));
  r.child = null;
  r.item = null;
  const { result, stopped } = r;
  const game = getGame(agent.gameId);
  if (!getAgent(agent.id) || !game) {
    changed();
    pump();
    return;
  }

  agent.turns = (agent.turns || 0) + 1;
  agent.lastActive = Date.now();
  if (result) {
    recordUsage({ account: acct, gameId: game.id, agentId: agent.id, kind: 'agent', result });
    agent.costUsd = (agent.costUsd || 0) + (result.total_cost_usd || 0);
    tx(agent, {
      kind: 'result',
      ok: !result.is_error,
      text: result.result || '',
      cost: result.total_cost_usd,
      durationMs: result.duration_ms,
      steps: result.num_turns,
    });
  }

  if (stopped) {
    tx(agent, { kind: 'system', text: 'Stopped by the director. Autopilot leaves this agent alone until you message it.' });
    releaseTasks(agent, `${agent.name} was stopped`);
  } else if (!result || result.is_error) {
    const text = String((result?.is_error && result.result) || res.stderr || `claude exited with code ${res.code}`).trim();
    if (/no conversation found|session .*not found/i.test(text) && !item.lost) {
      agent.sessionId = null;
      r.queue.unshift({ ...item, lost: true });
      tx(agent, { kind: 'system', text: 'Previous session is gone; starting a fresh one.' });
    } else if (LIMIT_RE.test(text)) {
      const epoch = text.match(/\|(\d{10})\b/);
      markLimited(acct, epoch ? Number(epoch[1]) * 1000 : Date.now() + 3600e3, text.slice(0, 200));
      const other = item.kind === 'triage' ? pickTriager(game, agent.id) : null;
      if (other && !isLimited(getAccount(other.accountId))) enqueue(other, item, { front: true, noPump: true });
      else if (item.kind !== 'next') r.queue.unshift(item);
    } else {
      if (/not logged in|invalid api key|\/login|authenticat/i.test(text)) acct.loggedIn = false;
      r.error = text.slice(-600);
      tx(agent, { kind: 'error', text: r.error });
      feedPost(game.id, { kind: 'error', from: agent.name, agentId: agent.id, text: `Turn failed: ${text.slice(0, 400)}` });
    }
  } else {
    const out = (result.result || r.lastText || '').trim();
    if (out) feedPost(game.id, { kind: 'agent', from: agent.name, agentId: agent.id, accountId: acct.id, itemKind: item.kind, text: out });
  }

  if (isLimited(acct)) releaseTasks(agent, `${acct.name} hit its usage limit`);
  save();
  if (!stopped) afterTurn(agent, game, item, !!(result && !result.is_error));
  changed();
  pump();
}

function afterTurn(agent, game, item, ok) {
  if (item.kind === 'triage') {
    const taskNums = gameTasks(game.id).filter((t) => t.noteNum === item.note.num).map((t) => t.num);
    for (const a of gameAgents(game.id)) {
      enqueue(a, { kind: 'note', prompt: P.noteBroadcast({ note: item.note, director: director(), taskNums }) }, { noPump: true });
    }
    return;
  }
  if (!ok) return; // never auto-continue after a failure; that's how loops start

  const held = heldTask(agent.id);
  if (held) {
    if (item.kind === 'nudge') {
      Object.assign(held, { status: 'blocked', blockReason: 'Agent ended its turn twice without finishing.', updatedAt: Date.now() });
      feedPost(game.id, { kind: 'task', from: agent.name, agentId: agent.id, text: `Blocked #${held.num} ${held.title}: ended its turn without finishing.` });
      save();
    } else if (game.autopilot && !(held.nudges > 0)) {
      held.nudges = 1;
      enqueue(agent, { kind: 'nudge', prompt: P.nudge({ task: held }) }, { noPump: true });
    }
    return;
  }

  if (isPaused(game) || overGuard(getAccount(agent.accountId))) return;
  if (game.autopilot && !R(agent.id).queue.length && openTasks(game.id).length && autopilotBudget(game)) {
    enqueue(agent, { kind: 'next', prompt: P.nextTask({ openCount: openTasks(game.id).length, batch: game.claimBatch || 1 }) }, { noPump: true });
  }
}

function autopilotBudget(game) {
  const day = new Date().toDateString();
  if (game.autoTurns?.day !== day) game.autoTurns = { day, count: 0, warned: false };
  const limit = db.settings.autopilotDailyTurns || 150;
  if (game.autoTurns.count >= limit) {
    if (!game.autoTurns.warned) {
      game.autoTurns.warned = true;
      feedPost(game.id, { kind: 'system', text: `Autopilot paused: ${limit} automatic turns today. Send a note or press Wake to continue.` });
    }
    return false;
  }
  game.autoTurns.count++;
  save();
  return true;
}

// Hands open work to idle agents. `force` is the Wake button: ignores autopilot and budget.
export function wakeIdle(gameId, force = false) {
  const game = getGame(gameId);
  if (!game || isPaused(game) || (!force && !game.autopilot)) return 0;
  let open = openTasks(gameId).length;
  let woken = 0;
  // Freshest accounts first, so work drains toward whoever has the most headroom.
  const agents = gameAgents(gameId).sort((a, b) => utilization(getAccount(a.accountId)) - utilization(getAccount(b.accountId)));
  for (const a of agents) {
    if (open <= 0) break;
    const r = R(a.id);
    if (r.child || r.queue.length || r.setup || heldTask(a.id) || a.cloud || remote.isDispatching(a.id)) continue;
    if (game.runner === 'cloud' && !a.cloudLink) continue; // nothing to send tasks to yet
    const acct = getAccount(a.accountId);
    if (isLimited(acct) || (!force && overGuard(acct))) continue;
    if (r.paused && !force) continue;
    if (force) r.paused = false;
    if (!force && !autopilotBudget(game)) break;
    enqueue(a, { kind: 'next', prompt: P.nextTask({ openCount: openTasks(gameId).length, batch: game.claimBatch || 1 }) }, { noPump: true });
    open -= game.claimBatch || 1; // each woken agent claims a batch
    woken++;
  }
  pump();
  return woken;
}

function releaseTasks(agent, why) {
  const released = db.tasks.filter((t) => t.claimedBy === agent.id && t.status === 'claimed');
  for (const t of released) Object.assign(t, { status: 'open', claimedBy: null, nudges: 0, updatedAt: Date.now(), note: `Released: ${why}` });
  if (released.length) {
    feedPost(agent.gameId, { kind: 'system', text: `${why}; ${released.map((t) => `#${t.num}`).join(', ')} went back on the board.` });
    save();
    setTimeout(() => wakeIdle(agent.gameId), 1000);
  }
}

function markLimited(acct, until, reason) {
  const was = isLimited(acct);
  acct.limitedUntil = Math.max(acct.limitedUntil || 0, until);
  acct.limitReason = reason;
  for (const a of db.agents.filter((x) => x.accountId === acct.id)) if (!R(a.id).child) releaseTasks(a, `${acct.name} hit its usage limit`);
  if (!was) {
    const at = new Date(acct.limitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    for (const gameId of new Set(db.agents.filter((a) => a.accountId === acct.id).map((a) => a.gameId))) {
      feedPost(gameId, { kind: 'system', text: `${acct.name} is out of usage until about ${at}. Other accounts keep going.` });
    }
  }
  save();
  changed();
}

export function checkLimits() {
  for (const acct of db.accounts) {
    if (!acct.limitedUntil || acct.limitedUntil > Date.now()) continue;
    acct.limitedUntil = null;
    save();
    for (const gameId of new Set(db.agents.filter((a) => a.accountId === acct.id).map((a) => a.gameId))) {
      feedPost(gameId, { kind: 'system', text: `${acct.name} has usage again.` });
      wakeIdle(gameId);
    }
    changed();
    pump();
  }
}

// ---------------------------------------------------------------------------
// Board

function createTask(game, { title, detail = '', createdBy, noteNum = null, assignee = null }) {
  const t = {
    id: uid('t'),
    gameId: game.id,
    num: ++game.taskSeq,
    title: must(String(title || '').trim(), 'A task needs a title.').slice(0, 200),
    detail: String(detail || '').trim(),
    status: 'open',
    claimedBy: null,
    createdBy,
    noteNum,
    assignee: assignee && getAgent(assignee)?.gameId === game.id ? assignee : null,
    discipline: review.disciplineOf(title),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.tasks.push(t);
  save();
  changed();
  return t;
}

export function addTask(gameId, { title, detail, noteNum = null, createdBy = director(), assignee = null }) {
  const game = must(getGame(gameId), 'Unknown game');
  const t = createTask(game, { title, detail, createdBy, noteNum, assignee });
  setTimeout(() => wakeIdle(gameId), 300);
  return t;
}

export function updateTask(id, patch) {
  const t = must(db.tasks.find((x) => x.id === id), 'Unknown task');
  if (patch.title?.trim()) t.title = patch.title.trim();
  if (patch.detail !== undefined) t.detail = patch.detail;
  if (patch.summary !== undefined) t.summary = patch.summary;
  if (patch.blockReason !== undefined) t.blockReason = patch.blockReason;
  if (patch.status && patch.status !== t.status) {
    t.status = patch.status;
    if (patch.status === 'open') Object.assign(t, { claimedBy: null, nudges: 0, blockReason: null });
    if (patch.status === 'open') setTimeout(() => wakeIdle(t.gameId), 300);
    if (patch.status === 'done') Object.assign(t, { doneAt: Date.now(), doneBy: patch.doneBy || t.claimedBy || null });
  }
  t.updatedAt = Date.now();
  save();
  changed();
  return t;
}

export function removeTask(id) {
  db.tasks = db.tasks.filter((t) => t.id !== id);
  save();
  changed();
}

// ---------------------------------------------------------------------------
// Tools agents call through the ballast MCP server

export async function agentApi(agentId, tool, args = {}) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('This agent is no longer registered in Ballast.');
  const game = getGame(agent.gameId);
  const r = R(agent.id);
  const byNum = (n) => {
    const num = Number(String(n ?? '').replace('#', ''));
    return must(gameTasks(game.id).find((t) => t.num === num), `No task #${n} on this board.`);
  };
  const line = (t) => `#${t.num} [${t.status}${t.claimedBy ? ` by ${agentName(t.claimedBy)}` : ''}${t.assignee && !t.claimedBy ? ` for ${agentName(t.assignee)}` : ''}] ${t.title}`;
  const indent = (s) => s.replace(/\n/g, '\n    ');

  switch (tool) {
    case 'board_list': {
      const all = gameTasks(game.id);
      const status = args.status || 'active';
      const list = status === 'all' ? all
        : status === 'active' ? [...all.filter((t) => t.status !== 'done'), ...all.filter((t) => t.status === 'done').slice(-8)]
        : all.filter((t) => t.status === status);
      if (!list.length) return 'The board is empty.';
      return list.map((t) => {
        let s = line(t);
        if (t.status !== 'done' && t.detail) s += `\n    ${indent(t.detail)}`;
        if (t.summary) s += `\n    done: ${indent(t.summary)}`;
        if (t.blockReason) s += `\n    blocked: ${t.blockReason}`;
        return s;
      }).join('\n');
    }
    case 'board_add': {
      const noteNum = r.item?.kind === 'triage' ? r.item.note.num : null;
      const t = createTask(game, { title: args.title, detail: args.detail, createdBy: agent.name, noteNum });
      if (!noteNum) setTimeout(() => wakeIdle(game.id), 500);
      return `Added #${t.num}: ${t.title}`;
    }
    case 'board_claim': {
      const t = byNum(args.task_id);
      if (t.claimedBy === agent.id && t.status === 'claimed') return `You already hold #${t.num}.`;
      if (t.status !== 'open') throw new Error(`#${t.num} is ${t.status}${t.claimedBy ? ` by ${agentName(t.claimedBy)}` : ''}. Pick another open task.`);
      if (t.assignee && t.assignee !== agent.id) throw new Error(`#${t.num} is for ${agentName(t.assignee)}. Pick another open task.`);
      const held = heldTasks(agent.id);
      const limit = game.claimBatch || 1;
      if (held.length >= limit) throw new Error(`You already hold ${held.map((h) => `#${h.num}`).join(', ')} (the limit is ${limit}). Finish one (board_done) or give one back (board_block) first.`);
      Object.assign(t, { status: 'claimed', claimedBy: agent.id, claimedAt: Date.now(), updatedAt: Date.now(), nudges: 0 });
      save();
      changed();
      const discipline = t.discipline || review.disciplineOf(t.title);
      const policy = review.policyFor(game, discipline);
      // Working in a department means picking up that department's waiting notes too.
      const note = deptnotes.pickFor(agent, game, discipline);
      const refs = targets.forTask({ ...t, discipline }, game);
      return `Claimed #${t.num}: ${t.title}${t.detail ? `\n${t.detail}` : ''}\n\n${P.reviewRuleLocal({ task: t, game, policy })}\n${P.deliveryLine(nextDelivery(game))}${refs.length ? `\n\n${P.targetsLocal(targets.describe(refs, { local: true }))}` : ''}${note ? `\n\n${P.deptNoteLocal({ note, label: deptnotes.label(discipline), ref: deptnotes.ref(note), taskNum: t.num })}` : ''}`;
    }
    case 'board_done': {
      const t = byNum(args.task_id);
      if (t.claimedBy && t.claimedBy !== agent.id) throw new Error(`#${t.num} belongs to ${agentName(t.claimedBy)}.`);
      Object.assign(t, { summary: String(args.summary || '').trim(), doneBy: agent.id, claimedBy: agent.id, doneAt: Date.now(), updatedAt: Date.now() });
      t.status = review.onFinished(t, game);
      const parked = t.status === 'review';
      feedPost(game.id, { kind: 'task', from: agent.name, agentId: agent.id, text: `${parked ? 'Ready for review' : 'Done'} #${t.num} ${t.title}${t.summary ? `\n${t.summary}` : ''}` });
      save();
      changed();
      const open = openTasks(game.id).length;
      return `${parked ? `#${t.num} is waiting for the director's approval; don't land it. Ballast tells you when it's approved.` : `Marked #${t.num} done.`}${open ? ` ${open} open task(s) remain on the board: take the next one.` : ' Nothing else is open.'}`;
    }
    case 'reference_targets': {
      const held = heldTask(agent.id);
      let list = db.targets.filter((x) => x.gameId === game.id);
      if (args.discipline) list = list.filter((x) => x.discipline === args.discipline);
      if (args.subject) list = targets.forTask({ title: args.subject, discipline: args.discipline || held?.discipline || 'art' }, game);
      else if (!args.discipline && held) list = targets.forTask(held, game);
      return list.length ? `Quality targets (open the files with Read):\n${targets.describe(list, { local: true })}` : 'No quality targets for that yet.';
    }
    case 'task_dept_note': {
      const created = deptnotes.taskNote(deptnotes.find(game, args.note_id), args.tasks, agent.name);
      setTimeout(() => wakeIdle(game.id), 500);
      return `Note is TASKED: ${created.map((t) => `#${t.num} ${t.title}`).join('; ')}. They're on the board for the whole team; carry on with your own task.`;
    }
    case 'ask_director': {
      // A capture makes a look-and-feel question answerable at a glance.
      const artifactIds = [];
      if (args.screenshot) {
        try {
          publishArtifact(agent, game, { path: args.screenshot, title: `Question: ${String(args.question || '').slice(0, 80)}` });
          artifactIds.push(db.artifacts.at(-1).id);
        } catch { /* the question still goes in without it */ }
      }
      const q = inbox.ask({ game, agent, question: args.question, context: args.context, options: args.options, assumption: args.assumption, artifactIds, task: heldTask(agent.id) });
      return `Added to the Director's Inbox (${q.id}). Don't wait for the answer: go ahead with your assumption${q.assumption ? ` ("${q.assumption.slice(0, 120)}")` : ''}. The answer comes to you as a message.`;
    }
    case 'board_block': {
      const t = byNum(args.task_id);
      if (t.claimedBy && t.claimedBy !== agent.id) throw new Error(`#${t.num} belongs to ${agentName(t.claimedBy)}.`);
      Object.assign(t, { status: 'blocked', blockReason: String(args.reason || '').trim(), claimedBy: null, updatedAt: Date.now() });
      feedPost(game.id, { kind: 'task', from: agent.name, agentId: agent.id, text: `Blocked #${t.num} ${t.title}: ${t.blockReason}` });
      save();
      changed();
      return `#${t.num} is blocked. The director will see it.`;
    }
    case 'post_update': {
      feedPost(game.id, { kind: 'update', from: agent.name, agentId: agent.id, text: must(String(args.text || '').trim(), 'Empty update') });
      return 'Posted to the director feed.';
    }
    case 'publish_artifact':
      if (args.url && !args.path && args.content == null) {
        const tracked = cloud.track({ url: args.url, gameId: game.id, accountId: agent.accountId, role: 'output', title: args.title, addedBy: agent.name });
        feedPost(game.id, { kind: 'artifact', from: agent.name, agentId: agent.id, cloudId: tracked.id, text: `${tracked.title}\n${tracked.url}${args.description ? `\n${args.description}` : ''}` });
        return `Tracking ${tracked.url} on the director's artifact shelf. Ballast re-reads it and its comments on every sync.`;
      }
      return publishArtifact(agent, game, args);
    case 'claude_artifacts':
      return cloud.listForAgent(game.id);
    case 'read_claude_artifact':
      return cloud.readForAgent(game.id, String(args.url || ''));
    case 'suggest_brief': {
      game.briefSuggestion = must(String(args.text || '').trim(), 'Empty brief');
      feedPost(game.id, { kind: 'update', from: agent.name, agentId: agent.id, text: `Suggested a game brief (Settings → Use suggestion):\n${game.briefSuggestion}` });
      save();
      changed();
      return 'Saved as a suggestion. The director decides whether to use it.';
    }
    case 'read_notes': {
      const notes = readFeed(game.id, 2000).filter((e) => e.kind === 'note').slice(-(Number(args.limit) || 5));
      if (!notes.length) return 'No director notes yet.';
      return notes.map((n) => `${n.num ? `#${n.num}` : `(to ${n.to})`} ${new Date(n.ts).toLocaleString()}\n${n.text}`).join('\n\n');
    }
    default:
      throw new Error(`Unknown Ballast tool: ${tool}`);
  }
}

// ---------------------------------------------------------------------------
// Artifacts

const KINDS = [
  [/\.(html?)$/i, 'html'],
  [/\.(md|markdown)$/i, 'markdown'],
  [/\.(png|jpe?g|gif|webp|svg|bmp)$/i, 'image'],
  [/\.(mp4|webm|mov)$/i, 'video'],
  [/\.(mp3|wav|ogg)$/i, 'audio'],
  [/\.(txt|json|csv|log|ya?ml|cs|js|ts|py|shader|hlsl|xml)$/i, 'text'],
];
const kindOf = (file) => KINDS.find(([re]) => re.test(file))?.[1] || 'file';

function dirSize(dir, budget = { files: 0, bytes: 0 }) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) dirSize(full, budget);
    else {
      budget.files++;
      budget.bytes += fs.statSync(full).size;
    }
    if (budget.files > 2000 || budget.bytes > 500e6) throw new Error('That folder is too big to publish (over 2000 files or 500 MB).');
  }
  return budget;
}

function publishArtifact(agent, game, args) {
  const id = uid('art');
  const dir = path.join(paths.artifacts, game.id, id);
  let entry;
  if (args.path) {
    const src = path.resolve(agent.cwd, String(args.path));
    must(fs.existsSync(src), `Nothing at ${src}`);
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      dirSize(src);
      fs.cpSync(src, dir, { recursive: true });
      entry = fs.existsSync(path.join(dir, 'index.html')) ? 'index.html' : fs.readdirSync(dir).find((f) => fs.statSync(path.join(dir, f)).isFile());
      must(entry, 'That folder has no files at its top level.');
    } else {
      must(st.size < 500e6, 'That file is over 500 MB.');
      fs.mkdirSync(dir, { recursive: true });
      entry = path.basename(src);
      fs.copyFileSync(src, path.join(dir, entry));
    }
  } else if (args.content != null) {
    fs.mkdirSync(dir, { recursive: true });
    entry = path.basename(String(args.filename || `${slug(args.title || 'artifact')}.md`)).replace(/[^\w.\-]+/g, '_');
    fs.writeFileSync(path.join(dir, entry), String(args.content));
  } else {
    throw new Error('Pass either `path` (a file or folder) or `content` with a `filename`.');
  }
  const task = heldTask(agent.id);
  const art = {
    id,
    gameId: game.id,
    agentId: agent.id,
    agentName: agent.name,
    title: String(args.title || entry).slice(0, 160),
    description: String(args.description || '').trim(),
    kind: kindOf(entry),
    entry,
    // Department tabs group media by discipline; default to the task the agent is on.
    discipline: review.DISCIPLINES.some((d) => d.id === args.discipline) ? args.discipline : task?.discipline || review.disciplineOf(args.title),
    taskId: task?.id || null,
    createdAt: Date.now(),
  };
  db.artifacts.push(art);
  save();
  changed();
  feedPost(game.id, { kind: 'artifact', from: agent.name, agentId: agent.id, artifactId: id, text: `${art.title}${art.description ? `\n${art.description}` : ''}` });
  return `Published "${art.title}" (${art.kind}) to the director's artifact shelf.`;
}

// Captures a cloud agent committed on its branch (pulled by remote.mjs) join the shelf like
// anything a local agent publishes, filed under the task's discipline.
export function addMediaArtifact({ game, agent, task, name, data }) {
  const id = uid('art');
  const dir = path.join(paths.artifacts, game.id, id);
  fs.mkdirSync(dir, { recursive: true });
  const entry = path.basename(name).replace(/[^\w.\-]+/g, '_');
  fs.writeFileSync(path.join(dir, entry), data);
  db.artifacts.push({
    id,
    gameId: game.id,
    agentId: agent.id,
    agentName: agent.name,
    title: task ? `#${task.num} ${entry}` : entry,
    description: task ? task.title : '',
    kind: kindOf(entry),
    entry,
    discipline: task?.discipline || review.disciplineOf(task?.title || ''),
    taskId: task?.id || null,
    createdAt: Date.now(),
  });
  save();
  changed();
}

export function removeArtifact(id) {
  const art = must(db.artifacts.find((a) => a.id === id), 'Unknown artifact');
  fs.rmSync(path.join(paths.artifacts, art.gameId, art.id), { recursive: true, force: true });
  db.artifacts = db.artifacts.filter((a) => a.id !== id);
  save();
  changed();
}

// ---------------------------------------------------------------------------
// Hooks for the scheduler + lifecycle

export function requestCheckinReport(gameId, build, time) {
  const game = getGame(gameId);
  if (!game || game.runner === 'cloud') return; // a cloud session per report would be wasteful
  const lead = getAgent(game.leadAgentId) || gameAgents(gameId)[0];
  if (lead) enqueue(lead, { kind: 'message', prompt: P.checkinReport({ build, time }) });
}

export async function init() {
  // Local turns don't survive a restart, so their claimed work goes back on the board.
  // Cloud sessions keep running on claude.ai, so their tasks stay claimed.
  const cloudHeld = new Set(db.agents.filter((a) => a.cloud).flatMap((a) => (a.cloud.items || [a.cloud]).map((i) => i.taskId)).filter(Boolean));
  for (const t of db.tasks) {
    if (t.status === 'claimed' && !cloudHeld.has(t.id)) Object.assign(t, { status: 'open', claimedBy: null, nudges: 0, note: 'Released: Ballast restarted' });
  }
  save();
  await Promise.all(db.accounts.map((a) => refreshAccount(a.id).catch(() => {})));
}

export function shutdown() {
  for (const r of rt.values()) if (r.child) claude.killTree(r.child);
}
