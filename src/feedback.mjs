// Every review, playtest or feedback note is checked against the board's blocked tickets. Most
// tickets block on "needs a headset run" or "needs your call", and the director's next playtest
// video or profiler file is usually exactly that. For each blocked ticket Claude decides:
//   done    : the feedback confirms it works / meets its target: close it
//   reopen  : the feedback shows it isn't there yet, or supplies what it was waiting for: back on
//             the board with what the feedback showed and what to do next
//   waiting : the feedback doesn't speak to it: it stays blocked
// A Human Intervention request whose tickets all move on this way closes, answered by the note.
import fs from 'node:fs';
import path from 'node:path';
import { db, save, attachmentsDir } from './store.mjs';
import { changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import { recordUsage } from './usage.mjs';
import { pickAccount, context } from './ask.mjs';

const SOURCES = ['director', 'review', 'review-session', 'playtest'];
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const running = new Set(); // `${gameId}:${noteNum}`
const must = (v, msg, status = 400) => { if (!v) throw Object.assign(new Error(msg), { status }); return v; };
const folderOf = (game) => (game.subdir ? path.join(game.repoPath, game.subdir) : game.repoPath);

const SCHEMA = {
  type: 'object',
  required: ['tickets'],
  properties: {
    tickets: {
      type: 'array',
      description: 'One entry for every blocked ticket listed.',
      items: {
        type: 'object',
        required: ['num', 'verdict', 'evidence', 'next'],
        properties: {
          num: { type: 'integer' },
          verdict: { enum: ['done', 'reopen', 'waiting'] },
          evidence: { type: 'string', description: 'What in the feedback decides it, specifically: the numbers against the target, the timestamp and what was seen or said. For waiting, what the feedback would need to show.' },
          next: { type: 'string', description: 'For reopen: what an agent should do now, self-contained (the agent sees only the ticket). Empty otherwise.' },
        },
      },
    },
  },
};

function prompt(game, note, blocked, images) {
  const iv = (t) => t.human && db.interventions.find((i) => i.id === t.human);
  return `The director of "${game.name}" just sent feedback from a review, playtest or test run (note #${note.num}). Some tickets on the board are blocked, most of them waiting for exactly this kind of evidence: a headset run, profiler numbers, a playtest, the director's call. Check every blocked ticket against the feedback.

- done: the feedback shows the ticket's goal is met (it works in the playtest, the profiler numbers meet the ticket's stated target, the director approved it). Be strict: done needs evidence for what the ticket itself said it was waiting to confirm. A partial improvement that still misses the target is not done.
- reopen: the feedback speaks to the ticket and shows it isn't there yet (still broken, misses its target, the director doesn't like it), or it supplies what the ticket was waiting for so an agent can carry on (the director's decision, the data). In "next", say exactly what an agent should do now, with the numbers or moments from the feedback.
- waiting: the feedback doesn't speak to it (a different feature, or what it needs isn't in the feedback). It stays blocked.
If two tickets would be reopened for the same remaining work, reopen only one and make the other done, saying in evidence which ticket carries the rest. Tickets that other, newer tickets already cover can be done the same way.
${images.length ? `\nImages that came with the feedback (open them with Read if they help):\n${images.map((p) => `- ${p}`).join('\n')}\n` : ''}
The feedback, note #${note.num}:
"""
${note.text.slice(0, 60000)}
"""

The blocked tickets:
${blocked.map((t) => `\n#${t.num} ${t.title}
Why it's blocked: ${(t.blockReason || '(no reason given)').slice(0, 3000)}${iv(t) ? `\nWaiting on the person to: ${iv(t).title}${iv(t).verify ? ` (they'll know it worked when: ${iv(t).verify})` : ''}` : ''}
Detail: ${(t.detail || '(none)').slice(0, 1500)}`).join('\n')}

Other open work on the board (for spotting tickets that newer ones cover):
${db.tasks.filter((t) => t.gameId === game.id && ['open', 'claimed', 'review'].includes(t.status)).map((t) => `- #${t.num} [${t.status}] ${t.title}`).join('\n').slice(0, 6000) || '(none)'}

