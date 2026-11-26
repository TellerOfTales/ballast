// The GDD as something Ballast writes with the director, not just reads.
// - Versions: Ballast keeps the GDD as Markdown, numbered versions under ~/.ballast/gdd/<game>/.
//   v1 is imported from wherever the GDD lives (a Claude Docs doc, the repo's GDD files, or text the
//   director pastes or uploads).
// - Drafts: the director's feedback (typed here, or a design change triage found in a note) becomes a
//   draft. Claude reads the GDD and the code and proposes exact edits (section, the passage now, the
//   new text, why), and asks clarifying questions where the feedback leaves a real choice open. The
//   director answers and Claude revises, as many times as needed.
// - Accept: the chosen edits are applied to the current version and saved as the next one, then
//   written back where the GDD lives (the Claude Docs doc through the connector, or a [docs] ticket
//   that commits the repo's GDD files), and the GDD re-evaluation brings the board in line.
import fs from 'node:fs';
import path from 'node:path';
import { db, save, uid, HOME, paths } from './store.mjs';
import { changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import * as pace from './pace.mjs';
import * as gddreview from './gddreview.mjs';
import * as cloud from './cloud.mjs';
import * as jungledocs from './jungledocs.mjs';
import { recordUsage } from './usage.mjs';

const must = (v, msg, status = 400) => { if (!v) throw Object.assign(new Error(msg), { status }); return v; };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
const dirOf = (game) => path.join(HOME, 'gdd', game.id);
const fileOf = (game, v) => path.join(dirOf(game), `v${v}.md`);
const busy = new Set();
const DOCS = 'mcp__claude_ai_Claude_Docs__';

const state = (game) => (game.gdd ||= { versions: [], drafts: [] });
export const currentFile = (game) => { const v = state(game).versions.at(-1); return v ? fileOf(game, v.v) : null; };
export const currentText = (game) => { const f = currentFile(game); return f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
function post(game, text) { orch.feedPost(game.id, { kind: 'system', from: 'GDD', text }); }
function account() {
  return db.accounts.filter((a) => a.loggedIn && !(a.limitedUntil > Date.now()) && !a.authBroken && orch.utilization(a) * 100 < (db.settings.limitGuardPct || 95)).sort(pace.compareAccounts)[0] || null;
}

// Where the GDD lives, so accepted changes go back there.
export function sourceOf(game) {
  const pages = gddreview.gddPages(game);
  const doc = pages.find((p) => p.isDoc);
  if (doc) return { kind: 'docs', label: `Claude Docs: ${doc.title}`, artifact: doc };
  if (pages.length) return { kind: 'artifact', label: `claude.ai: ${pages[0].title} (read only: Ballast can't write to it)`, artifact: pages[0] };
  if (state(game).repoFiles?.length) return { kind: 'repo', label: `Repo: ${state(game).repoFiles.join(', ')}`, files: state(game).repoFiles };
  return { kind: 'ballast', label: 'Kept in Ballast (and committed to the repo as gdd/GDD.md when you accept changes)' };
}

function saveVersion(game, text, { summary, by, draftId = null } = {}) {
  const st = state(game);
  const v = (st.versions.at(-1)?.v || 0) + 1;
  fs.mkdirSync(dirOf(game), { recursive: true });
  fs.writeFileSync(fileOf(game, v), text);
  fs.writeFileSync(path.join(dirOf(game), 'current.md'), text);
  st.versions.push({ v, at: Date.now(), summary: clip(summary, 400), by, draftId, words: text.split(/\s+/).filter(Boolean).length });
  save(); changed();
  return v;
}

// ---------------------------------------------------------------------------
// Import

export async function importGdd(gameId, { text = null, name = '' } = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const st = state(game);
  if (text?.trim()) {
    const v = saveVersion(game, text.trim(), { summary: `Imported ${name ? `from ${name}` : 'from pasted text'}`, by: orch.directorName() });
    post(game, `GDD v${v} saved in Ballast (${name || 'pasted text'}).`);
    return publicGdd(game);
  }
  // From where it lives now: a Claude Docs doc's Markdown copy first, then the other sources.
  const { sources } = await gddreview.pullLatest(game);
  const parts = [];
  for (const p of gddreview.gddPages(game)) {
    const md = path.join(paths.cloud, p.id, 'page.md');
    if (fs.existsSync(md)) parts.push({ name: p.title, text: fs.readFileSync(md, 'utf8') });
  }
  // A tracked GDD page is the GDD; the repo's design files are used only when there's no such page
  // (otherwise they're notes and old copies, not the document).
  const tracked = gddreview.gddPages(game).length > 0;
  for (const s of sources) {
    if (s.key?.startsWith('ballast-')) continue; // its own versions
    if (s.name.startsWith('claude.ai') ? parts.length : tracked) continue; // the Markdown copy is better
    parts.push({ name: s.name, text: s.text });
  }
  st.repoFiles = tracked ? [] : sources.filter((s) => s.name.startsWith('repo: ')).map((s) => s.name.slice(6));
  must(parts.length, 'No GDD found to import: track it on claude.ai (role gdd), put it in the repo, or paste it.');
  const body = parts.length === 1 ? parts[0].text : parts.map((p) => `<!-- Source: ${p.name} -->\n\n${p.text.trim()}`).join('\n\n---\n\n');
  const v = saveVersion(game, body.trim(), { summary: `Imported from ${parts.map((p) => p.name).join(', ')}`, by: 'Ballast' });
  post(game, `GDD v${v} imported into Ballast from ${parts.map((p) => p.name).join(', ')}.`);
  return publicGdd(game);
}

// ---------------------------------------------------------------------------
// Drafts: feedback → proposed edits and clarifying questions

const DRAFT_SCHEMA = {
  type: 'object',
  required: ['summary', 'questions', 'edits'],
  properties: {
    summary: { type: 'string', description: 'Two sentences: what the edits do to the design, plainly.' },
    questions: {
      type: 'array', maxItems: 6,
      description: 'Only where the feedback leaves a real design choice open, or contradicts the GDD, and a wrong guess would cost real rework. Not for things you can decide well yourself.',
      items: { type: 'object', required: ['id', 'question', 'why'], properties: { id: { type: 'string' }, question: { type: 'string' }, why: { type: 'string', description: 'What depends on the answer.' }, options: { type: 'array', maxItems: 4, items: { type: 'string' } }, assumption: { type: 'string', description: 'What the edits assume until answered.' } } },
    },
    edits: {
      type: 'array', maxItems: 24,
      items: {
        type: 'object', required: ['section', 'op', 'text', 'why'],
        properties: {
          section: { type: 'string', description: 'The tab or heading it belongs under, as written in the GDD.' },
          op: { enum: ['replace', 'insert', 'delete'] },
          find: { type: 'string', description: 'replace/delete: the exact passage as it stands in the GDD now (copied character for character, one or more whole lines).' },
          after: { type: 'string', description: 'insert: the exact line (usually a heading) the new text goes after.' },
          text: { type: 'string', description: 'replace/insert: the new Markdown. Empty for delete.' },
          why: { type: 'string', description: 'Which part of the feedback it answers.' },
        },
      },
    },
  },
};

function draftPrompt(game, d) {
  const turns = d.turns.map((t) => `${t.role === 'director' ? 'Director' : 'You'}: ${t.text}`).join('\n\n');
  return `${game.subdir ? `This game's own folder is ${game.subdir}/.\n\n` : ''}You help the director of "${game.name}" keep its game design document (GDD) true to what they want. The current GDD is version ${state(game).versions.at(-1)?.v}: ${currentFile(game)}. Read it in full, and read the code where it helps to know what exists.

Turn the director's feedback into exact edits to the GDD. Keep the GDD's own structure, voice, terms and level of detail; change only what the feedback touches, plus anything elsewhere in the GDD that would otherwise contradict it (say so in why). Each edit: the section, the op, the exact passage as it stands now (for replace and delete, copied character for character so it can be found), and the new Markdown.

Ask clarifying questions only where the feedback leaves a real design choice open or contradicts the GDD, and a wrong guess would cost real rework. Still propose edits on your stated assumption, so the director can accept them if the assumption is right.

The conversation so far (newest last):
${turns}${jungledocs.forRun(game).text}`;
}

async function runDraft(game, d) {
  const acct = must(account(), 'No logged-in account has usage free right now.');
  const { result } = await claude.runQuick({
    account: acct,
    cwd: game.repoPath || dirOf(game),
    args: ['--model', d.model || db.settings.gddModel || 'opus', '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', '--add-dir', dirOf(game), ...jungledocs.forRun(game).args, '--json-schema', JSON.stringify(DRAFT_SCHEMA)],
    prompt: draftPrompt(game, d),
  });
  if (result) recordUsage({ account: acct, gameId: game.id, kind: 'gdd-draft', result });
  const out = must(result?.structured_output, clip(result?.result, 300) || 'No draft came back.');
  const text = currentText(game);
  d.summary = clip(out.summary, 600);
  d.questions = (out.questions || []).map((q) => ({ id: String(q.id || uid('q')).slice(0, 20), question: clip(q.question, 500), why: clip(q.why, 300), options: (q.options || []).map((o) => clip(o, 200)).slice(0, 4), assumption: clip(q.assumption, 300), answer: '' }));
  d.edits = (out.edits || []).map((e) => ({ id: uid('e'), section: clip(e.section, 120), op: e.op, find: String(e.find || ''), after: String(e.after || ''), text: String(e.text || ''), why: clip(e.why, 400), take: true, found: e.op === 'insert' ? !e.after || text.includes(e.after) : text.includes(e.find || '\u0000') }));
  d.turns.push({ role: 'claude', text: `${d.summary}${d.questions.length ? `\nQuestions: ${d.questions.map((q) => q.question).join(' | ')}` : ''}\nEdits: ${d.edits.map((e) => `${e.op} in ${e.section}`).join('; ')}`, at: Date.now() });
  d.status = 'review';
  d.atVersion = state(game).versions.at(-1)?.v;
}

export function draft(gameId, { feedback, model = '', from = null } = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  must(state(game).versions.length, 'Import the GDD first (GDD tab).');
  feedback = must(String(feedback || '').trim(), 'Write your feedback first.').slice(0, 8000);
  const d = { id: uid('gd'), feedback, from, model, status: 'thinking', createdAt: Date.now(), turns: [{ role: 'director', text: feedback, at: Date.now() }], questions: [], edits: [] };
  state(game).drafts.unshift(d);
  state(game).drafts = state(game).drafts.slice(0, 40);
  work(game, d, () => runDraft(game, d));
  return d;
}

// The director answers questions (and may add more feedback): Claude revises the whole draft.
export function reply(gameId, draftId, { answers = {}, text = '' } = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const d = must(state(game).drafts.find((x) => x.id === draftId), 'Unknown draft');
  for (const q of d.questions) if (answers[q.id]) q.answer = String(answers[q.id]).slice(0, 2000);
  const lines = [...d.questions.filter((q) => q.answer).map((q) => `On "${q.question}": ${q.answer}`), String(text || '').trim()].filter(Boolean);
  must(lines.length, 'Answer a question or add a note first.');
  d.turns.push({ role: 'director', text: lines.join('\n'), at: Date.now() });
  d.status = 'thinking';
  work(game, d, () => runDraft(game, d));
  return d;
}

function work(game, d, fn) {
  busy.add(d.id);
  save(); changed();
  fn().catch((err) => { d.status = 'error'; d.error = err.message; }).finally(() => { busy.delete(d.id); save(); changed(); });
}

export function updateDraft(gameId, draftId, body = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const d = must(state(game).drafts.find((x) => x.id === draftId), 'Unknown draft');
  if (body.take) for (const e of d.edits) if (e.id in body.take) e.take = !!body.take[e.id];
  if (body.discard) d.status = 'discarded';
  save(); changed();
  return d;
}

// ---------------------------------------------------------------------------
// Accept: apply, save the next version, write it back, re-evaluate the board

function apply(text, edits) {
  const done = [];
  const missed = [];
  for (const e of edits) {
    if (e.op === 'insert') {
      if (e.after && text.includes(e.after)) { const i = text.indexOf(e.after) + e.after.length; const eol = text.indexOf('\n', i); const at = eol < 0 ? text.length : eol; text = `${text.slice(0, at)}\n\n${e.text.trim()}\n${text.slice(at)}`; done.push(e); }
      else if (!e.after) { text = `${text.trimEnd()}\n\n${e.text.trim()}\n`; done.push(e); }
      else missed.push(e);
    } else if (e.find && text.includes(e.find)) { text = text.replace(e.find, () => (e.op === 'delete' ? '' : e.text)); done.push(e); }
    else missed.push(e);
  }
  return { text: text.replace(/\n{4,}/g, '\n\n\n'), done, missed };
}

export function accept(gameId, draftId) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const d = must(state(game).drafts.find((x) => x.id === draftId), 'Unknown draft');
  must(d.status === 'review', 'This draft is not ready to accept.');
  const chosen = d.edits.filter((e) => e.take);
  must(chosen.length, 'Pick at least one edit.');
  const { text, done, missed } = apply(currentText(game), chosen);
  must(done.length, 'None of the chosen edits matched the current GDD. Ask for a revision.');
  const v = saveVersion(game, text, { summary: d.summary, by: orch.directorName(), draftId: d.id });
  Object.assign(d, { status: 'accepted', acceptedAt: Date.now(), version: v, applied: done.map((e) => e.id), missed: missed.map((e) => e.id) });
  const src = sourceOf(game);
  d.writeBack = { kind: src.kind, status: 'running' };
  post(game, `GDD v${v}: ${d.summary}${missed.length ? ` (${missed.length} edit${missed.length > 1 ? 's' : ''} didn't match the text and were left out)` : ''} Writing it back to ${src.kind === 'docs' ? 'the Claude Docs doc' : src.kind === 'repo' ? 'the repo' : src.kind === 'artifact' ? 'nowhere (the claude.ai page is read only)' : 'the repo as gdd/GDD.md'}, then updating the board.`);
  save(); changed();
  work(game, d, async () => {
    await writeBack(game, d, done, src, v);
    gddreview.start(game.id).catch(() => {});
  });
  return d;
}

async function writeBack(game, d, edits, src, v) {
  if (src.kind === 'docs') {
    const acct = orch.getAccount(src.artifact.accountId) || account();
    let report = null;
    const { result } = await claude.runQuick({
      account: acct,
      connectors: true,
      args: ['--model', 'sonnet', '--tools', '', '--permission-mode', 'dontAsk', '--allowedTools', `${DOCS}read`, `${DOCS}update`, `${DOCS}guide`, '--max-turns', '60', '--json-schema', JSON.stringify({ type: 'object', required: ['applied', 'failed'], properties: { applied: { type: 'array', items: { type: 'integer' } }, failed: { type: 'array', items: { type: 'object', required: ['n', 'why'], properties: { n: { type: 'integer' }, why: { type: 'string' } } } } } })],
      env: { MAX_MCP_OUTPUT_TOKENS: '80000' },
      prompt: `Apply these approved edits to the director's Claude Docs document ${src.artifact.url}, and nothing else. Read guide topic.editing first, then read the doc for its tabs and each tab you change. Each edit names its tab or heading; replace the passage quoted under "now" with the new Markdown, delete it, or insert the new Markdown after the quoted line. Keep everything else exactly as it is. Don't touch other docs. Report which edits you applied (by number) and which failed and why.

${edits.map((e, i) => `Edit ${i + 1} (${e.op}) in "${e.section}":${e.op === 'insert' ? `\nafter: ${e.after || '(end of the tab)'}` : `\nnow:\n${e.find}`}${e.op === 'delete' ? '' : `\nnew:\n${e.text}`}`).join('\n\n---\n\n')}`,
    });
    if (result) recordUsage({ account: acct, gameId: game.id, kind: 'gdd-writeback', result });
    report = result?.structured_output;
    d.writeBack = { kind: 'docs', status: report ? (report.failed?.length ? 'partial' : 'done') : 'error', applied: report?.applied?.length || 0, failed: (report?.failed || []).map((f) => `edit ${f.n}: ${clip(f.why, 160)}`), error: report ? null : clip(result?.result, 300) || 'No report came back.' };
    src.artifact.forceRead = true;
    await cloud.syncAccount(src.artifact.accountId).catch(() => {});
    post(game, d.writeBack.status === 'done' ? `GDD v${v} written to the Claude Docs doc (${d.writeBack.applied} edits).` : `GDD v${v}: writing to the Claude Docs doc ${d.writeBack.status === 'partial' ? `left ${d.writeBack.failed.length} edit(s) out: ${d.writeBack.failed.join('; ')}` : `failed: ${d.writeBack.error}`}. Ballast's copy has every edit.`);
    return;
  }
  if (src.kind === 'artifact') { d.writeBack = { kind: 'artifact', status: 'skipped' }; return; }
  // Repo: an agent commits the change (cloud agents work on GitHub, not this PC's files).
  const file = src.kind === 'repo' ? src.files[0] : `${game.subdir ? `${game.subdir}/` : ''}gdd/GDD.md`;
  const t = orch.addTask(game.id, {
    title: `[docs] Update the GDD to v${v}`,
    detail: `The director approved changes to the game design document (Ballast GDD v${v}): ${d.summary}\n\nApply exactly these edits to ${file}${src.kind === 'repo' && src.files.length > 1 ? ` (or whichever of ${src.files.join(', ')} holds each section)` : ' (create it if it doesn\'t exist; for a new file write the whole GDD below)'}, commit and merge them, and change nothing else:\n\n${edits.map((e, i) => `Edit ${i + 1} (${e.op}) in "${e.section}":${e.op === 'insert' ? `\nafter: ${e.after || '(end)'}` : `\nnow:\n${e.find}`}${e.op === 'delete' ? '' : `\nnew:\n${e.text}`}`).join('\n\n---\n\n').slice(0, 30000)}${src.kind === 'ballast' && !state(game).committedOnce ? `\n\nThe whole GDD (v${v}), for a new file:\n\n${currentText(game).slice(0, 60000)}` : ''}`,
    createdBy: 'GDD',
  });
  Object.assign(t, { priority: 3 });
  state(game).committedOnce = true;
  d.writeBack = { kind: src.kind, status: 'ticket', ticket: t.num };
}

// ---------------------------------------------------------------------------

export function publicGdd(game) {
  const st = state(game);
  return {
    source: sourceOf(game),
    versions: st.versions.slice(-30).reverse(),
    drafts: st.drafts.filter((d) => d.status !== 'discarded').slice(0, 20).map((d) => ({ ...d, busy: busy.has(d.id) })),
    current: currentText(game),
  };
}

// Every GDD reader (re-evaluation, audits, focus planning) uses the current version once there is one.
gddreview.ownSource.push((game) => {
  if (!state(game).versions.length) return null;
  return { name: `GDD v${state(game).versions.at(-1).v} (Ballast)`, key: 'ballast-gdd', text: currentText(game) };
});

// The tracked GDD page changed (someone edited the doc, or Ballast just wrote a version into it):
// its text becomes the next version when it differs, so the version stays the one GDD. It returns
// false so the GDD re-evaluation still runs on the change.
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
cloud.gddHandlers.unshift((page) => {
  const game = orch.getGame(page.gameId);
  if (!game || !state(game).versions.length) return false;
  const md = path.join(paths.cloud, page.id, 'page.md');
  if (!fs.existsSync(md)) return false;
  const text = fs.readFileSync(md, 'utf8').trim();
  if (!text || flat(text) === flat(currentText(game))) return false;
  const ours = state(game).drafts.find((d) => d.writeBack?.kind === 'docs' && d.acceptedAt > Date.now() - 30 * 60e3);
  const v = saveVersion(game, text, { summary: ours ? `Synced from ${page.title} after writing v${ours.version} into it` : `Edited in ${page.title}`, by: ours ? 'Ballast' : 'the Claude Docs doc' });
  // A write-back that didn't fully land means the doc lacks some accepted edits, so taking its text drops them.
  const short = state(game).drafts.find((d) => d.status === 'accepted' && d.writeBack?.kind === 'docs' && d.writeBack.status !== 'done');
  if (!ours) post(game, `GDD v${v}: ${page.title} was edited directly; Ballast took the edit as its new version.${short ? ` Careful: writing v${short.version} into the doc didn't fully work, so edits from v${short.version} that weren't in the doc are missing from v${v}. Ask for that change again on the GDD tab.` : ''}`);
  return false;
});

export function init() {
  for (const g of db.games) for (const d of g.gdd?.drafts || []) if (d.status === 'thinking') Object.assign(d, { status: 'error', error: 'Ballast restarted while drafting. Ask again.' });
  for (const g of db.games) for (const d of g.gdd?.drafts || []) if (d.writeBack?.status === 'running') Object.assign(d.writeBack, { status: 'error', error: 'Ballast restarted while writing it back.' });
}
