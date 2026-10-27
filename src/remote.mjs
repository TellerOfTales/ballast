// Cloud runner: games whose agents run as Claude Code cloud sessions on a GitHub repo.
// Cloud sessions can't call back to Ballast, so Ballast does the coordinating itself:
// it triages notes locally, hands each agent exactly one task per session, and learns the
// outcome from the report file the agent pushes on its branch.
import fs from 'node:fs';
import path from 'node:path';
import { db, save, paths } from './store.mjs';
import { changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as git from './git.mjs';
import * as P from './prompts.mjs';
import { recordUsage } from './usage.mjs';
import * as orch from './orchestrator.mjs';
import * as review from './review.mjs';
import * as inbox from './inbox.mjs';

const dispatching = new Set(); // agentIds with a session being created
export const isDispatching = (agentId) => dispatching.has(agentId);

export const clonePath = (game) => path.join(paths.clones, game.slug);

// A cloud game always works from Ballast's own clone: the session starts from the remote,
// and Ballast force-checks-out the base branch there, so it must never be the user's checkout.
export async function prepareClone(game, githubInput) {
  const gh = git.parseGithub(githubInput);
  if (!gh) throw Object.assign(new Error('Give the GitHub repo as owner/name or its github.com URL.'), { status: 400 });
  const dir = clonePath(game);
  if (!fs.existsSync(path.join(dir, '.git'))) await git.cloneRepo(gh.url, dir);
  game.github = gh.slug;
  game.repoPath = dir;
  if (gh.subdir) game.subdir = gh.subdir;
  if (!game.baseBranch && gh.branch) game.baseBranch = gh.branch;
  if (!game.baseBranch) game.baseBranch = await git.git(dir, ['rev-parse', '--abbrev-ref', 'origin/HEAD']).then((r) => r.replace(/^origin\//, ''), () => 'main');
  await git.syncClone(dir, game.baseBranch);
}

function context(game, agent) {
  const notes = orch.readFeed(game.id, 400).filter((e) => e.kind === 'note' && !e.to).slice(-3);
  const others = db.tasks.filter((t) => t.gameId === game.id && t.status === 'claimed' && t.claimedBy !== agent.id);
  // GDD first: it's the source of truth the rest inherits from.
  const artifacts = db.cloudArtifacts.filter((a) => a.gameId === game.id && a.summary).sort((a, b) => (b.role === 'gdd') - (a.role === 'gdd'));
  return { notes, others, artifacts };
}

// ---------------------------------------------------------------------------
// Triage (runs locally: a small structured run, no repo access needed)

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          everyAgent: { type: 'boolean', description: 'True when the note asks each agent to do this themselves (e.g. "every agent should...").' },
        },
        required: ['title'],
      },
    },
  },
  required: ['tasks'],
};

