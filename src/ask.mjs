// Conversation mode: questions for Claude from a game's feed. Each question goes to the account
// with the most weekly room right now, which reads the repo (and the web) but changes nothing.
// Answers stay between you and Claude: agents only ever read notes, never these.
// It can also troubleshoot Ballast itself: every question comes with a read-only diagnostics snapshot
// (live agent state, accounts, board, errors, logs, schedules; live checks for troubleshooting
// questions) and read access to Ballast's own source, so a symptom can be traced to its cause.
import fs from 'node:fs';
import path from 'node:path';
import { db, save, paths, attachmentsDir, uid } from './store.mjs';
import { bus, changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import { recordUsage } from './usage.mjs';
import * as roadmap from './roadmap.mjs';
import * as policy from './policy.mjs';
import * as diagnostics from './diagnostics.mjs';
import * as git from './git.mjs';
import * as jungledocs from './jungledocs.mjs';

const busy = new Map(); // gameId -> askId
const HISTORY = 6; // earlier Q&A pairs carried into each question

const must = (v, msg, status = 400) => { if (!v) throw Object.assign(new Error(msg), { status }); return v; };

// Most weekly room first; the session limit breaks ties.
export function pickAccount() {
  return db.accounts
    .filter((a) => a.loggedIn && !(a.limitedUntil > Date.now()))
    .sort((a, b) => policy.pct(a, 'weekly') - policy.pct(b, 'weekly') || policy.pct(a, 'session') - policy.pct(b, 'session'))[0] || null;
}

export function context(game) {
  const tasks = db.tasks.filter((t) => t.gameId === game.id);
  const list = (status, n) => tasks.filter((t) => t.status === status).slice(-n).map((t) => `- #${t.num} ${t.title}`).join('\n') || '(none)';
  const rm = roadmap.publicRoadmap(game);
  const ms = rm?.milestones?.find((m) => m.id === rm.active);
  const notes = orch.readFeed(game.id, 400).filter((e) => e.kind === 'note' && !e.to).slice(-3);
  const agents = db.agents.filter((a) => a.gameId === game.id && !a.retired);
  return `Game brief:
${game.brief?.trim().slice(0, 3000) || '(none)'}

Status: ${game.status || 'active'}${game.releases?.length ? `, shipped ${game.releases.map((r) => r.version).filter(Boolean).join(', ')}` : ''}. ${agents.length} agents: ${agents.map((a) => `${a.name} (${orch.publicAgentStatus(a)})`).join(', ') || 'none'}.
${ms ? `Roadmap: working toward "${ms.name}", ${Math.round(ms.progress * 100)}% there, ${ms.remaining} tasks left${ms.eta ? `, forecast ${new Date(ms.eta).toDateString()}` : ''}. Features: ${rm.features.map((f) => `${f.name} L${f.level}`).join('; ')}.\n` : ''}
Board: ${tasks.filter((t) => t.status === 'done').length} done.
In progress:
${list('claimed', 15)}
Open:
${list('open', 20)}
Blocked:
${list('blocked', 10)}

Latest notes from the director to the team:
${notes.map((n) => `- #${n.num}: ${n.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n') || '(none)'}`;
}

function systemPrompt(game, folder, diag) {
  return `You are answering questions from ${orch.directorName()}, the solo developer of the game "${game.name}", inside Ballast (the app that runs their team of AI agents). You are a knowledgeable collaborator in a conversation, not one of the agents building the game.

- Answer directly and concisely in Markdown. Lead with the answer.
- The game's files are in ${folder}. When the answer depends on the code, assets or design docs, look before answering and name the files you relied on.
- Don't change files or run builds; you can read files and search the web.
- If they ask for a change to the game, explain what you'd change and tell them they can send it to the team as a note with the "Send to team" button under your answer.
- They think in terms of look and feel; explain technical things in player-facing terms first.
${diag ? `
Troubleshooting Ballast itself: when the question is about Ballast not doing what they expect (an agent stuck or idle, a ticket nobody claims, a queue that doesn't move, an error in the feed, a schedule that didn't run, numbers that look wrong, anything "not working"), diagnose it properly:
1. Read ${diag}/index.md, then the snapshot files it lists: they show Ballast's live state, taken when this question was asked.${diag && fs.existsSync(path.join(diag, 'checks.md')) ? ' checks.md has live checks of the network, the repo clone and the tools, run just now.' : ''}
2. Read Ballast's own source (${diagnostics.SOURCE_DIR}, src/ for the server) to see exactly what the code does in that situation: which condition holds the work back, which setting decides it, what error path was taken.
3. Answer with the cause, the evidence (the snapshot field or log line, and the source file and function), and the fix: what they can click or change in Ballast, or, if Ballast itself is at fault, the change it needs, precise enough to hand to someone fixing Ballast.
Don't guess when the snapshot can tell you. Say plainly when something is outside what you can see (a cloud session's own work on claude.ai, for instance).` : ''}

What Ballast knows about the game right now:
${context(game)}`;
}

// Earlier questions and answers since the last "New conversation", oldest first.
function history(game) {
  const since = game.askSince || 0;
  const feed = orch.readFeed(game.id, 600).filter((e) => (e.kind === 'ask' || e.kind === 'answer') && e.ts > since);
  const pairs = [];
  for (const q of feed.filter((e) => e.kind === 'ask')) {
    const a = feed.find((e) => e.kind === 'answer' && e.askId === q.askId);
    if (a && !a.error) pairs.push({ q: q.text, a: a.text });
  }
  return pairs.slice(-HISTORY);
}

