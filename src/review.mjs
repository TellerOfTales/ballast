// Director review, organized by discipline. The rule throughout: review never stops the team.
// Per discipline the director picks one of:
//   skip  - "not my field": agents merge and move on; nothing is queued for review
//   after - agents merge and move on; finished work queues for review; feedback becomes new tasks
//   gate  - agents leave the change unmerged and move on to other work; approving merges it,
//           and anything left too long is approved automatically
import { execFile } from 'node:child_process';
import { db, save } from './store.mjs';
import { changed } from './bus.mjs';
import * as orch from './orchestrator.mjs';
import * as P from './prompts.mjs';

export const DISCIPLINES = [
  { id: 'gameplay', label: 'Gameplay', tags: ['gameplay', 'game', 'design', 'level', 'ui', 'ux', 'qa', 'input', 'camera', 'ai'] },
  { id: 'art', label: 'Art', tags: ['art', 'vfx', 'fx', 'anim', 'model', 'shader', 'light', 'visual', 'look', 'texture'] },
  { id: 'audio', label: 'Audio', tags: ['audio', 'sfx', 'sound', 'music', 'vo'] },
  { id: 'backend', label: 'Backend', tags: ['tech', 'backend', 'net', 'server', 'build', 'infra', 'tool', 'perf', 'data', 'docs', 'ci', 'backend'] },
];
const IDS = new Set([...DISCIPLINES.map((d) => d.id), 'other']);
export const MODES = new Set(['skip', 'after', 'gate']);

// "[art] Player sprite" -> "art". Untagged or unknown tags land in "other".
export function disciplineOf(title) {
  const tag = String(title || '').match(/^\s*\[([^\]]+)\]/)?.[1]?.toLowerCase();
  if (!tag) return 'other';
  return DISCIPLINES.find((d) => d.tags.some((t) => tag.includes(t)))?.id || 'other';
}

export function policyFor(game, discipline) {
  const mode = game?.review?.[discipline] || db.settings.review?.[discipline] || 'after';
  // A shared working tree has nowhere to park an unmerged change, so it can't gate.
  if (mode === 'gate' && game?.isolation === 'shared') return 'after';
  return MODES.has(mode) ? mode : 'after';
}

// Called when an agent reports a task finished. Returns the task's new status.
export function onFinished(task, game, { pr } = {}) {
  task.discipline ||= disciplineOf(task.title);
  if (pr) task.pr = pr;
  const policy = policyFor(game, task.discipline);
  task.review = policy === 'skip' ? { state: 'skipped', at: Date.now() } : { state: 'pending', since: Date.now(), gated: policy === 'gate' };
  return policy === 'gate' ? 'review' : 'done';
}

function must(value, message) {
  if (!value) throw Object.assign(new Error(message), { status: 400 });
  return value;
}

const gh = (args) => new Promise((resolve, reject) => {
  execFile('gh', args, { windowsHide: true, timeout: 120e3 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())));
});

// Landing an approved, unmerged change. Cloud work is a GitHub PR, merged with gh; local work
// sits on a review branch, so the agent that wrote it lands it (it knows the code best).
async function land(task, game) {
  const agent = orch.getAgent(task.doneBy || task.claimedBy);
  if (game.runner === 'cloud') {
    if (!task.pr) throw new Error('No pull request link was reported for this task.');
    try {
      await gh(['pr', 'merge', task.pr, '--merge']);
      orch.feedPost(game.id, { kind: 'task', text: `Merged ${task.pr} (#${task.num} approved).` });
    } catch (err) {
      orch.addTask(game.id, {
        title: `[${task.title.match(/^\s*\[([^\]]+)\]/)?.[1] || 'tech'}] Merge approved #${task.num}`,
        detail: `The director approved #${task.num} but merging ${task.pr} failed: ${err.message.slice(0, 300)}\nUpdate the branch (resolve conflicts against the base branch) and merge the PR.`,
        createdBy: 'Ballast review',
        assignee: agent?.id || null,
      });
      orch.feedPost(game.id, { kind: 'error', text: `Couldn't merge ${task.pr}: ${err.message.slice(0, 200)}. Added a task to fix it.` });
    }
    return;
  }
  if (agent) orch.postNote(game.id, { target: agent.id, text: P.landApproved({ task, game }), from: 'Ballast review', source: 'review' });
}

export async function approve(taskId, { auto = false } = {}) {
  const task = must(db.tasks.find((t) => t.id === taskId), 'Unknown task');
  const game = orch.getGame(task.gameId);
  if (task.review?.state !== 'pending') return task;
  task.review = { ...task.review, state: auto ? 'auto' : 'approved', at: Date.now() };
  if (task.status === 'review') {
    task.status = 'done';
    task.doneAt ||= Date.now();
    await land(task, game);
  }
  if (auto) orch.feedPost(game.id, { kind: 'system', text: `Auto-approved #${task.num} ${task.title} after ${db.settings.reviewAutoApproveHours}h so it doesn't hold up the team.` });
  save();
  changed();
  return task;
}

