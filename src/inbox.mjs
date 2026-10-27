// Director's Inbox: one place for every question any agent has, across games and accounts.
// Asking never blocks: the agent records the assumption it's going with and keeps working;
// the director's answer is sent back to that agent as a message.
import { db, save, uid } from './store.mjs';
import { changed } from './bus.mjs';
import * as orch from './orchestrator.mjs';
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

export function answer(id, text) {
  const q = db.inbox.find((x) => x.id === id);
  if (!q) throw Object.assign(new Error('Unknown question'), { status: 400 });
  text = String(text || '').trim();
  if (!text) throw Object.assign(new Error('Write an answer first.'), { status: 400 });
  Object.assign(q, { status: 'answered', answer: text, answeredAt: Date.now() });
  const agent = orch.getAgent(q.agentId);
  const msg = `ANSWER to your question${q.taskNum ? ` on #${q.taskNum}` : ''}: "${q.question.slice(0, 300)}"\n${text}\n${q.assumption ? `(You went with: ${q.assumption.slice(0, 200)}. If that differs, adjust it, or add a board task if it's bigger than a quick fix.)` : ''}`;
  if (agent) orch.postNote(q.gameId, { target: agent.id, text: msg, source: 'answer' });
  else orch.postNote(q.gameId, { text: msg, source: 'answer' }); // agent is gone: the team gets it
  save();
  changed();
  return q;
}

export function dismiss(id) {
  const q = db.inbox.find((x) => x.id === id);
  if (q) Object.assign(q, { status: 'dismissed', answeredAt: Date.now() });
  save();
  changed();
}
