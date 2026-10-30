// Ticket conversations: any board task can carry a conversation with Claude to work out the
// best way forward (blocked tickets most of all). Each message goes to the account with the most
// weekly room. When you've decided, Claude drafts the rewritten ticket from the conversation;
// you edit and approve it, and the ticket is updated (reopened, closed, or the agent told).
import fs from 'node:fs';
import path from 'node:path';
import { db, paths, appendJsonl, readJsonlTail, attachmentsDir, uid, save } from './store.mjs';
import { bus, changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import { recordUsage } from './usage.mjs';
import { pickAccount, context } from './ask.mjs';

const busy = new Set(); // taskId
const must = (v, msg, status = 400) => { if (!v) throw Object.assign(new Error(msg), { status }); return v; };
const getTask = (id) => must(db.tasks.find((t) => t.id === id), 'Unknown task');
const fileOf = (t) => path.join(paths.games, t.gameId, 'threads', `${t.id}.jsonl`);
const PRIO = ['low', 'normal', 'high', 'urgent'];

export const read = (taskId) => {
  const t = getTask(taskId);
  return { messages: readJsonlTail(fileOf(t), 400), busy: busy.has(t.id) };
};

function add(t, entry) {
  const e = { id: uid('m'), ts: Date.now(), ...entry };
  appendJsonl(fileOf(t), e);
  if (e.role !== 'system') { t.thread = { count: (t.thread?.count || 0) + 1, at: e.ts }; save(); changed(); }
  bus.emit('event', { type: 'thread', taskId: t.id, entry: e });
  return e;
}

function ticket(t) {
  const name = (id) => orch.getAgent(id)?.name || 'an agent';
  return `#${t.num} ${t.title}
Status: ${t.status}${t.claimedBy ? ` (held by ${name(t.claimedBy)})` : ''} · priority ${PRIO[t.priority ?? 1]} · created by ${t.createdBy || '?'}${t.noteNum ? ` from note #${t.noteNum}` : ''}
${t.blockReason ? `Why it's blocked: ${t.blockReason}\n` : ''}${t.note ? `Last note: ${t.note}\n` : ''}
Detail:
${t.detail || '(none)'}
${t.summary ? `\nWhat the agent reported:\n${t.summary}` : ''}${t.branch ? `\nBranch: ${t.branch}` : ''}`;
}

const folderOf = (game) => (game.subdir ? path.join(game.repoPath, game.subdir) : game.repoPath);
const transcript = (msgs) => msgs.filter((m) => m.role !== 'system' && !m.error).slice(-14)
  .map((m) => `${m.role === 'user' ? 'Director' : 'Claude'}: ${m.text.slice(0, 3000)}`).join('\n\n---\n\n');

const READ_ONLY = ['--tools', 'Read,Glob,Grep,WebSearch,WebFetch', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

export function discuss(taskId, { text = '', attachments = [] } = {}) {
  const t = getTask(taskId);
  const game = must(orch.getGame(t.gameId), 'Unknown game');
  text = String(text).trim();
  must(text || attachments.length, 'Write something first.');
  must(!busy.has(t.id), 'Claude is still answering on this ticket.', 409);
  const acct = must(pickAccount(), 'No logged-in account has usage free right now.');
  const prior = readJsonlTail(fileOf(t), 400);
  const msg = add(t, { role: 'user', from: orch.directorName(), text, attachments, to: acct.name });
  busy.add(t.id);
  changed();
  reply(t, game, acct, msg, prior).finally(() => { busy.delete(t.id); changed(); });
  return { id: msg.id, account: acct.name };
}

async function reply(t, game, acct, msg, prior) {
  const folder = folderOf(game);
  fs.mkdirSync(attachmentsDir(game.id), { recursive: true });
  const sysFile = path.join(paths.tmp, `thread-${t.id}.md`);
  fs.writeFileSync(sysFile, `You're helping ${orch.directorName()}, the solo developer of "${game.name}", work out the best way forward on one ticket from the board their AI agents work from. You're a collaborator in this conversation, not the agent doing the work.

- Get to the bottom of the problem: read the code, assets and docs it touches before suggesting anything (the game is in ${folder}), and say what you found.
- Lay out the real options with their tradeoffs in player-facing terms, then recommend one.
- Ask a question when a decision is genuinely theirs (look and feel, scope), not about things you can find out yourself.
- Don't change files. When you've agreed on an approach, say so plainly and summarise it; they'll press "Update the ticket" and the ticket is rewritten from this conversation.
- Answer in Markdown, concise, answer first.

The ticket:
${ticket(t)}

The game:
${context(game)}`);
  const files = (msg.attachments || []).filter((a) => a.path).map((a) => `- ${a.name}: ${a.path}`).join('\n');
  const history = transcript(prior);
  const prompt = `${history ? `Our conversation about this ticket so far:\n\n${history}\n\n---\n\n` : ''}${msg.text || '(see the attached files)'}${files ? `\n\nAttached (open with Read):\n${files}` : ''}`;
  let live = '';
  let last = 0;
  // Live text while it writes; the finished message replaces it (no final live event after that).
  const emit = (force) => { if (force || Date.now() - last > 150) { last = Date.now(); bus.emit('event', { type: 'thread-live', taskId: t.id, account: acct.name, text: live }); } };
  try {
    const { result, stderr, code } = await claude.runQuick({
      account: acct,
      cwd: fs.existsSync(folder || '') ? folder : undefined,
      args: ['--include-partial-messages', '--append-system-prompt-file', sysFile, ...READ_ONLY, '--add-dir', attachmentsDir(game.id), ...(db.settings.askModel ? ['--model', db.settings.askModel] : [])],
      prompt,
      onMessage: (m) => {
        if (m.type === 'stream_event' && !m.parent_tool_use_id && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') { live += m.event.delta.text; emit(); }
        else if (m.type === 'stream_event' && m.event?.type === 'message_start' && live) live += '\n\n';
        else if (m.type === 'rate_limit_event') orch.updateUsage(acct, m.rate_limit_info || {});
      },
    });
    if (result) recordUsage({ account: acct, gameId: game.id, kind: 'ticket', result });
    const answer = (result?.result || live).trim();
    if (!answer) throw new Error((stderr || `claude exited with ${code}`).trim().split('\n').slice(-2).join(' ').slice(0, 300));
    add(t, { role: 'assistant', from: acct.name, text: answer, cost: result?.total_cost_usd || 0 });
  } catch (err) {
    add(t, { role: 'assistant', from: acct.name, error: true, text: `Couldn't answer: ${err.message}` });
  }
}