The game:
${context(game)}`;
}

// Runs the check for one note. `note` is { num, text, attachments }.
export async function check(gameId, note, { quiet = false } = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const key = `${gameId}:${note.num}`;
  if (running.has(key)) return { running: true };
  const blocked = db.tasks.filter((t) => t.gameId === gameId && t.status === 'blocked');
  if (!blocked.length) {
    if (!quiet) orch.feedPost(gameId, { kind: 'system', text: `Note #${note.num}: no blocked tickets to check it against.` });
    return { tickets: [] };
  }
  const acct = must(pickAccount(), 'No logged-in account has usage free right now.');
  running.add(key);
  orch.feedPost(gameId, { kind: 'system', text: `Checking note #${note.num} against the ${blocked.length} blocked ticket${blocked.length > 1 ? 's' : ''} (${blocked.map((t) => `#${t.num}`).join(', ')}): does it confirm them, or send them back?` });
  try {
    // Cloud notes already carry their text files; local ones get them here.
    const text = game.runner === 'cloud' || /\nAttached file /.test(note.text || '') ? note.text || '' : `${note.text || ''}${orch.inlineAttachments(note.attachments || []).text}`;
    const images = (note.attachments || []).filter((a) => IMAGE.test(a.name) && a.path && fs.existsSync(a.path)).map((a) => a.path).slice(0, 30);
    const folder = folderOf(game);
    const { result } = await claude.runQuick({
      account: acct,
      cwd: fs.existsSync(folder || '') ? folder : undefined,
      args: ['--model', db.settings.feedbackModel || 'sonnet', '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', '--add-dir', attachmentsDir(gameId), '--json-schema', JSON.stringify(SCHEMA)],
      prompt: prompt(game, { ...note, text }, blocked, images),
    });
    if (result) recordUsage({ account: acct, gameId, kind: 'unblock', result });
    const out = must(result?.structured_output?.tickets && result.structured_output, result?.result?.slice(0, 200) || 'The check returned nothing.');
    return act(game, note, blocked, out.tickets);
  } catch (err) {
    orch.feedPost(gameId, { kind: 'error', text: `Couldn't check note #${note.num} against the blocked tickets: ${err.message}` });
    throw err;
  } finally {
    running.delete(key);
  }
}

function act(game, note, blocked, verdicts) {
  const lines = [];
  const moved = [];
  for (const t of blocked) {
    const v = verdicts.find((x) => Number(x.num) === t.num);
    if (!v) continue;
    // A ticket that moved while Claude was reading (an agent, you) is left alone.
    if (t.status !== 'blocked') continue;
    t.feedbackCheck = { note: note.num, verdict: v.verdict, evidence: v.evidence, at: Date.now() };
    if (v.verdict === 'done') {
      orch.updateTask(t.id, { status: 'done', summary: `${t.summary ? `${t.summary}\n\n` : ''}Confirmed by note #${note.num}: ${v.evidence}` });
      moved.push(t);
      lines.push(`- ✅ **#${t.num} done**: ${v.evidence}`);
    } else if (v.verdict === 'reopen') {
      orch.updateTask(t.id, { status: 'open', detail: `${t.detail || ''}\n\nReopened after the director's feedback (note #${note.num}): ${v.evidence}\nWhat to do now: ${v.next || 'carry on from the block below.'}\n(It had blocked on: ${(t.blockReason || '').slice(0, 600)})` });
      t.note = `Reopened by note #${note.num}`;
      moved.push(t);
      lines.push(`- ↩️ **#${t.num} back on the board**: ${v.evidence}${v.next ? ` Next: ${v.next}` : ''}`);
    } else {
      lines.push(`- ⏸ #${t.num} still waiting: ${v.evidence}`);
    }
  }
  // Requests whose tickets all moved on are answered by this note.
  for (const iv of db.interventions.filter((i) => i.gameId === game.id && i.status === 'open')) {
    const gone = iv.taskIds.filter((id) => moved.some((t) => t.id === id));
    if (!gone.length) continue;
    for (const id of gone) { const t = db.tasks.find((x) => x.id === id); if (t?.human === iv.id) delete t.human; }
    iv.taskIds = iv.taskIds.filter((id) => !gone.includes(id));
    if (!iv.taskIds.length) Object.assign(iv, { status: 'done', resolvedAt: Date.now(), note: `Answered by note #${note.num}.` });
  }
  save();
  changed();
  const done = moved.filter((t) => t.status === 'done').length;
  const reopened = moved.length - done;
  orch.feedPost(game.id, {
    kind: 'task',
    from: 'Feedback check',
    text: `**Note #${note.num} against the blocked tickets:** ${done} done, ${reopened} back on the board, ${blocked.length - moved.length} still waiting.\n${lines.join('\n')}`,
  });
  return { tickets: verdicts, done, reopened };
}

// From the feed: re-run the check for a note you already sent.
export function checkNote(gameId, num) {
  const n = Number(num);
  const e = orch.readFeed(gameId, 5000).find((x) => x.kind === 'note' && x.num === n);
  must(e, `No note #${num} in this game's feed.`);
  must(pickAccount(), 'No logged-in account has usage free right now.');
  check(gameId, { num: e.num, text: e.text || '', attachments: e.attachments || [] }).catch(() => {});
  return { started: true };
}

export function init() {
  orch.onNote.push((game, note) => {
    if (db.settings.feedbackCheck === false || !SOURCES.includes(note.source || 'director')) return;
    check(game.id, note, { quiet: true }).catch(() => {});
  });
}

export const isRunning = (gameId, num) => running.has(`${gameId}:${num}`);
