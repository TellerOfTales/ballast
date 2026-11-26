// Delegate chats: a working agent fans its work out by opening new, fully capable chats (their
// own Claude session, tools, board access and branch). Each delegate gets a brief, works
// autonomously, can open its own delegates (up to a depth), and reports back with
// delegate_done; the parent then merges its branch. Limits: chats per agent, and depth.
// (Subagents, the short-lived helpers inside one chat, are tracked in subagents.mjs.)
import { db, save } from './store.mjs';
import { changed } from './bus.mjs';
import * as orch from './orchestrator.mjs';
import * as P from './prompts.mjs';

function must(value, message) {
  if (!value) throw Object.assign(new Error(message), { status: 400 });
  return value;
}

export const limitFor = (game) => Math.max(0, Number(game?.delegateLimit ?? db.settings.delegateLimit ?? 3) || 0);
export const depthMax = () => Math.max(0, Number(db.settings.delegateDepth ?? 2) || 0);
export const childrenOf = (id, { all = false } = {}) => db.agents.filter((a) => a.parentId === id && (all || !a.retired));
// Reports go to the closest ancestor that's still open (a parent can finish before its delegates).
function liveAncestor(agent) {
  let p = orch.getAgent(agent.parentId);
  while (p?.retired) p = orch.getAgent(p.parentId);
  return p || null;
}

export async function open(parent, { brief, name, role, task_ids = [] }) {
  const game = must(orch.getGame(parent.gameId), 'Unknown game');
  must(game.runner !== 'cloud', 'Cloud agents cannot open delegate chats.');
  brief = String(brief || '').trim();
  must(brief.length >= 20, 'Give the delegate a real brief: the goal, the files or systems involved, and what done looks like.');
  const limit = limitFor(game);
  must(limit > 0, 'Delegate chats are turned off for this game.');
  const kids = childrenOf(parent.id);
  if (kids.length >= limit) {
    throw new Error(`You already have ${kids.length} delegate chats open (limit ${limit}): ${kids.map((k) => k.name).join(', ')}. Wait for one to report back, or message one with message_delegate.`);
  }
  const depth = (parent.depth || 0) + 1;
  if (depth > depthMax()) throw new Error(`Delegate chats go at most ${depthMax()} level(s) deep, so this chat can't open more. Use subagents, or do it yourself.`);

  const acct = orch.pickDelegateAccount(game, parent);
  parent.delegateSeq = (parent.delegateSeq || 0) + 1;
  const agent = await orch.addAgent(game.id, { accountId: acct.id, name: name?.trim() || `${parent.name}.${parent.delegateSeq}`, role: role || parent.role, parent, brief });

  // Tasks handed over are claimed for the delegate; they come back to the parent when it reports.
  const handed = [];
  for (const num of [].concat(task_ids || [])) {
    const t = db.tasks.find((x) => x.gameId === game.id && x.num === Number(String(num).replace('#', '')));
    if (t && (t.status === 'open' || (t.status === 'claimed' && t.claimedBy === parent.id))) {
      Object.assign(t, { status: 'claimed', claimedBy: agent.id, claimedAt: Date.now(), updatedAt: Date.now(), handedFrom: parent.id });
      orch.logWork(t, agent.id);
      handed.push(t);
    }
  }
  orch.feedPost(game.id, { kind: 'system', text: `${parent.name} opened delegate chat ${agent.name} on ${acct.name}${handed.length ? ` with ${handed.map((t) => `#${t.num}`).join(', ')}` : ''}: ${brief.slice(0, 240)}` });
  orch.enqueueItem(agent, { kind: 'message', direct: true, text: brief, prompt: P.delegateBrief({ parent, agent, game, brief, tasks: handed }) });
  save();
  changed();
  return { agent, handed, account: acct };
}

export function done(agent, { summary = '', auto = false } = {}) {
  must(agent.parentId, 'Only delegate chats report back with delegate_done.');
  must(!agent.retired, 'You already reported back.');
  const game = orch.getGame(agent.gameId);
  const parent = liveAncestor(agent);
  summary = String(summary || '').trim() || '(no summary given)';
  Object.assign(agent, { retired: true, delegateResult: { summary, at: Date.now(), auto } });
  orch.clearQueue(agent.id);
  const tasks = db.tasks.filter((t) => t.claimedBy === agent.id && t.status === 'claimed');
  for (const t of tasks) Object.assign(t, parent ? { claimedBy: parent.id, updatedAt: Date.now() } : { status: 'open', claimedBy: null, updatedAt: Date.now() });
  if (parent) orch.enqueueItem(parent, { kind: 'message', direct: true, text: summary, prompt: P.delegateReport({ delegate: agent, summary, game, tasks, auto }) });
  orch.feedPost(agent.gameId, { kind: 'agent', from: agent.name, agentId: agent.id, text: `Delegate report to ${parent?.name || 'the board'}${auto ? ' (sent automatically)' : ''}:\n${summary}` });
  save();
  changed();
  return parent;
}

export function message(parent, { name, text }) {
  const kid = must(childrenOf(parent.id, { all: true }).find((k) => k.name.toLowerCase() === String(name || '').trim().toLowerCase() || k.id === name), `No delegate chat named "${name}". list_delegates shows yours.`);
  must(!kid.retired, `${kid.name} already reported back and is closed.`);
  must(String(text || '').trim(), 'Empty message.');
  orch.enqueueItem(kid, { kind: 'message', direct: true, text, prompt: `MESSAGE from ${parent.name} (the chat that opened you):\n${String(text).trim()}` });
  return kid;
}

export function list(parent) {
  const kids = childrenOf(parent.id, { all: true });
  if (!kids.length) return 'You have no delegate chats.';
  return kids.map((k) => {
    const st = orch.publicAgentStatus(k);
    const tasks = db.tasks.filter((t) => t.claimedBy === k.id && t.status === 'claimed').map((t) => `#${t.num}`);
    return `- ${k.name} [${k.retired ? 'reported back' : st}]${tasks.length ? ` holding ${tasks.join(', ')}` : ''}\n    brief: ${(k.delegateBrief || '').replace(/\s+/g, ' ').slice(0, 160)}${k.delegateResult ? `\n    report: ${k.delegateResult.summary.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`;
  }).join('\n');
}