// ---------------------------------------------------------------------------
// Turning the conversation into the updated ticket

const PROPOSAL = {
  type: 'object',
  required: ['title', 'detail', 'decision', 'next', 'priority'],
  properties: {
    title: { type: 'string', description: 'The ticket title, keeping its [department] tag.' },
    detail: { type: 'string', description: 'The rewritten ticket for the agent who picks it up: the approach decided, what to change, constraints agreed, and how to check it is done. Self-contained: the agent won\'t see the conversation.' },
    decision: { type: 'string', description: 'One or two sentences on what was decided, for the feed.' },
    next: { enum: ['open', 'keep', 'done'], description: 'open: put it back on the board for an agent (unblock it). keep: leave its status as is. done: no longer needed.' },
    priority: { enum: PRIO },
  },
};

export async function propose(taskId) {
  const t = getTask(taskId);
  const game = must(orch.getGame(t.gameId), 'Unknown game');
  const msgs = readJsonlTail(fileOf(t), 400);
  must(msgs.some((m) => m.role === 'assistant' && !m.error), 'Talk it through first: there\'s no conversation on this ticket yet.');
  must(!busy.has(t.id), 'Wait for Claude to finish answering first.', 409);
  const acct = must(pickAccount(), 'No logged-in account has usage free right now.');
  busy.add(t.id);
  changed();
  try {
    const { result } = await claude.runQuick({
      account: acct,
      args: ['--model', db.settings.triageModel || 'sonnet', '--tools', 'Read', '--json-schema', JSON.stringify(PROPOSAL)],
      prompt: `Rewrite this ticket to reflect what the director and Claude decided in the conversation below. Base it on the decision, not on options that were rejected. If they didn't reach a decision, keep the ticket as close to the original as you can and say so in "decision".

The ticket now:
${ticket(t)}

The conversation:
${transcript(msgs)}`,
    });
    if (result) recordUsage({ account: acct, gameId: game.id, kind: 'ticket', result });
    return must(result?.structured_output, 'Couldn\'t draft the update. Try again.');
  } finally {
    busy.delete(t.id);
    changed();
  }
}

export function apply(taskId, { title, detail, decision = '', next = 'keep', priority, tellAgent = false } = {}) {
  const t = getTask(taskId);
  const holder = t.claimedBy && t.status === 'claimed' ? orch.getAgent(t.claimedBy) : null;
  orch.updateTask(t.id, { title, detail, ...(priority ? { priority } : {}) });
  if (next === 'open' && t.status !== 'open') orch.updateTask(t.id, { status: 'open' });
  if (next === 'done') orch.updateTask(t.id, { status: 'done', summary: `Closed after discussion: ${decision}`.trim() });
  if (decision) t.note = `Decided in discussion: ${decision}`.slice(0, 300);
  save();
  add(t, { role: 'system', text: `Ticket updated${next === 'open' ? ' and back on the board' : next === 'done' ? ' and closed' : ''}.${decision ? ` ${decision}` : ''}` });
  orch.feedPost(t.gameId, { kind: 'task', from: orch.directorName(), text: `Updated #${t.num} ${t.title} after a conversation with Claude${next === 'open' ? '; it\'s back on the board' : next === 'done' ? '; closed as no longer needed' : ''}.${decision ? ` ${decision}` : ''}` });
  // The agent holding it won't reread the ticket mid-work, so tell it directly.
  if (tellAgent && holder && next !== 'done') {
    orch.postNote(t.gameId, { target: holder.id, text: `#${t.num} was updated after I talked it through with Claude. ${decision}\n\nThe ticket now:\n${t.title}\n${t.detail}` });
  }
  changed();
  return t;
}
