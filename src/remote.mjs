// Cloud runner: games whose agents run as Claude Code cloud sessions on a GitHub repo.
// Cloud sessions can't call back to Ballast, so Ballast does the coordinating itself:
// it triages notes locally, hands each agent exactly one task per session, and learns the
// outcome from the report file the agent pushes on its branch.
import fs from 'node:fs';
import path from 'node:path';
import { db, save, paths, attachmentsDir, HOME } from './store.mjs';
import { changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as git from './git.mjs';
import * as P from './prompts.mjs';
import { recordUsage } from './usage.mjs';
import * as orch from './orchestrator.mjs';
import * as review from './review.mjs';
import * as inbox from './inbox.mjs';
import * as jungledocs from './jungledocs.mjs';
import * as loops from './loops.mjs';
import * as worksplit from './worksplit.mjs';
import * as gates from './gates.mjs';
import * as focus from './focus.mjs';
import * as gddedit from './gddedit.mjs';
import * as deptnotes from './deptnotes.mjs';
import * as targets from './targets.mjs';

const dispatching = new Set(); // agentIds with a session being created
export const isDispatching = (agentId) => dispatching.has(agentId);

export const clonePath = (game) => path.join(paths.clones, game.slug);

// A cloud game always works from Ballast's own clone: the session starts from the remote,
// and Ballast force-checks-out the base branch there, so it must never be the user's checkout.
export async function prepareClone(game, githubInput) {
  const gh = git.parseGithub(githubInput);
  if (!gh) throw Object.assign(new Error('Give the GitHub repo as owner/name or its github.com URL.'), { status: 400 });
  const dir = clonePath(game);
  // Another game on the same repo (several Game Packs in one project) lends its objects, so the clone is local.
  const sibling = db.games.find((g) => g.id !== game.id && g.github === gh.slug && g.repoPath && fs.existsSync(path.join(g.repoPath, '.git')));
  if (!fs.existsSync(path.join(dir, '.git'))) await git.cloneRepo(gh.url, dir, sibling?.repoPath);
  game.github = gh.slug;
  game.repoPath = dir;
  if (gh.subdir) game.subdir = gh.subdir;
  if (!game.baseBranch && gh.branch) game.baseBranch = gh.branch;
  // Ask GitHub what's really there: a typed or pasted branch may not exist, and repos don't
  // always use "main" (or have any commits yet).
  const { heads, defaultBranch } = await git.remoteBranches(dir);
  const names = Object.keys(heads);
  if (!names.length) throw Object.assign(new Error(`github.com/${gh.slug} has no branches yet. Push a first commit, then add the game.`), { status: 400 });
  if (!game.baseBranch) game.baseBranch = defaultBranch || names[0];
  // A folder link on a branch with slashes (/tree/claude/some-branch/game) reads as branch
  // "claude": take the longest real branch the link's path starts with.
  if (!heads[game.baseBranch] && gh.branch === game.baseBranch && gh.subdir) {
    const parts = gh.subdir.split('/');
    for (let i = parts.length; i > 0; i--) {
      const candidate = [gh.branch, ...parts.slice(0, i)].join('/');
      if (!heads[candidate]) continue;
      game.baseBranch = candidate;
      if (parts.length > i) game.subdir = parts.slice(i).join('/');
      else delete game.subdir;
      break;
    }
  }
  if (!heads[game.baseBranch]) {
    const list = [defaultBranch, ...names.filter((n) => n !== defaultBranch).sort()].filter(Boolean);
    const shown = list.slice(0, 12).map((n) => (n === defaultBranch ? `${n} (default)` : n)).join(', ');
    throw Object.assign(new Error(`github.com/${gh.slug} has no branch "${game.baseBranch}"${gh.branch === game.baseBranch && gh.subdir ? ` (or any branch the link's /tree/${gh.branch}/${gh.subdir} starts with)` : ''}. Its branches: ${shown}${list.length > 12 ? `, and ${list.length - 12} more` : ''}. Leave Base branch empty to use the default, or link to a folder with /tree/<branch>/<folder>.`), { status: 400 });
  }
  await git.syncClone(dir, game.baseBranch);
}

function context(game, agent) {
  const notes = orch.readFeed(game.id, 400).filter((e) => e.kind === 'note' && !e.to).slice(-3);
  const others = db.tasks.filter((t) => t.gameId === game.id && t.status === 'claimed' && t.claimedBy !== agent.id);
  // GDD first: it's the source of truth the rest inherits from.
  const artifacts = db.cloudArtifacts.filter((a) => a.gameId === game.id && a.summary).sort((a, b) => (b.role === 'gdd') - (a.role === 'gdd'));
  return { notes, others, artifacts, subagentLimit: game.subagentLimit ?? db.settings.subagentLimit ?? 4 };
}

// ---------------------------------------------------------------------------
// Triage (runs locally: a small structured run, no repo access needed)

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    covered: { type: 'array', items: { type: 'integer' }, description: 'When no new tasks are needed: the numbers of the board tickets that already cover the note.' },
    gddChange: { type: 'string', description: 'When the note changes the game\'s design (a rule, number, system, content or goal the GDD states): what should change in the GDD, in the director\'s terms. Empty when it only asks for work.' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          everyAgent: { type: 'boolean', description: 'True when the note asks each agent to do this themselves (e.g. "every agent should...").' },
          section: { type: 'string', description: 'The id of the GDD section this task develops, when sections are listed; empty if none.' },
          level: { type: 'integer', minimum: 0, maximum: 3, description: 'The quality level the task works toward, when sections are listed.' },
          focus: { type: 'array', items: { type: 'string' }, description: 'Ids of the director\'s focuses this task serves, when focuses are listed.' },
        },
        required: ['title'],
      },
    },
  },
  required: ['tasks'],
};

