// Director's Inbox: one place for every question any agent has, across games and accounts.
// Asking never blocks: the agent records the assumption it's going with and keeps working;
// the director's answer is sent back to that agent as a message. An answer also closes the game's
// other open questions it plainly settles (usually older ones asking the same thing), and tells
// their agents; each can be reopened if the match was wrong.
import { db, save, uid } from './store.mjs';
import { changed } from './bus.mjs';
import * as orch from './orchestrator.mjs';
import * as claude from './claude.mjs';
import * as pace from './pace.mjs';
import { recordUsage } from './usage.mjs';
import { disciplineOf } from './review.mjs';

db.inbox ||= [];

export function ask({ game, agent, question, assumption = '', context = '', options = [], artifactIds = [], task = null, source = 'agent' }) {
  question = String(question || '').trim();
  if (!question) throw Object.assign(new Error('Empty question'), { status: 400 });
  const q = {
    id: uid('q'),
    gameId: game.id,
    agentId: agent?.id || null,
    agentName: agent?.name || 'an agent',
    taskId: task?.id || null,
    taskNum: task?.num || null,
    discipline: task?.discipline || disciplineOf(task?.title || ''),
    question: question.slice(0, 2000),
    context: String(context || '').trim().slice(0, 3000),
    options: (Array.isArray(options) ? options : [options]).map((o) => String(o || '').trim()).filter(Boolean).slice(0, 6),
    assumption: String(assumption || '').trim().slice(0, 1000),
    artifactIds,
    source,
    status: 'open',
    createdAt: Date.now(),
  };
  db.inbox.push(q);
  orch.feedPost(game.id, {
    kind: 'question',
    from: q.agentName,
    agentId: q.agentId,
    questionId: q.id,
    text: [q.question, q.context, q.options.length && q.options.map((o) => `- ${o}`).join('\n'), q.assumption && `Going with: ${q.assumption}`].filter(Boolean).join('\n\n'),
  });
  save();
  changed();
  return q;
}

// Sends an answer to the agent that asked (or the team, when that agent is gone).
function deliver(q, text, why = '') {
  const agent = orch.getAgent(q.agentId);
  const msg = `ANSWER to your question${q.taskNum ? ` on #${q.taskNum}` : ''}: "${q.question.slice(0, 300)}"\n${text}${why ? `\n${why}` : ''}\n${q.assumption ? `(You went with: ${q.assumption.slice(0, 200)}. If that differs, adjust it, or add a board task if it's bigger than a quick fix.)` : ''}`;
  if (agent) orch.postNote(q.gameId, { target: agent.id, text: msg, source: 'answer' });
  else orch.postNote(q.gameId, { text: msg, source: 'answer' });
}

export function answer(id, text) {
  const q = db.inbox.find((x) => x.id === id);
  if (!q) throw Object.assign(new Error('Unknown question'), { status: 400 });
  text = String(text || '').trim();
  if (!text) throw Object.assign(new Error('Write an answer first.'), { status: 400 });
  Object.assign(q, { status: 'answered', answer: text, answeredAt: Date.now() });
  deliver(q, text);
  save();
  changed();
  settleOthers(q).catch((err) => { q.settleError = err.message; delete q.settling; save(); changed(); });
  return q;
}

// A note triage turned into no tasks (and no ticket covers it): shown in the Inbox so a dropped note
// gets noticed. "Add as a task anyway" puts it on the board as written; dismissing leaves it off.
export function droppedNote({ game, note, why }) {
  const q = {
    id: uid('q'),
    gameId: game.id,
    agentId: null,
    agentName: 'Ballast triage',
    taskId: null,
    taskNum: null,
    noteNum: note.num,
    discipline: 'other',
    question: `Note #${note.num} made no tasks. Should it go on the board?`,
    context: `Your note: ${String(note.text || '').slice(0, 1500)}${note.attachments?.length ? `\n\nAttached: ${note.attachments.map((a) => a.name || a.path).join(', ')}` : ''}\n\nTriage's reason: ${why || '(none given)'}`,
    options: [],
    assumption: 'Left off the board',
    artifactIds: [],
    source: 'dropped-note',
    status: 'open',
    createdAt: Date.now(),
  };
  db.inbox.push(q);
  save();
  changed();
  return q;
}

export function addNoteAsTask(id) {
  const q = db.inbox.find((x) => x.id === id);
  if (!q || q.source !== 'dropped-note') throw Object.assign(new Error('That isn\'t a dropped note.'), { status: 400 });
  if (q.status !== 'open') throw Object.assign(new Error('Already handled.'), { status: 400 });
  const note = orch.readFeed(q.gameId, 5000).find((e) => e.kind === 'note' && e.num === q.noteNum);
  const text = note?.text || q.context.replace(/^Your note: /, '').split('\n\nTriage')[0];
  const t = orch.addTask(q.gameId, {
    title: (text.split('\n').find((l) => l.trim()) || `Note #${q.noteNum}`).trim().slice(0, 120),
    detail: `${text}${note?.attachments?.length ? `\n\nAttached files (open them with the Read tool):\n${note.attachments.map((a) => `- ${a.path}`).join('\n')}` : ''}\n\nFrom director note #${q.noteNum}, added as written after triage made no tasks from it.`,
    noteNum: q.noteNum,
  });
  Object.assign(q, { status: 'answered', answer: `Added to the board as #${t.num}.`, answeredAt: Date.now() });
  orch.feedPost(q.gameId, { kind: 'system', text: `Note #${q.noteNum} is on the board as #${t.num}.` });
  save();
  changed();
  return t;
}