export function requestChanges(taskId, feedback) {
  const task = must(db.tasks.find((t) => t.id === taskId), 'Unknown task');
  must(String(feedback || '').trim(), 'Say what should change.');
  const game = orch.getGame(task.gameId);
  const agent = orch.getAgent(task.doneBy || task.claimedBy);
  const unmerged = task.status === 'review';
  task.review = { ...task.review, state: 'changes', at: Date.now(), feedback: feedback.trim() };
  if (unmerged) task.status = 'done'; // the follow-up carries the unmerged change from here
  const tag = task.title.match(/^\s*\[([^\]]+)\]/)?.[1] || task.discipline;
  const base = task.title.replace(/^\s*\[[^\]]+\]\s*/, '');
  const fix = orch.addTask(game.id, {
    title: `[${tag}] Changes to #${task.num}: ${base}`.slice(0, 200),
    detail: `Director review of #${task.num}:\n${feedback.trim()}\n\nWhat #${task.num} did: ${task.summary || '(no summary)'}${task.pr ? `\nPR: ${task.pr}` : ''}${unmerged ? `\nThat change was never merged: update the same ${game.runner === 'cloud' ? 'pull request' : `branch (ballast/review/t${task.num})`} rather than starting over.` : ''}`,
    createdBy: 'Director review',
    assignee: agent?.id || null,
  });
  if (unmerged && task.pr) fix.pr = task.pr;
  orch.feedPost(game.id, { kind: 'task', text: `Changes requested on #${task.num}; follow-up is #${fix.num}${agent ? ` for ${agent.name}` : ''}.` });
  save();
  changed();
  return fix;
}

export async function approveAll(gameId, discipline) {
  const tasks = db.tasks.filter((t) => t.gameId === gameId && t.review?.state === 'pending' && (t.discipline || disciplineOf(t.title)) === discipline);
  for (const t of tasks) await approve(t.id);
  return { approved: tasks.length };
}

// Work finished before review existed (or before a game came into Ballast) has no review state.
// This files it by each department's mode. It's already merged, so even "Approve first" areas
// just queue it for a look; nothing is un-merged.
export function queueEarlierWork(gameId) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const counts = { queued: 0, skipped: 0 };
  // Older reports kept the PR link only in the feed ("Done #8 …\nhttps://github.com/…/pull/10").
  const prFromFeed = {};
  for (const e of orch.readFeed(gameId, 5000)) {
    const m = e.kind === 'task' && String(e.text || '').match(/^(?:Done|Ready for review) #(\d+)[\s\S]*?(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)/);
    if (m) prFromFeed[m[1]] = m[2];
  }
  for (const t of db.tasks.filter((x) => x.gameId === gameId && !x.pr && prFromFeed[x.num])) t.pr = prFromFeed[t.num];
  for (const t of db.tasks.filter((x) => x.gameId === gameId && x.status === 'done' && !x.review)) {
    t.discipline ||= disciplineOf(t.title);
    t.pr ||= String(t.summary || '').match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0];
    if (policyFor(game, t.discipline) === 'skip') {
      t.review = { state: 'skipped', at: Date.now() };
      counts.skipped++;
    } else {
      t.review = { state: 'pending', since: t.doneAt || Date.now(), earlier: true };
      counts.queued++;
    }
  }
  save();
  changed();
  return counts;
}

// Safety valve: nothing gated waits on the director forever.
export async function autoApproveTick() {
  const hours = Number(db.settings.reviewAutoApproveHours) || 0;
  if (hours <= 0) return;
  const cutoff = Date.now() - hours * 3600e3;
  for (const t of db.tasks.filter((x) => x.status === 'review' && x.review?.state === 'pending' && (x.review.since || 0) < cutoff)) {
    await approve(t.id, { auto: true }).catch((err) => orch.feedPost(t.gameId, { kind: 'error', text: `Auto-approve of #${t.num} failed: ${err.message}` }));
  }
}

export function setGamePolicy(game, patch) {
  game.review ||= {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!IDS.has(k)) continue;
    if (v === 'default' || v === '' || v == null) delete game.review[k];
    else if (MODES.has(v)) game.review[k] = v;
  }
}

export function setStudioPolicy(patch) {
  db.settings.review ||= {};
  for (const [k, v] of Object.entries(patch || {})) if (IDS.has(k) && MODES.has(v)) db.settings.review[k] = v;
}
