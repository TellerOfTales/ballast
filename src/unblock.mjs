// Blocked tickets triage themselves. When a ticket blocks, Claude (on the account with the most
// weekly room) reads the ticket and the repo and decides one of:
//   retry    : an agent can still do it another way: rewrite the ticket and put it back
//   split    : part can go ahead: this ticket becomes that part, the rest waits on a person
//   human    : only a person can unblock it (access, hardware, accounts, payment, a decision):
//              a Human Intervention request with precise steps, and what a Cowork Claude would
//              need authorization to do if you'd rather hand it off
//   obsolete : no longer needed: asks you to confirm closing it
// One intervention can unblock several tickets (one headset, one network allowlist); resolving it
// puts every ticket waiting on it back on the board.
import path from 'node:path';
import fs from 'node:fs';
import { db, save, uid } from './store.mjs';
import { changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import { recordUsage } from './usage.mjs';
import { pickAccount, context } from './ask.mjs';

const MAX_RETRIES = 2; // automatic retries per ticket before it has to go to a person
const PARALLEL = 2;
const running = new Set(); // taskId
const must = (v, msg, status = 400) => { if (!v) throw Object.assign(new Error(msg), { status }); return v; };
const strs = { type: 'array', items: { type: 'string' } };
const ticketShape = { type: 'object', required: ['title', 'detail'], properties: { title: { type: 'string' }, detail: { type: 'string', description: 'Self-contained: the agent who picks it up sees only this.' } } };

export const KINDS = { access: 'Access or permissions', hardware: 'Hardware or a device', account: 'An account or service', payment: 'Payment', decision: 'Your decision', content: 'Content only you can make', other: 'Something else' };

const SCHEMA = {
  type: 'object',
  required: ['verdict', 'reason', 'retry', 'human', 'split'],
  properties: {
    verdict: { enum: ['retry', 'split', 'human', 'obsolete'] },
    reason: { type: 'string', description: 'Why, in two or three plain sentences.' },
    retry: { ...ticketShape, type: ['object', 'null'], description: 'Required for retry and split (the ticket rewritten so an agent can do it now, another way); null otherwise.' },
    human: {
      type: ['object', 'null'],
      description: 'Required for human and split (what only a person can do); null otherwise.',
      required: ['existing', 'title', 'kind', 'who', 'why', 'steps', 'authorization', 'coworkBrief', 'verify', 'minutes'],
      properties: {
        existing: { type: ['string', 'null'], description: 'The id of an open intervention below that this is the same need as, else null.' },
        title: { type: 'string', description: 'The action, imperative and specific, e.g. "Allow freesound.org in the Claude cloud environment\'s network access".' },
        kind: { enum: Object.keys(KINDS) },
        who: { enum: ['you', 'you-or-cowork'], description: 'you: only the person can (physical device, their decision, their own voice, signing up to something). you-or-cowork: a Cowork Claude with the right authorization could do it instead.' },
        why: { type: 'string', description: 'What it unblocks, for the player, in one or two sentences.' },
        steps: { ...strs, description: 'Exact numbered steps for a person: where to click or what to run, with real names, URLs and values. Nothing vague.' },
        authorization: { ...strs, description: 'For a Cowork Claude: exactly what it needs permission to do, each scoped (which site, which account, which setting, read or write). Empty if who is "you".' },
        coworkBrief: { type: 'string', description: 'A paste-ready brief for a Cowork Claude doing this on the person\'s behalf: goal, the exact change, what it must not touch, how to confirm. Empty if who is "you".' },
        verify: { type: 'string', description: 'How the person can tell it worked.' },
        minutes: { type: 'integer', description: 'Rough time it takes a person.' },
      },
    },
    split: { type: ['object', 'null'], required: ['waiting'], properties: { waiting: ticketShape }, description: 'Required for split (the part that has to wait for the person, as its own ticket); null otherwise.' },
  },
};

const folderOf = (game) => (game.subdir ? path.join(game.repoPath, game.subdir) : game.repoPath);
const openInterventions = (gameId) => db.interventions.filter((i) => i.gameId === gameId && i.status === 'open');
// A ticket is triaged when it blocks, again if it blocks again after a retry, and again if its
// block reason changes; never while a person is on it, and not again after you dismiss it.
function needsTriage(t) {
  if (t.status !== 'blocked' || t.human || running.has(t.id)) return false;
  const tr = t.triage;
  if (!tr) return true;
  const same = tr.reason === (t.blockReason || '');
  if (tr.status === 'running') return false;
  if (tr.status === 'error') return Date.now() - (tr.at || 0) > 30 * 60e3; // try failures again later
  if (same && (tr.dismissed || ['human', 'stuck', 'obsolete'].includes(tr.verdict))) return false;
  return true;
}

function prompt(t, game) {
  const retries = t.triage?.retries || 0;
  const open = openInterventions(game.id);
  return `A ticket on the board of "${game.name}" is blocked. Triage it: work out whether an AI agent can still get it done another way, or whether it truly needs a person.

The team: AI agents${game.runner === 'cloud' ? ' running as Claude Code cloud sessions on GitHub (they can\'t reach this PC, a headset, or sites outside the environment\'s network allowlist)' : ' running on the developer\'s PC'}. They can read and write code, run tests and builds, and use the web, but they can't touch physical devices, sign in to accounts, pay for things, change the settings of services, record a human voice, or make the director's look-and-feel calls.

Read the code and docs the ticket touches before deciding (the game is in ${folderOf(game)}).
- retry: an agent can do it a different way (a workaround, a simulation, a smaller version, a library already in the repo). Rewrite the ticket with that approach.${retries >= MAX_RETRIES ? ` NOT ALLOWED this time: it has already been retried ${retries} times.` : ''}
- split: part of it can go ahead now; the rest waits on a person.
- human: only a person can unblock it. Be precise: real steps, real names. If a Cowork Claude (an assistant that can use the person's browser and apps when given permission) could do it instead, say exactly what it needs authorization for.
- obsolete: it's no longer needed (done elsewhere, superseded).
Prefer retry or split over human when there is any honest way forward: a blocked ticket costs the game time.
${open.length ? `\nOpen Human Intervention requests on this game (if this ticket waits on the same thing, use its id in human.existing):\n${open.map((i) => `- ${i.id}: ${i.title}`).join('\n')}\n` : ''}
The ticket:
#${t.num} ${t.title}
Priority: ${['low', 'normal', 'high', 'urgent'][t.priority ?? 1]}${retries ? ` · already retried ${retries} time${retries > 1 ? 's' : ''} after earlier blocks` : ''}
Why it's blocked:
${t.blockReason || '(no reason given)'}
Detail:
${t.detail || '(none)'}
${t.summary ? `\nWhat the agent reported:\n${t.summary}` : ''}

The game:
${context(game)}`;
}

export async function triage(taskId) {
  const t = must(db.tasks.find((x) => x.id === taskId), 'Unknown task');
  const game = must(orch.getGame(t.gameId), 'Unknown game');
  must(t.status === 'blocked', 'Only blocked tickets are triaged.');
  if (running.has(t.id)) return { running: true };
  const acct = must(pickAccount(), 'No logged-in account has usage free right now.');
  running.add(t.id);
  const reason = t.blockReason || '';
  t.triage = { ...(t.triage || {}), status: 'running', at: Date.now(), reason };
  changed();
  try {
    const folder = folderOf(game);
    const { result } = await claude.runQuick({
      account: acct,
      cwd: fs.existsSync(folder || '') ? folder : undefined,
      args: ['--model', db.settings.triageModel || 'sonnet', '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', '--json-schema', JSON.stringify(SCHEMA)],
      prompt: prompt(t, game),
    });
    if (result) recordUsage({ account: acct, gameId: game.id, kind: 'unblock', result });
    const out = must(result?.structured_output?.verdict && result.structured_output, result?.result?.slice(0, 200) || 'Triage returned nothing.');
    act(t, game, out);
  } catch (err) {
    t.triage = { ...(t.triage || {}), status: 'error', error: err.message };
  } finally {
    running.delete(t.id);
    save();
    changed();
  }
  return t.triage;
}

function attach(t, game, h) {
  let iv = h.existing && db.interventions.find((i) => i.id === h.existing && i.status === 'open' && i.gameId === game.id);
  if (!iv) {
    iv = {
      id: uid('hi'), gameId: game.id, status: 'open', createdAt: Date.now(), taskIds: [],
      title: h.title, kind: KINDS[h.kind] ? h.kind : 'other', who: h.who === 'you' ? 'you' : 'you-or-cowork',
      why: h.why, steps: h.steps || [], authorization: h.who === 'you' ? [] : h.authorization || [], coworkBrief: h.who === 'you' ? '' : h.coworkBrief || '',
      verify: h.verify || '', minutes: h.minutes || null,
    };
    db.interventions.push(iv);
    orch.feedPost(game.id, { kind: 'error', text: `🙋 Needs you: ${iv.title}. It's blocking #${t.num} ${t.title}. Steps are in your Inbox${iv.who === 'you-or-cowork' ? ' (a Cowork Claude can do it with your authorization)' : ''}.` });
  } else {
    orch.feedPost(game.id, { kind: 'system', text: `#${t.num} is waiting on the same thing as ${iv.taskIds.map((id) => `#${db.tasks.find((x) => x.id === id)?.num}`).join(', ')}: ${iv.title}.` });
  }
  if (!iv.taskIds.includes(t.id)) iv.taskIds.push(t.id);
  t.human = iv.id;
  return iv;
}

export function act(t, game, out) {
  const retries = t.triage?.retries || 0;
  let verdict = out.verdict;
  // A verdict without the part it needs is a bad run, not a stuck ticket: try again later.
  if ((verdict === 'retry' || verdict === 'split') && !out.retry) verdict = out.human ? 'human' : null;
  if (verdict === 'split' && !out.human) verdict = 'retry';
  if (verdict === 'human' && !out.human) verdict = out.retry ? 'retry' : null;
  if (!verdict) throw new Error(`Triage said "${out.verdict}" without the details that go with it.`);
  if (verdict === 'retry' && retries >= MAX_RETRIES) verdict = out.human ? 'human' : 'retry-denied';
  t.triage = { status: 'done', at: Date.now(), reason: t.blockReason || '', verdict, why: out.reason, retries };

  if (verdict === 'retry' || verdict === 'split') {
    const old = t.title;
    orch.updateTask(t.id, { title: out.retry.title, detail: `${out.retry.detail}\n\n(Self-triage: the earlier attempt blocked on: ${(t.blockReason || '').slice(0, 400)})`, status: 'open' });
    t.triage.retries = retries + 1;
    t.note = `Self-triaged: ${out.reason}`.slice(0, 300);
    orch.feedPost(game.id, { kind: 'task', from: 'Self-triage', text: `#${t.num} unblocked itself: ${out.reason}${old !== t.title ? ` Now: ${t.title}.` : ''}` });
  }
  if (verdict === 'split') {
    const w = out.split?.waiting || { title: `${t.title}: the part that needs a person`, detail: out.human.why };
    const nt = orch.addTask(game.id, { title: w.title, detail: w.detail, createdBy: 'Self-triage' });
    orch.updateTask(nt.id, { status: 'blocked', blockReason: out.human.why, priority: t.priority ?? 1 });
    nt.triage = { status: 'done', at: Date.now(), reason: nt.blockReason, verdict: 'human', why: out.reason, retries: 0 };
    attach(nt, game, out.human);
  }
  if (verdict === 'human') attach(t, game, out.human);
  if (verdict === 'obsolete') {
    attach(t, game, { title: `Close #${t.num}? It looks like it's no longer needed`, kind: 'decision', who: 'you', why: out.reason, steps: ['Read why below. If you agree, press "Close the ticket"; otherwise "Dismiss" and it stays blocked.'], verify: '', minutes: 1 });
    db.interventions.find((i) => i.id === t.human).closeSuggested = true;
  }
  if (verdict === 'retry-denied') {
    t.triage.verdict = 'stuck';
    orch.feedPost(game.id, { kind: 'error', text: `#${t.num} has blocked ${retries + 1} times and triage couldn't find a person-only cause. Talk it through from the Board (Work it out with Claude).` });
  }
}

// ---------------------------------------------------------------------------
// Resolving a request

export function resolve(id, { note = '', close = false } = {}) {
  const iv = must(db.interventions.find((i) => i.id === id), 'Unknown request');
  iv.status = 'done';
  iv.resolvedAt = Date.now();
  iv.note = String(note || '').trim().slice(0, 1000);
  const reopened = [];
  for (const tid of iv.taskIds) {
    const t = db.tasks.find((x) => x.id === tid);
    if (!t) continue;
    delete t.human;
    if (close || iv.closeSuggested) {
      orch.updateTask(t.id, { status: 'done', summary: `Closed: ${iv.closeSuggested ? 'no longer needed' : iv.title}.${iv.note ? ` ${iv.note}` : ''}` });
      continue;
    }
    if (t.status !== 'blocked') continue;
    orch.updateTask(t.id, { status: 'open', detail: `${t.detail || ''}\n\nUnblocked: the director did "${iv.title}".${iv.note ? ` Their note: ${iv.note}` : ''} Carry on from the block reason: ${(t.blockReason || '').slice(0, 300)}` });
    t.triage = { ...(t.triage || {}), resolvedBy: iv.id };
    reopened.push(`#${t.num}`);
  }
  orch.feedPost(iv.gameId, { kind: 'task', from: orch.directorName(), text: iv.closeSuggested || close ? `Closed after review: ${iv.title}` : `Done: ${iv.title}.${reopened.length ? ` ${reopened.join(', ')} back on the board.` : ''}${iv.note ? ` ${iv.note}` : ''}` });
  save();
  changed();
  return iv;
}

export function dismiss(id) {
  const iv = must(db.interventions.find((i) => i.id === id), 'Unknown request');
  iv.status = 'dismissed';
  iv.resolvedAt = Date.now();
  for (const tid of iv.taskIds) { const t = db.tasks.find((x) => x.id === tid); if (t) { delete t.human; t.triage = { ...(t.triage || {}), reason: t.blockReason || '', dismissed: true }; } }
  save();
  changed();
  return iv;
}

// ---------------------------------------------------------------------------
// Every minute: triage newly blocked tickets (a couple at a time, so a burst doesn't eat a week).

export function tick() {
  if (db.settings.blockTriage === false) return;
  const live = new Set(db.games.filter((g) => ['active', 'shipped', undefined].includes(g.status)).map((g) => g.id));
  const waiting = db.tasks.filter((t) => live.has(t.gameId) && needsTriage(t) && !t.triage?.dismissed)
    .sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1) || a.num - b.num);
  for (const t of waiting) {
    if (running.size >= PARALLEL) break;
    triage(t.id).catch(() => {});
  }
}

export function init() {
  for (const t of db.tasks) if (t.triage?.status === 'running') t.triage.status = 'error';
  setInterval(tick, 60e3).unref();
  setTimeout(tick, 10e3);
}

export const isRunning = (taskId) => running.has(taskId);