export async function triage(game, note) {
  const acct = db.accounts.filter((a) => a.loggedIn && !(a.limitedUntil > Date.now()))
    .sort((a, b) => orch.utilization(a) - orch.utilization(b))[0];
  if (!acct) {
    orch.addTask(game.id, { title: note.text.split('\n')[0].slice(0, 120), detail: note.text, noteNum: note.num });
    orch.feedPost(game.id, { kind: 'system', text: 'No account free to triage; the note went on the board as one task.' });
    return;
  }
  const open = db.tasks.filter((t) => t.gameId === game.id && t.status !== 'done');
  const { result } = await claude.runQuick({
    account: acct,
    args: ['--model', db.settings.triageModel || 'sonnet', '--tools', 'Read', '--json-schema', JSON.stringify(TRIAGE_SCHEMA)],
    prompt: P.cloudTriage({ game, note, open, gdd: db.cloudArtifacts.filter((a) => a.gameId === game.id && a.role === 'gdd') }),
    onMessage: (m) => { if (m.type === 'rate_limit_event') orch.updateUsage(acct, m.rate_limit_info || {}); },
  });
  if (result) recordUsage({ account: acct, gameId: game.id, kind: 'triage', result });
  const out = result?.structured_output;
  if (!out) {
    orch.addTask(game.id, { title: note.text.split('\n')[0].slice(0, 120), detail: note.text, noteNum: note.num });
    orch.feedPost(game.id, { kind: 'error', text: 'Triage failed; the note went on the board as one task.' });
    return;
  }
  // "Every agent should..." becomes one task per agent, each assigned to its agent.
  const agents = db.agents.filter((a) => a.gameId === game.id);
  const nums = out.tasks.flatMap((t) => (t.everyAgent && agents.length > 1
    ? agents.map((a) => orch.addTask(game.id, { title: `${t.title} (${a.name})`, detail: t.detail, noteNum: note.num, createdBy: 'Ballast triage', assignee: a.id }).num)
    : [orch.addTask(game.id, { title: t.title, detail: t.detail, noteNum: note.num, createdBy: 'Ballast triage' }).num]));
  orch.feedPost(game.id, { kind: 'system', text: nums.length ? `Note #${note.num} split into ${nums.map((n) => `#${n}`).join(', ')}. ${out.summary || ''}` : `Note #${note.num}: already covered by the board. ${out.summary || ''}` });
}

// ---------------------------------------------------------------------------
// Dispatch

export async function dispatch(agent, item) {
  const game = orch.getGame(agent.gameId);
  const acct = orch.getAccount(agent.accountId);
  let task = null;
  let key;
  let prompt;
  if (item.kind === 'survey') {
    key = 'survey';
    prompt = P.cloudSurvey({ game, agent });
  } else if (item.kind === 'message') {
    key = `m${Date.now().toString(36)}`;
    prompt = P.cloudTask({ game, agent, key, task: { title: 'Message from the director', detail: item.text }, ...context(game, agent) });
  } else {
    task = orch.claimForAgent(agent);
    if (!task) return;
    key = `t${task.num}`;
    prompt = `${P.cloudTask({ game, agent, task, policy: review.policyFor(game, task.discipline || review.disciplineOf(task.title)), ...context(game, agent) })}\n- ${P.deliveryLine(orch.nextDelivery(game)) || 'Keep the base branch buildable whenever you merge.'}`;
  }

  dispatching.add(agent.id);
  changed();
  try {
    if (!agent.cloudLink) throw new Error('Connect a cloud session to this agent first (Agents tab).');
    await git.syncClone(game.repoPath, game.baseBranch);
    const baseline = await git.remoteHeads(game.repoPath);
    const { sessionId, url } = agent.cloudLink;
    await claude.sendCloudMessage({ account: acct, cwd: game.repoPath, sessionId, text: prompt });
    agent.cloud = { sessionId, url, key, taskId: task?.id || null, kind: item.kind, since: Date.now(), baseline };
    agent.turns = (agent.turns || 0) + 1;
    agent.lastActive = Date.now();
    orch.feedPost(game.id, { kind: 'system', text: `${agent.name} sent ${task ? `#${task.num} ${task.title}` : key === 'survey' ? 'the project survey' : 'your message'} to its cloud session: ${url}` });
  } catch (err) {
    if (task) orch.updateTask(task.id, { status: 'open' });
    orch.setAgentError(agent.id, err.message);
    orch.feedPost(game.id, { kind: 'error', from: agent.name, agentId: agent.id, text: `Couldn't start a cloud session: ${err.message}` });
  } finally {
    dispatching.delete(agent.id);
    save();
    changed();
  }
}

export function connect(agent, link) {
  if (!agent) throw Object.assign(new Error('Unknown agent'), { status: 400 });
  const parsed = claude.parseCloudSession(link);
  if (!parsed) throw Object.assign(new Error('Paste the session link from claude.ai/code (it contains session_… or cse_…).'), { status: 400 });
  agent.cloudLink = parsed;
  orch.setAgentError(agent.id, null);
  orch.feedPost(agent.gameId, { kind: 'system', text: `${agent.name} is connected to cloud session ${parsed.url}` });
  save();
  changed();
  setTimeout(() => orch.wakeIdle(agent.gameId), 300);
  return agent;
}

// Plain words only: the intro goes through a Windows .cmd file.
const plain = (s) => String(s).replace(/[^\w /.-]/g, '');
const introFor = (agent, game) =>
  `You are ${plain(agent.name)}, an agent Ballast coordinates on the game ${plain(game.name)}${game.subdir ? `. Work only inside the ${plain(game.subdir)} folder` : ''}. Tasks arrive later as follow-up messages. For now just reply ready and wait.`;

// The connector terminal writes each pasted link to a file; Ballast watches for them.
const pendingLinks = new Map(); // file -> agentId
let linkTimer = null;
let linkDeadline = 0;

function watchLinks() {
  linkDeadline = Date.now() + 60 * 60e3;
  if (linkTimer) return;
  linkTimer = setInterval(() => {
    for (const [file, agentId] of pendingLinks) {
      if (!fs.existsSync(file)) continue;
      const link = fs.readFileSync(file, 'utf8').trim();
      fs.rmSync(file, { force: true });
      pendingLinks.delete(file);
      const agent = orch.getAgent(agentId);
      try {
        connect(agent, link);
      } catch (err) {
        if (agent) orch.feedPost(agent.gameId, { kind: 'error', from: agent.name, agentId, text: `That link didn't work: ${err.message} Press Connect cloud sessions to try again.` });
      }
    }
    if (!pendingLinks.size || Date.now() > linkDeadline) {
      clearInterval(linkTimer);
      linkTimer = null;
      pendingLinks.clear();
    }
  }, 2000);
}

// Opens one terminal that creates a cloud session for each agent and asks for its link.
export function openConnector(game, agentIds = null) {
  if (!game) throw Object.assign(new Error('Unknown game'), { status: 400 });
  const agents = db.agents.filter((a) => a.gameId === game.id && (agentIds ? agentIds.includes(a.id) : !a.cloudLink));
  if (!agents.length) throw Object.assign(new Error('Every agent on this game already has a cloud session.'), { status: 400 });
  const steps = agents.map((agent) => {
    const acct = orch.getAccount(agent.accountId);
    const outFile = path.join(paths.tmp, `cloudlink-${agent.id}.txt`);
    fs.rmSync(outFile, { force: true });
    pendingLinks.set(outFile, agent.id);
    return { account: acct, label: `${agent.name} (${acct.email || acct.name})`, intro: introFor(agent, game), outFile };
  });
  watchLinks();
  const res = claude.openCloudConnector({ cwd: game.repoPath, steps, title: `Ballast - connect ${game.name}` });
  orch.feedPost(game.id, { kind: 'system', text: `Connecting ${agents.map((a) => a.name).join(', ')} to cloud sessions. In the terminal, paste each link it prints; Ballast picks them up on its own.` });
  return { ...res, agents: agents.map((a) => a.name) };
}

export async function message(agent, text) {
  const game = orch.getGame(agent.gameId);
  await claude.sendCloudMessage({ account: orch.getAccount(agent.accountId), cwd: game.repoPath, sessionId: agent.cloud.sessionId, text });
}

export function forget(agent, why) {
  if (!agent.cloud) return;
  const { url, taskId } = agent.cloud;
  agent.cloud = null;
  const task = db.tasks.find((t) => t.id === taskId);
  if (task?.status === 'claimed') orch.updateTask(task.id, { status: 'open' });
  orch.feedPost(agent.gameId, { kind: 'system', text: `${agent.name}: ${why}. The cloud session may still be running; stop it on claude.ai if needed: ${url}` });
  save();
  changed();
}

// ---------------------------------------------------------------------------
// Polling: find the report file each active session pushes on its branch

let polling = false;
export async function poll() {
  if (polling) return;
  polling = true;
  try {
    const timeout = (db.settings.cloudTaskTimeoutMin || 240) * 60e3;
    for (const game of db.games.filter((g) => g.runner === 'cloud')) {
      const active = db.agents.filter((a) => a.gameId === game.id && a.cloud);
      if (!active.length) continue;
      let heads;
      try {
        heads = await git.remoteHeads(game.repoPath);
      } catch (err) {
        game.cloudError = err.message.slice(0, 300);
        continue;
      }
      game.cloudError = null;
      for (const agent of active) {
        const { baseline = {}, key, since } = agent.cloud;
        const moved = Object.keys(heads).filter((b) => heads[b] !== baseline[b]);
        // Likely branches first: the suggested name, then anything new or updated since dispatch.
        moved.sort((a, b) => (b.includes(key) - a.includes(key)) || (b.startsWith('ballast/') - a.startsWith('ballast/')));
        const candidates = moved.slice(0, 12);
        let report = null;
        let branch = null;
        if (candidates.length) {
          await git.fetchBranches(game.repoPath, candidates).catch(() => {});
          for (const b of candidates) {
            report = await git.showRemoteFile(game.repoPath, b, P.reportPath(key, game.subdir));
            if (report) { branch = b; break; }
          }
        }
        if (report) await complete(game, agent, report, branch);
        else if (Date.now() - since > timeout) {
          const task = db.tasks.find((t) => t.id === agent.cloud.taskId);
          if (task) orch.updateTask(task.id, { status: 'blocked', blockReason: `No report from the cloud session after ${Math.round(timeout / 3600e3)}h: ${agent.cloud.url}` });
          orch.feedPost(game.id, { kind: 'error', from: agent.name, agentId: agent.id, text: `No report pushed after ${Math.round(timeout / 3600e3)}h; check the session: ${agent.cloud.url}` });
          agent.cloud = null;
          setTimeout(() => orch.wakeIdle(game.id), 500);
        }
      }
      save();
      changed();
    }
  } finally {
    polling = false;
  }
}

// "## Questions" lines in a report ("- question -> assumption") go to the Director's Inbox.
function reportQuestions(body) {
  const section = body.match(/##\s*Questions\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1] || '';
  return [...section.matchAll(/^\s*[-*]\s*(.+)$/gm)].map(([, line]) => {
    const [question, assumption = ''] = line.split(/\s*(?:->|→)\s*/);
    return { question: question.trim(), assumption: assumption.trim() };
  }).filter((q) => q.question);
}

// Screenshots, GIFs, video and audio the agent committed under .ballast/media/<key>/ on its
// branch become artifacts in the department tab for that task.
async function pullMedia(game, agent, task, branch, key) {
  const files = await git.listRemoteFiles(game.repoPath, branch, P.mediaPath(key, game.subdir)).catch(() => []);
  for (const file of files.slice(0, 40)) {
    const buf = await git.readRemoteBlob(game.repoPath, branch, file).catch(() => null);
    if (!buf || buf.length > 100e6) continue;
    orch.addMediaArtifact({ game, agent, task, name: path.posix.basename(file), data: buf });
  }
  return files.length;
}

async function complete(game, agent, report, branch) {
  const { taskId, url, key } = agent.cloud;
  const blocked = /^STATUS:\s*BLOCKED/im.test(report);
  const body = report.replace(/^STATUS:.*\n?/im, '').trim();
  const pr = body.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0];
  const task = db.tasks.find((t) => t.id === taskId);
  for (const q of reportQuestions(body)) inbox.ask({ game, agent, task, question: q.question, assumption: q.assumption, source: 'report' });
  const media = await pullMedia(game, agent, task, branch, key);
  if (key === 'survey') {
    const brief = body.match(/##\s*Brief\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1]?.trim();
    const tasks = [...(body.match(/##\s*Tasks\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1] || '').matchAll(/^\s*-\s*(.+?)(?::\s*(.+))?$/gm)];
    if (brief) game.briefSuggestion = brief;
    for (const [, title, detail] of tasks.slice(0, 8)) orch.addTask(game.id, { title: title.trim(), detail: detail?.trim() || '', createdBy: agent.name });
    orch.feedPost(game.id, { kind: 'agent', from: agent.name, agentId: agent.id, text: `Survey done (branch ${branch}).\n${body.slice(0, 3000)}` });
  } else if (task) {
    if (blocked) orch.updateTask(task.id, { status: 'blocked', blockReason: body.slice(0, 600) });
    else {
      Object.assign(task, { summary: `${body.slice(0, 800)}${pr ? '' : `\nBranch: ${branch}`}`, doneBy: agent.id, doneAt: Date.now(), branch });
      orch.updateTask(task.id, { status: review.onFinished(task, game, { pr }) });
    }
    const label = blocked ? 'Blocked' : task.status === 'review' ? 'Ready for review' : 'Done';
    orch.feedPost(game.id, { kind: 'task', from: agent.name, agentId: agent.id, text: `${label} #${task.num} ${task.title}${pr ? `\n${pr}` : `\nbranch ${branch}`}${media ? `\n${media} capture(s) attached` : ''}\n${body.slice(0, 600)}` });
  } else {
    orch.feedPost(game.id, { kind: 'agent', from: agent.name, agentId: agent.id, text: `${body.slice(0, 2000)}\n${pr || `branch ${branch}`}` });
  }
  agent.lastCloud = { url, branch, pr, at: Date.now() };
  agent.cloud = null;
  setTimeout(() => orch.wakeIdle(game.id), 500);
}
