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
const isLimited = (acct) => !!(acct?.limitedUntil && acct.limitedUntil > Date.now());
const agentName = (id) => getAgent(id)?.name || 'someone';
const director = () => db.settings.directorName || 'Director';

function must(value, message) {
  if (!value) throw Object.assign(new Error(message), { status: 400 });
  return value;
}

function agentStatus(agent) {
  const r = R(agent.id);
  if (r.setup) return 'setup';
  if (r.child) return 'running';
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
    accounts: db.accounts.map((a) => ({ ...a, running: acctRunning.get(a.id) || 0, limited: isLimited(a) })),
    games: db.games,
    agents: db.agents.map((a) => {
      const r = R(a.id);
      return { ...a, status: agentStatus(a), queue: r.queue.length, error: r.error, startedAt: r.child ? r.startedAt : null };
    }),
    tasks: db.tasks,
    builds: db.builds.slice(-300),
    artifacts: db.artifacts,
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

export async function createGame({ name, repoPath, isolation = 'worktree', brief = '', permissionMode, model, accountIds = [] }) {
  must(name?.trim(), 'Give the game a name.');
  must(repoPath?.trim(), 'Choose a repo folder.');
  const repo = path.resolve(repoPath.trim());
  const fresh = !fs.existsSync(repo) || fs.readdirSync(repo).length === 0;
  if (fresh) await git.initRepo(repo);
  const repoIsGit = await git.isRepo(repo);
  if (isolation === 'worktree' && !repoIsGit) isolation = 'shared';
  if (isolation === 'worktree' && !(await git.hasCommits(repo))) {
    throw Object.assign(new Error('That repo has no commits yet. Commit once, or pick shared mode.'), { status: 400 });
  }

  let s = slug(name);
  for (let i = 2; db.games.some((g) => g.slug === s); i++) s = `${slug(name)}-${i}`;
  const game = {
    id: uid('game'),
    name: name.trim(),
    slug: s,
    repoPath: repo,
    isolation,
    integrationBranch: 'ballast/integration',
    baseBranch: repoIsGit ? await git.currentBranch(repo).catch(() => null) : null,
    brief,
    briefRev: 1,
    permissionMode: permissionMode || 'bypassPermissions',
    model: model || '',
    effort: '',
    autopilot: true,
    leadAgentId: null,
    noteSeq: 0,
    taskSeq: 0,
    autoTurns: { day: '', count: 0 },
    build: { command: '', outputPath: '', checkins: [], timeoutMin: 120, shareDir: '', webhookUrl: '', agentReport: false, fired: {} },
    createdAt: Date.now(),
  };
  if (isolation === 'worktree') await git.ensureBranch(repo, game.integrationBranch, 'HEAD');
  db.games.push(game);
  save();
  feedPost(game.id, {
    kind: 'system',
    text: fresh
      ? `New project started at ${repo}.`
      : `Linked to ${repo} (${isolation === 'worktree' ? `one git worktree per agent, landing on ${game.integrationBranch}` : 'all agents share the working tree'}).`,
  });
  for (const accountId of accountIds) await addAgent(game.id, { accountId });
  changed();
  return game;
}

export function updateGame(id, patch) {
  const game = must(getGame(id), 'Unknown game');
  for (const key of ['name', 'permissionMode', 'model', 'effort', 'leadAgentId']) {
    if (patch[key] !== undefined) game[key] = typeof patch[key] === 'string' ? patch[key].trim() : patch[key];
  }
  if (patch.autopilot !== undefined) {
    game.autopilot = !!patch.autopilot;
    if (game.autopilot) wakeIdle(game.id);
  }
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
  if (agent && !r.child) releaseTasks(agent, `${agent.name} was stopped`);
  if (r.child) {
    r.stopped = true;
    claude.killTree(r.child);
  }
  changed();
}

export function openAgentTerminal(id) {
  const agent = must(getAgent(id), 'Unknown agent');
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

export function postNote(gameId, { text = '', target = 'all', attachments = [] }) {
  const game = must(getGame(gameId), 'Unknown game');
  text = text.trim();
  must(text || attachments.length, 'Write a note first.');

  if (target !== 'all') {
    const agent = must(getAgent(target), 'Unknown agent');
    must(agent.gameId === gameId, 'That agent is on another game.');
    feedPost(gameId, { kind: 'note', from: director(), to: agent.name, toAgentId: agent.id, text, attachments });
    enqueue(agent, { kind: 'message', prompt: P.direct({ text, director: director(), attachments }) });
    return;
  }

  const note = { num: ++game.noteSeq, text, attachments };
  save();
  feedPost(gameId, { kind: 'note', num: note.num, from: director(), text, attachments });
  const triager = pickTriager(game);
  if (!triager) {
    feedPost(gameId, { kind: 'system', text: 'No agents on this game yet. Add one from the Agents tab, then send the note again.' });
    return;
  }
  enqueue(triager, { kind: 'triage', note, prompt: P.triage({ note, director: director() }) }, { front: true });
}

function pickTriager(game, exclude) {
  const agents = gameAgents(game.id).filter((a) => a.id !== exclude);
  const usable = agents.filter((a) => !isLimited(getAccount(a.accountId)));
  const idle = usable.filter((a) => !R(a.id).child && !R(a.id).queue.length && !R(a.id).setup);
  const lead = (list) => list.find((a) => a.id === game.leadAgentId);
  return lead(idle) || idle[0] || lead(usable) || usable[0] || agents[0] || null;
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
  while (r.queue.length && BATCHABLE.has(r.queue[0].kind)) items.push(r.queue.shift());
  const real = items.filter((i) => i.kind !== 'next');
  if (!real.length) return first;
  if (real.length === 1) return real[0];
  return { kind: real.some((i) => i.kind === 'note') ? 'note' : 'message', prompt: real.map((i) => i.prompt).join('\n\n---\n\n') };
}

export function pump() {
  for (const agent of db.agents) {
    const r = R(agent.id);
    if (r.child || r.setup || !r.queue.length) continue;
    const acct = getAccount(agent.accountId);
    if (!acct || isLimited(acct)) continue;
    const max = acct.maxConcurrent || db.settings.maxConcurrentPerAccount || 2;
    if ((acctRunning.get(acct.id) || 0) >= max) continue;
    startTurn(agent, acct, takeBatch(r));
  }
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
    '--add-dir', attachDir,
    '--allowedTools', 'mcp__ballast',
  ];
  if (game.model) args.push('--model', game.model);
  if (game.effort) args.push('--effort', game.effort);
  if (agent.sessionId) args.push('--resume', agent.sessionId);
  else args.push('--session-id', crypto.randomUUID(), '--name', `Ballast · ${game.name} · ${agent.name}`);

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

function updateUsage(acct, info) {
  acct.usage = {
    status: info.status,
    type: info.rateLimitType,
    resetsAt: info.resetsAt,
    fiveHour: info.unifiedWindows?.five_hour || null,
    sevenDay: info.unifiedWindows?.seven_day || null,
    updatedAt: Date.now(),
  };
  if (info.status === 'rejected') markLimited(acct, (info.resetsAt || 0) * 1000 || Date.now() + 3600e3, 'usage limit');
  save();
  changed();
}

const LIMIT_RE = /usage limit|rate.?limit|limit reached|out of (extra )?usage|\b429\b/i;

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

  if (game.autopilot && !R(agent.id).queue.length && openTasks(game.id).length && autopilotBudget(game)) {
    enqueue(agent, { kind: 'next', prompt: P.nextTask({ openCount: openTasks(game.id).length }) }, { noPump: true });
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
  if (!game || (!force && !game.autopilot)) return 0;
  let open = openTasks(gameId).length;
  let woken = 0;
  for (const a of gameAgents(gameId)) {
    if (open <= 0) break;
    const r = R(a.id);
    if (r.child || r.queue.length || r.setup || heldTask(a.id)) continue;
    if (isLimited(getAccount(a.accountId))) continue;
    if (r.paused && !force) continue;
    if (force) r.paused = false;
    if (!force && !autopilotBudget(game)) break;
    enqueue(a, { kind: 'next', prompt: P.nextTask({ openCount: openTasks(gameId).length }) }, { noPump: true });
    open--;
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

function createTask(game, { title, detail = '', createdBy, noteNum = null }) {
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.tasks.push(t);
  save();
  changed();
  return t;
}

export function addTask(gameId, { title, detail }) {
  const game = must(getGame(gameId), 'Unknown game');
  const t = createTask(game, { title, detail, createdBy: director() });
  setTimeout(() => wakeIdle(gameId), 300);
  return t;
}

export function updateTask(id, patch) {
  const t = must(db.tasks.find((x) => x.id === id), 'Unknown task');
  if (patch.title?.trim()) t.title = patch.title.trim();
  if (patch.detail !== undefined) t.detail = patch.detail;
  if (patch.status && patch.status !== t.status) {
    t.status = patch.status;
    if (patch.status === 'open') Object.assign(t, { claimedBy: null, nudges: 0, blockReason: null });
    if (patch.status === 'open') setTimeout(() => wakeIdle(t.gameId), 300);
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
  const line = (t) => `#${t.num} [${t.status}${t.claimedBy ? ` by ${agentName(t.claimedBy)}` : ''}] ${t.title}`;
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
      const held = heldTask(agent.id);
      if (held) throw new Error(`You still hold #${held.num}. Finish it (board_done) or give it back (board_block) first.`);
      Object.assign(t, { status: 'claimed', claimedBy: agent.id, claimedAt: Date.now(), updatedAt: Date.now(), nudges: 0 });
      save();
      changed();
      return `Claimed #${t.num}: ${t.title}${t.detail ? `\n${t.detail}` : ''}`;
    }
    case 'board_done': {
      const t = byNum(args.task_id);
      if (t.claimedBy && t.claimedBy !== agent.id) throw new Error(`#${t.num} belongs to ${agentName(t.claimedBy)}.`);
      Object.assign(t, { status: 'done', summary: String(args.summary || '').trim(), doneBy: agent.id, claimedBy: agent.id, doneAt: Date.now(), updatedAt: Date.now() });
      feedPost(game.id, { kind: 'task', from: agent.name, agentId: agent.id, text: `Done #${t.num} ${t.title}${t.summary ? `\n${t.summary}` : ''}` });
      save();
      changed();
      const open = openTasks(game.id).length;
      return `Marked #${t.num} done.${open ? ` ${open} open task(s) remain on the board.` : ' Nothing else is open.'}`;
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
      return publishArtifact(agent, game, args);
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
  const art = {
    id,
    gameId: game.id,
    agentId: agent.id,
    agentName: agent.name,
    title: String(args.title || entry).slice(0, 160),
    description: String(args.description || '').trim(),
    kind: kindOf(entry),
    entry,
    createdAt: Date.now(),
  };
  db.artifacts.push(art);
  save();
  changed();
  feedPost(game.id, { kind: 'artifact', from: agent.name, agentId: agent.id, artifactId: id, text: `${art.title}${art.description ? `\n${art.description}` : ''}` });
  return `Published "${art.title}" (${art.kind}) to the director's artifact shelf.`;
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
  const lead = game && (getAgent(game.leadAgentId) || gameAgents(gameId)[0]);
  if (lead) enqueue(lead, { kind: 'message', prompt: P.checkinReport({ build, time }) });
}

export async function init() {
  // Nothing survives a restart mid-turn, so claimed work goes back on the board.
  for (const t of db.tasks) {
    if (t.status === 'claimed') Object.assign(t, { status: 'open', claimedBy: null, nudges: 0, note: 'Released: Ballast restarted' });
  }
  save();
  await Promise.all(db.accounts.map((a) => refreshAccount(a.id).catch(() => {})));
}

export function shutdown() {
  for (const r of rt.values()) if (r.child) claude.killTree(r.child);
}