export async function triage(game, note) {
  if (note.source === 'review-session') orch.feedPost(game.id, { kind: 'system', text: `Breaking Director Review #${note.num} into tasks…` });
  const acct = db.accounts.filter((a) => a.loggedIn && !(a.limitedUntil > Date.now()))
    .sort((a, b) => orch.utilization(a) - orch.utilization(b))[0];
  if (!acct) {
    orch.addTask(game.id, { title: note.text.split('\n')[0].slice(0, 120), detail: note.text, noteNum: note.num });
    orch.feedPost(game.id, { kind: 'system', text: 'No account free to triage; the note went on the board as one task.' });
    return;
  }
  const open = db.tasks.filter((t) => t.gameId === game.id && t.status !== 'done');
  // The GDD's full text as Ballast last read it (Claude Docs docs included), for triage to check against.
  const own = path.join(HOME, 'gdd', game.id, 'current.md');
  const gdd = fs.existsSync(own) ? [{ title: `GDD v${game.gdd?.versions?.at(-1)?.v || ''} (Ballast)`, url: db.cloudArtifacts.find((a) => a.gameId === game.id && a.role === 'gdd')?.url || '', file: own, dir: path.dirname(own) }] : db.cloudArtifacts.filter((a) => a.gameId === game.id && a.role === 'gdd').map((a) => {
    const dir = path.join(paths.cloud, a.id);
    const file = ['page.md', 'page.html'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    return { ...a, file: a.mirrored && file ? file : null, dir };
  });
  const { result } = await claude.runQuick({
    account: acct,
    args: ['--model', db.settings.triageModel || 'sonnet', '--tools', 'Read', '--add-dir', attachmentsDir(game.id), ...gdd.filter((a) => a.file).flatMap((a) => ['--add-dir', a.dir]), ...jungledocs.forRun(game).args, '--json-schema', JSON.stringify(TRIAGE_SCHEMA)],
    prompt: P.cloudTriage({ game, note, open, gdd }) + jungledocs.forRun(game).text + loops.triageNote(game) + worksplit.triageNote(game) + gates.triageNote(game, note) + focus.triageNote(game),
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
    ? agents.map((a) => focus.tag(game, orch.addTask(game.id, { title: `${t.title} (${a.name})`, detail: t.detail, noteNum: note.num, createdBy: 'Ballast triage', assignee: a.id, ...gates.link(game, t, note) }), t.focus).num)
    : [focus.tag(game, orch.addTask(game.id, { title: t.title, detail: t.detail, noteNum: note.num, createdBy: 'Ballast triage', ...gates.link(game, t, note) }), t.focus).num]));
  // The agent with the most headroom records the feedback and breakdown in the coordinator file;
  // assigned tasks are claimed first, so it lands before the rest of the team gets far.
  const coordinator = game.coordinatorFile && nums.length ? orch.pickTriager(game) : null;
  if (coordinator) {
    const t = orch.addTask(game.id, {
      title: `[docs] Record note #${note.num} in ${game.coordinatorFile}`,
      detail: `Add the director's feedback from note #${note.num} and its task breakdown to ${game.coordinatorFile}, grouped by department. Merge it right away so every agent sees it.\n\nTasks (everything you need for the breakdown is here):\n${nums.map((n) => db.tasks.find((t) => t.gameId === game.id && t.num === n)).filter(Boolean).map((t) => `- #${t.num} ${t.title}${t.assignee ? ` (for ${orch.getAgent(t.assignee)?.name || 'one agent'})` : ''}: ${(t.detail || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}\n\nNote:\n${note.text.slice(0, 6000)}`,
      noteNum: note.num,
      createdBy: 'Ballast triage',
      assignee: coordinator.id,
    });
    nums.unshift(t.num);
  }
  // A design change in the note also becomes a GDD draft for the director to review (GDD tab).
  if (out.gddChange?.trim() && game.gdd?.versions?.length) {
    try { gddedit.draft(game.id, { feedback: `${out.gddChange.trim()}\n\n(From note #${note.num}: ${note.text.slice(0, 3000)})`, from: `note #${note.num}` }); orch.feedPost(game.id, { kind: 'system', from: 'GDD', text: `Note #${note.num} changes the design: drafting the GDD change for your review (GDD tab).` }); } catch { /* no GDD in Ballast yet */ }
  }
  const covered = (out.covered || []).filter((n) => db.tasks.some((t) => t.gameId === game.id && t.num === n));
  if (nums.length) orch.feedPost(game.id, { kind: 'system', text: `Note #${note.num} split into ${nums.map((n) => `#${n}`).join(', ')}. ${out.summary || ''}` });
  else if (covered.length) orch.feedPost(game.id, { kind: 'system', text: `Note #${note.num}: already covered by ${covered.map((n) => `#${n}`).join(', ')}. ${out.summary || ''}` });
  else {
    orch.feedPost(game.id, { kind: 'system', text: `Note #${note.num} made no tasks: ${out.summary || 'triage found nothing to do'} It's in your Inbox in case that's wrong.` });
    inbox.droppedNote({ game, note, why: out.summary || '' });
  }
}

// ---------------------------------------------------------------------------
// Dispatch

// A cloud agent gets a small batch (the game's "tasks per claim") in one message. Each task
// still has its own branch, PR and report file, and is closed as soon as its report lands.
export async function dispatch(agent, item) {
  const game = orch.getGame(agent.gameId);
  const acct = orch.getAccount(agent.accountId);
  let tasks = [];
  let items;
  let prompt;
  const delivery = `\n- ${P.deliveryLine(orch.nextDelivery(game)) || 'Keep the base branch buildable whenever you merge.'}`;
  if (item.kind === 'survey') {
    items = [{ key: 'survey', taskId: null }];
    prompt = P.cloudSurvey({ game, agent });
  } else if (item.kind === 'message') {
    const key = `m${Date.now().toString(36)}`;
    items = [{ key, taskId: null }];
    prompt = P.cloudTask({ game, agent, key, task: { title: 'Message from the director', detail: item.text }, ...context(game, agent) });
  } else {
    for (let i = 0; i < orch.claimBatchFor(agent); i++) {
      const t = orch.claimForAgent(agent);
      if (!t) break;
      tasks.push(t);
    }
    if (!tasks.length) { if (item.kind === 'next') orch.refundTurn(game); return; }
    items = tasks.map((t) => ({ key: `t${t.num}`, taskId: t.id }));
    const policy = (t) => review.policyFor(game, t.discipline || review.disciplineOf(t.title));
    prompt = tasks.length === 1
      ? P.cloudTask({ game, agent, task: tasks[0], policy: policy(tasks[0]), ...context(game, agent) }) + delivery
      : P.cloudBatch({ game, agent, tasks, policyOf: policy, ...context(game, agent) }) + delivery;
    // Quality targets for these tasks, read from the targets branch (cloud can't see this PC).
    const refs = [...new Map(tasks.flatMap((t) => targets.forTask({ ...t, discipline: t.discipline || review.disciplineOf(t.title) }, game)).map((r) => [r.id, r])).values()];
    if (refs.length && game.targetsShared && !game.targetsShared.error) prompt += `\n\n${P.targetsCloud(targets.describe(refs, { local: false }), targets.TARGETS_BRANCH)}`;
    // Working in a department means picking up its waiting note; the breakdown comes back in
    // the first task's report.
    for (const t of tasks) {
      const discipline = t.discipline || review.disciplineOf(t.title);
      const note = deptnotes.pickFor(agent, game, discipline);
      if (note) {
        prompt += `\n\n${P.deptNoteCloud({ note, label: deptnotes.label(discipline), ref: deptnotes.ref(note) })}`;
        items[0].deptNoteId = note.id;
        break;
      }
    }
  }

  prompt = orch.policyNoteFor(agent) + jungledocs.agentNote(game) + prompt; // usage rules in force, and the Jungle Engine docs
  dispatching.add(agent.id);
  changed();
  try {
    if (!agent.cloudLink) throw new Error('Connect a cloud session to this agent first (Agents tab).');
    // The session works on GitHub, not in Ballast's clone, so no checkout here. Only the
    // remote's branch heads are needed, to spot the branches it pushes later.
    const baseline = await git.remoteHeads(game.repoPath);
    const { sessionId, url } = agent.cloudLink;
    await claude.sendCloudMessage({ account: acct, cwd: game.repoPath, sessionId, text: prompt });
    agent.cloud = { sessionId, url, items, kind: item.kind, since: Date.now(), baseline };
    orch.setAgentError(agent.id, null); // a retry that worked shouldn't keep showing the old failure
    agent.turns = (agent.turns || 0) + 1;
    agent.lastActive = Date.now();
    const what = tasks.length ? tasks.map((t) => `#${t.num} ${t.title}`).join(', ') : items[0].key === 'survey' ? 'the project survey' : 'your message';
    orch.feedPost(game.id, { kind: 'system', text: `${agent.name} took ${what}: ${url}` });
  } catch (err) {
    for (const task of tasks) orch.updateTask(task.id, { status: 'open' });
    if (item.kind === 'next') orch.refundTurn(game);
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
  // Every finished connector terminal creates a cloud session per agent, so a second one for the
  // same agents would leave unused sessions behind. Point back at the open terminal instead.
  const waiting = agents.filter((a) => [...pendingLinks.values()].includes(a.id));
  if (waiting.length === agents.length && Date.now() < linkDeadline) {
    throw Object.assign(new Error(`A connect terminal is already open for ${waiting.map((a) => a.name).join(', ')}. Finish it there; Ballast connects each agent as its session is created.`), { status: 409 });
  }
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
  const { url } = agent.cloud;
  const items = agent.cloud.items || [{ taskId: agent.cloud.taskId }];
  agent.cloud = null;
  for (const item of items.filter((i) => !i.done && i.taskId)) {
    const task = db.tasks.find((t) => t.id === item.taskId);
    if (task?.status === 'claimed') orch.updateTask(task.id, { status: 'open' });
  }
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
    // A session is judged by its last progress (a report, or a push to one of its task branches), not
    // by when its batch started: a quiet one gets a check-in, then its tickets are marked blocked.
    const timeout = (db.settings.cloudTaskTimeoutMin || 240) * 60e3;
    const nudgeAfter = (db.settings.cloudNudgeMin || 90) * 60e3;
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
        // Sessions from before batching carried a single key/taskId.
        agent.cloud.items ||= [{ key: agent.cloud.key, taskId: agent.cloud.taskId }];
        const { baseline = {}, since, items } = agent.cloud;
        const moved = Object.keys(heads).filter((b) => heads[b] !== baseline[b]);
        if (moved.length) await git.fetchBranches(game.repoPath, moved.slice(0, 20)).catch(() => {});
        // Progress: a push to a branch named for one of its tasks.
        const mine = Object.keys(heads).filter((b) => items.some((i) => !i.done && b.includes(i.key))).sort();
        const sig = mine.map((b) => `${b}@${heads[b]}`).join(',');
        if (agent.cloud.sig !== undefined && sig !== agent.cloud.sig) agent.cloud.progressAt = Date.now();
        agent.cloud.sig = sig;
        const doneBefore = items.filter((i) => i.done).length;
        for (const item of items.filter((i) => !i.done)) {
          // Likely branches first: the suggested name, then anything new or updated since dispatch.
          const candidates = [...moved].sort((a, b) => (b.includes(item.key) - a.includes(item.key)) || (b.startsWith('ballast/') - a.startsWith('ballast/'))).slice(0, 20);
          for (const b of candidates) {
            const file = P.reportPath(item.key, game.subdir);
            const report = await git.showRemoteFile(game.repoPath, b, file);
            // A session reuses its branch, so a report from an earlier attempt at this task can
            // still be there: only a report committed after this dispatch counts.
            if (report && (await git.remoteFileTime(game.repoPath, b, file)) < since - 5 * 60e3) continue;
            if (report) {
              await complete(game, agent, item, report, b);
              break;
            }
          }
        }
        if (agent.cloud && items.filter((i) => i.done).length > doneBefore) agent.cloud.progressAt = Date.now();
        const quiet = agent.cloud ? Date.now() - Math.max(since, agent.cloud.progressAt || 0) : 0;
        const left = items.filter((i) => !i.done && i.taskId).map((i) => db.tasks.find((t) => t.id === i.taskId)).filter(Boolean);
        if (agent.cloud && items.every((i) => i.done)) {
          agent.cloud = null;
          setTimeout(() => orch.wakeIdle(game.id), 500);
        } else if (agent.cloud && quiet > timeout) {
          const hours = Math.round(quiet / 3600e3 * 10) / 10;
          for (const t of left) orch.updateTask(t.id, { status: 'blocked', blockReason: `No progress from the cloud session for ${hours}h (no report, no push), even after a check-in: ${agent.cloud.url}` });
          orch.feedPost(game.id, { kind: 'error', from: agent.name, agentId: agent.id, text: `No progress for ${hours}h on ${left.map((t) => `#${t.num}`).join(', ') || 'its tasks'}, even after a check-in. Marked blocked (they triage themselves); the agent takes new work. Session: ${agent.cloud.url}` });
          agent.cloud = null;
          setTimeout(() => orch.wakeIdle(game.id), 500);
        } else if (agent.cloud && quiet > nudgeAfter && !(agent.cloud.nudgedAt > Math.max(since, agent.cloud.progressAt || 0))) {
          agent.cloud.nudgedAt = Date.now();
          const mins = Math.round(quiet / 60e3);
          message(agent, `Ballast check-in: no report or push from you for ${mins} minutes on ${left.map((t) => `#${t.num} ${t.title}`).join('; ')}. If a task is finished, push its report now. If you're stuck or waiting on something, push a report that starts with STATUS: BLOCKED and says what you need. Otherwise keep going, and push your work in progress so Ballast can see it moving.`)
            .then(() => orch.feedPost(game.id, { kind: 'system', from: agent.name, agentId: agent.id, text: `${agent.name} has been quiet for ${mins} min on ${left.map((t) => `#${t.num}`).join(', ')}; sent it a check-in.` }))
            .catch((err) => orch.feedPost(game.id, { kind: 'error', from: agent.name, agentId: agent.id, text: `Couldn't send ${agent.name} a check-in: ${err.message.slice(0, 200)}` }));
        }
      }
      save();
      changed();
    }
  } finally {
    polling = false;
  }
}

// The "## Questions" section of a report goes to the Director's Inbox. Each question is a
// "### question" block with Context / Options / Going with / Capture lines; older reports
// used one "- question -> assumption" line each, which still works. Agents also write the labels
// in bold or as bullets ("- **Context:** …") and open a block with "**Decision:** …" or a bold
// question line instead of "###": those are read as blocks too, never one question per line.
const Q_LABEL = /^(?:Decision|Question|Context|Options|Going with|Capture):/;
const Q_LABEL_LINE = /^[ \t]*(?:[-*][ \t]+)?\**[ \t]*(decision|question|context|options|going with|assumption|capture)[ \t]*\**[ \t]*:[ \t]*\**[ \t]*/i;
const plainTitle = (s) => s.replace(/^[ \t]*(?:[-*][ \t]+)?/, '').replace(/\*\*/g, '').replace(/^\*+|\*+$/g, '').trim();

function questionBlocks(section) {
  const lines = section.split('\n').map((l) => l.replace(Q_LABEL_LINE, (_, k) => {
    const key = k.toLowerCase() === 'assumption' ? 'going with' : k.toLowerCase();
    return `${key[0].toUpperCase()}${key.slice(1)}: `;
  }));
  if (/^###\s+/m.test(section)) return lines.join('\n');
  if (!lines.some((l) => Q_LABEL.test(l))) return null; // the old one-line format
  const out = [];
  lines.forEach((l, i) => {
    const opener = l.match(/^(?:Decision|Question): (.*)$/);
    if (opener) { out.push(`### ${plainTitle(opener[1])}`); return; }
    // A plain line right before "Context:" is that block's question.
    const next = lines.slice(i + 1).find((x) => x.trim());
    if (l.trim() && !Q_LABEL.test(l) && next?.startsWith('Context:') && !/^###/.test(out[out.length - 1] || '')) { out.push(`### ${plainTitle(l)}`); return; }
    out.push(l);
  });
  return out.join('\n');
}

export function reportQuestions(body) {
  const section = body.match(/^##\s*Questions\s*\n([\s\S]*?)(?=\n##\s|(?![\s\S]))/im)?.[1] || '';
  const blocks = (questionBlocks(section) || '').split(/^###\s+/m).slice(1);
  if (blocks.length) {
    return blocks.map((block) => {
      const [first, ...rest] = block.split('\n');
      const text = rest.join('\n');
      const field = (name) => text.match(new RegExp(`^[ \\t]*${name}:[ \\t]*([\\s\\S]*?)(?=^[ \\t]*(?:Context|Options|Going with|Capture):|(?![\\s\\S]))`, 'im'))?.[1]?.trim() || '';
      return {
        question: plainTitle(first),
        context: field('Context'),
        options: field('Options').split('\n').map((o) => o.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean),
        assumption: field('Going with'),
        capture: field('Capture').replace(/[`'"]/g, '').split(/\s/)[0] || '',
      };
    }).filter((q) => q.question);
  }
  return [...section.matchAll(/^\s*[-*]\s*(.+)$/gm)].map(([, line]) => {
    const [question, assumption = ''] = line.split(/\s*(?:->|→)\s*/);
    return { question: question.trim(), assumption: assumption.trim(), context: '', options: [], capture: '' };
  }).filter((q) => q.question);
}

// One-time repair: questions an earlier parser split into one inbox card per line (same report,
// same moment, lines like "Context: …", "(a) …") are merged back into one card. Answered ones stay.
export function repairSplitQuestions() {
  const groups = new Map();
  for (const q of db.inbox) {
    if (q.source !== 'report' || q.status !== 'open') continue;
    const k = `${q.gameId}|${q.agentId}|${q.taskId}|${Math.round((q.createdAt || 0) / 5000)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(q);
  }
  let merged = 0;
  for (const g of groups.values()) {
    if (g.length < 3 || !g.some((q) => Q_LABEL_LINE.test(`- ${q.question}`) && /context/i.test(q.question))) continue;
    const parsed = reportQuestions(`## Questions\n${g.map((q) => `- ${q.question}`).join('\n')}`);
    if (!parsed.length || parsed.length >= g.length) continue;
    const [keep, ...drop] = g;
    const p = parsed[0];
    Object.assign(keep, { question: p.question, context: p.context, options: p.options, assumption: p.assumption });
    // Further blocks in the same report, if any, keep their own cards.
    parsed.slice(1).forEach((x, i) => { if (drop[i]) Object.assign(drop[i], { question: x.question, context: x.context, options: x.options, assumption: x.assumption, keep: true }); });
    const gone = new Set(drop.filter((d) => !d.keep).map((d) => d.id));
    for (const d of drop) delete d.keep;
    db.inbox = db.inbox.filter((q) => !gone.has(q.id));
    merged++;
  }
  if (merged) { save(); changed(); }
  return merged;
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

// Closes one item of the agent's batch; poll() frees the agent once every item has reported.
async function complete(game, agent, item, report, branch) {
  const { taskId, key } = item;
  const { url } = agent.cloud;
  item.done = true;
  const blocked = /^STATUS:\s*BLOCKED/im.test(report);
  const body = report.replace(/^STATUS:.*\n?/im, '').trim();
  const pr = body.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0];
  const task = db.tasks.find((t) => t.id === taskId);
  const media = await pullMedia(game, agent, task, branch, key);
  if (item.deptNoteId) {
    const note = db.deptNotes.find((n) => n.id === item.deptNoteId);
    const section = note && body.match(new RegExp(`^##\\s*Note\\s*${deptnotes.ref(note)}\\s*tasks\\s*\\n([\\s\\S]*?)(?=\\n##\\s|(?![\\s\\S]))`, 'im'))?.[1];
    const lines = [...(section || '').matchAll(/^\s*[-*]\s*(.+?)(?::\s+(.+))?$/gm)].map(([, title, detail]) => ({ title, detail }));
    // No section means the agent didn't get to it; the note's fallback timer handles that.
    if (note?.status === 'new' && lines.length) deptnotes.taskNote(note, lines, agent.name);
  }
  for (const q of reportQuestions(body)) {
    // "Capture: dagger.gif" points at a file in this task's captures folder, pulled in above.
    const cap = q.capture && db.artifacts.filter((a) => a.gameId === game.id && a.taskId === (task?.id || null)).find((a) => a.entry === q.capture.replace(/[^\w.\-]+/g, '_') || a.entry.endsWith(q.capture.split('/').pop()));
    inbox.ask({ game, agent, task, question: q.question, context: q.context, options: q.options, assumption: q.assumption, artifactIds: cap ? [cap.id] : [], source: 'report' });
  }
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
      // Strict Jungle games: the PR's files are checked against the game's folder.
      if (pr) worksplit.checkScope(task, orch.getGame(task.gameId), pr).catch(() => {});
    }
    const label = blocked ? 'Blocked' : task.status === 'review' ? 'Ready for review' : 'Done';
    orch.feedPost(game.id, { kind: 'task', from: agent.name, agentId: agent.id, text: `${label} #${task.num} ${task.title}${pr ? `\n${pr}` : `\nbranch ${branch}`}${media ? `\n${media} capture(s) attached` : ''}\n${body.slice(0, 600)}` });
  } else {
    orch.feedPost(game.id, { kind: 'agent', from: agent.name, agentId: agent.id, text: `${body.slice(0, 2000)}\n${pr || `branch ${branch}`}` });
  }
  agent.lastCloud = { url, branch, pr, at: Date.now() };
}