export function ask(gameId, { text = '', attachments = [] } = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  text = String(text).trim();
  must(text || attachments.length, 'Ask a question first.');
  must(!busy.has(gameId), 'Claude is still answering the last question.', 409);
  const acct = must(pickAccount(), 'No logged-in account has usage free right now.');
  const askId = uid('ask');
  const prior = history(game);
  orch.feedPost(gameId, { kind: 'ask', askId, from: orch.directorName(), text, attachments, to: acct.name, accountId: acct.id });
  busy.set(gameId, askId);
  changed();
  run(game, acct, askId, text, attachments, prior).finally(() => { busy.delete(gameId); changed(); });
  return { askId, account: acct.name, weekly: Math.round(policy.pct(acct, 'weekly')) };
}

async function run(game, acct, askId, text, attachments, prior) {
  const folder = game.subdir ? path.join(game.repoPath, game.subdir) : game.repoPath;
  fs.mkdirSync(attachmentsDir(game.id), { recursive: true });
  // A cloud game's files are Ballast's own copy of the repo, which otherwise only refreshes for builds,
  // GDD runs and asset scans: bring it up to the base branch so answers read what's really on GitHub.
  // Local edits someone made in that copy are saved as a patch first (git.syncClone) and named here.
  if (game.runner === 'cloud' && game.repoPath && fs.existsSync(path.join(game.repoPath, '.git'))) {
    try {
      const r = await git.syncClone(game.repoPath, game.baseBranch);
      if (r.backup) orch.feedPost(game.id, { kind: 'system', text: `Ballast's copy of the repo had local edits (${r.changed.slice(0, 6).join(', ')}${r.changed.length > 6 ? ', …' : ''}). They were saved to ${r.backup} before refreshing the copy to ${game.baseBranch}.` });
    } catch (err) {
      console.error('[ballast] ask: refreshing the clone failed', err.message);
    }
  }
  // A fresh read-only snapshot of Ballast's state; live checks only for troubleshooting questions.
  let diag = null;
  try { diag = await diagnostics.snapshot(game, { live: diagnostics.looksLikeTroubleshooting(text) }); } catch (err) { console.error('[ballast] diagnostics', err.message); }
  const sysFile = path.join(paths.tmp, `ask-${game.id}.md`);
  fs.writeFileSync(sysFile, systemPrompt(game, folder, diag) + jungledocs.forRun(game).text);
  const files = attachments.filter((a) => a.path).map((a) => `- ${a.name}: ${a.path}`).join('\n');
  const prompt = `${prior.length ? `Our conversation so far:\n\n${prior.map((p) => `Q: ${p.q}\n\nA: ${p.a.slice(0, 2500)}`).join('\n\n---\n\n')}\n\n---\n\n` : ''}${text || '(see the attached files)'}${files ? `\n\nAttached (open with Read):\n${files}` : ''}`;
  let live = '';
  let lastEmit = 0;
  const emit = (force = false) => {
    if (!force && Date.now() - lastEmit < 150) return;
    lastEmit = Date.now();
    bus.emit('event', { type: 'ask', gameId: game.id, askId, account: acct.name, text: live });
  };
  try {
    const { result, stderr, code } = await claude.runQuick({
      account: acct,
      cwd: fs.existsSync(folder || '') ? folder : undefined,
      args: [
        '--include-partial-messages',
        '--append-system-prompt-file', sysFile,
        '--tools', 'Read,Glob,Grep,WebSearch,WebFetch',
        '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
        '--add-dir', attachmentsDir(game.id), paths.studioAttachments, ...(diag ? [diag, diagnostics.SOURCE_DIR] : []), ...jungledocs.forRun(game).args,
        ...(db.settings.askModel ? ['--model', db.settings.askModel] : []),
      ],
      prompt,
      onMessage: (msg) => {
        if (msg.type === 'stream_event' && !msg.parent_tool_use_id && msg.event?.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
          live += msg.event.delta.text;
          emit();
        } else if (msg.type === 'stream_event' && msg.event?.type === 'message_start' && live) {
          live += '\n\n'; // a new assistant message after a tool call
        } else if (msg.type === 'rate_limit_event') {
          orch.updateUsage(acct, msg.rate_limit_info || {});
        }
      },
    });
    if (result) recordUsage({ account: acct, gameId: game.id, kind: 'ask', result });
    const answer = (result?.result || live).trim();
    if (!answer) throw new Error(result?.is_error ? 'Claude returned an error.' : (stderr || `claude exited with ${code}`).trim().split('\n').slice(-2).join(' ').slice(0, 300));
    orch.feedPost(game.id, { kind: 'answer', askId, from: acct.name, accountId: acct.id, text: answer, cost: result?.total_cost_usd || 0 });
  } catch (err) {
    orch.feedPost(game.id, { kind: 'answer', askId, from: acct.name, accountId: acct.id, error: true, text: `Couldn't answer: ${err.message}` });
  }
  emit(true);
}

// Starts a new conversation: earlier questions stop being carried into new ones.
export function reset(gameId) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  game.askSince = Date.now();
  save();
  changed();
  return { ok: true };
}

export const isBusy = (gameId) => busy.has(gameId);