export function dismiss(id) {
  const q = db.inbox.find((x) => x.id === id);
  if (q) Object.assign(q, { status: 'dismissed', answeredAt: Date.now() });
  save();
  changed();
}

// ---------------------------------------------------------------------------
// One answer, several questions

const SETTLE_SCHEMA = {
  type: 'object',
  required: ['settled'],
  properties: {
    settled: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'why', 'answer'],
        properties: {
          id: { type: 'string', description: 'The id of an open question this answer fully settles.' },
          why: { type: 'string', description: 'One short sentence for the director: how the answer settles it.' },
          answer: { type: 'string', description: "The director's decision as it applies to this question, for the agent who asked it. Use the director's own words where they fit; add nothing they didn't decide." },
        },
      },
    },
  },
};

const brief = (x) => [`Question: ${x.question}`, x.context && `Context: ${x.context.slice(0, 600)}`, x.options?.length && `Options: ${x.options.join(' | ')}`, x.assumption && `Agent went with: ${x.assumption.slice(0, 300)}`].filter(Boolean).join('\n');

async function settleOthers(q) {
  const others = db.inbox.filter((x) => x.status === 'open' && x.gameId === q.gameId && x.id !== q.id && x.source !== 'dropped-note').slice(-40);
  if (!others.length) return;
  const acct = db.accounts.filter((a) => a.loggedIn && !(a.limitedUntil > Date.now()) && orch.utilization(a) * 100 < (db.settings.limitGuardPct || 95)).sort(pace.compareAccounts)[0];
  if (!acct) return;
  q.settling = true;
  changed();
  const prompt = `The director of a game just answered one of the open questions their AI agents asked. Find which OTHER open questions that answer already settles, so they can be closed instead of waiting.

The answered question (${new Date(q.createdAt).toLocaleString()}):
${brief(q)}
The director's answer: ${q.answer}

Other open questions in the same game:
${others.map((x) => `--- id ${x.id} (asked ${new Date(x.createdAt).toLocaleString()} by ${x.agentName}${x.taskNum ? ` on #${x.taskNum}` : ''})\n${brief(x)}`).join('\n')}

List a question only when the answer decides it: the same decision asked again, an older or narrower version of it, or a case the answer plainly covers. A question on the same topic that needs a different decision stays open. When unsure, leave it open. For each one you list, write what the director's decision means for that question, for the agent who asked it.`;
  try {
    const { result } = await claude.runQuick({
      account: acct,
      args: ['--model', db.settings.settleModel || 'sonnet', '--tools', 'Read', '--permission-mode', 'dontAsk', '--json-schema', JSON.stringify(SETTLE_SCHEMA)],
      prompt,
    });
    if (result) recordUsage({ account: acct, gameId: q.gameId, kind: 'inbox-settle', result });
    const settled = [];
    for (const s of result?.structured_output?.settled || []) {
      const x = others.find((o) => o.id === s.id);
      if (!x || x.status !== 'open') continue; // answered by hand meanwhile
      const text = String(s.answer || q.answer).trim();
      Object.assign(x, { status: 'answered', answer: text, answeredAt: Date.now(), supersededBy: q.id, settledWhy: String(s.why || '').trim() });
      deliver(x, text, `(This follows the director's answer to "${q.question.slice(0, 200)}": ${q.answer.slice(0, 400)})`);
      settled.push(x);
    }
    if (settled.length) {
      q.settled = [...(q.settled || []), ...settled.map((x) => x.id)];
      orch.feedPost(q.gameId, {
        kind: 'system',
        text: `Your answer to "${q.question.slice(0, 160)}" also settled ${settled.length} other question${settled.length > 1 ? 's' : ''}:\n${settled.map((x) => `- ${x.question.slice(0, 160)} (${x.agentName}${x.taskNum ? `, #${x.taskNum}` : ''}): ${x.settledWhy}`).join('\n')}\nTheir agents have the answer. Reopen any of them in the Inbox if that's wrong.`,
      });
    }
  } finally {
    delete q.settling;
    save();
    changed();
  }
}

// Undo: a question closed by another answer opens again, and its agent is told to disregard it.
export function reopen(id) {
  const x = db.inbox.find((q) => q.id === id);
  if (!x || x.status !== 'answered' || !x.supersededBy) throw Object.assign(new Error('Only a question closed by another answer can be reopened here.'), { status: 400 });
  const parent = db.inbox.find((q) => q.id === x.supersededBy);
  if (parent?.settled) parent.settled = parent.settled.filter((s) => s !== x.id);
  const agent = orch.getAgent(x.agentId);
  const msg = `Disregard the answer you got to "${x.question.slice(0, 300)}": it was matched from another question by mistake. The question is open again; keep going with your assumption until the director answers it.`;
  if (agent) orch.postNote(x.gameId, { target: agent.id, text: msg, source: 'answer' });
  Object.assign(x, { status: 'open' });
  for (const k of ['answer', 'answeredAt', 'supersededBy', 'settledWhy']) delete x[k];
  save();
  changed();
  return x;
}
