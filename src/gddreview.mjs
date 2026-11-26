// GDD re-evaluation (Board tab): pull the latest GDD, compare it with the copy from the last run,
// read the repo, and add board tasks for what the GDD asks for that is neither built nor already
// ticketed. Runs on demand or on a schedule (hourly, every 6 hours, daily, weekly).
//
// The GDD is the game's tracked claude.ai GDD pages (re-read from claude.ai first) plus GDD and
// design files in the repo (cloud games: Ballast's clone, synced to the base branch first). Each run
// keeps a plain-text copy under games/<id>/gdd/ so the next run can say what changed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, save, paths } from './store.mjs';
import { changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import * as cloud from './cloud.mjs';
import * as git from './git.mjs';
import * as pace from './pace.mjs';
import * as jungledocs from './jungledocs.mjs';
import { recordUsage } from './usage.mjs';

const HOUR = 3600e3;
export const SCHEDULES = { off: 'Off', hourly: 'Every hour', '6h': 'Every 6 hours', daily: 'Every day', weekly: 'Every week' };
const MAX_TASKS = 12; // per run, so one pass never floods the board
const must = (v, msg, status = 400) => { if (!v) throw Object.assign(new Error(msg), { status }); return v; };
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const gddDir = (game) => path.join(paths.games, game.id, 'gdd');
export const gddDirOf = gddDir;
// Other GDD sources add themselves here. ownSource: once a game's GDD has versions in Ballast (GDD tab,
// src/gddedit.mjs), the current version is the GDD every check reads, instead of the pages and files.
export const extraSources = [];
export const ownSource = [];
const state = (game) => (game.gddReview ||= { every: 'off', at: '09:00', day: 1, onlyOnChange: true, status: 'idle' });

const SCHEMA = {
  type: 'object',
  required: ['summary', 'gddChanges', 'tasks', 'outdated'],
  properties: {
    summary: { type: 'string', description: 'Two or three sentences: where the game stands against the GDD.' },
    gddChanges: { type: 'array', items: { type: 'string' }, description: 'What changed in the GDD since the last run, one short line each. Empty when nothing changed or on a first run.' },
    tasks: {
      type: 'array',
      maxItems: MAX_TASKS,
      items: {
        type: 'object',
        required: ['title', 'detail', 'priority', 'why'],
        properties: {
          title: { type: 'string', description: 'Starts with the department tag, e.g. "[gameplay] Caddie heckles a missed putt".' },
          detail: { type: 'string', description: 'What to build and how to check it in game, for an agent who has not read the GDD. Name the GDD section.' },
          priority: { enum: ['low', 'normal', 'high', 'urgent'] },
          why: { enum: ['gdd-changed', 'not-built'], description: 'gdd-changed: new or changed in the GDD since the last run. not-built: in the GDD before, still missing from the repo and the board.' },
        },
      },
    },
    outdated: {
      type: 'array',
      description: 'Open or in-progress tickets the current GDD contradicts or no longer asks for.',
      items: { type: 'object', required: ['num', 'reason'], properties: { num: { type: 'integer' }, reason: { type: 'string' } } },
    },
  },
};

// ---------------------------------------------------------------------------
// The GDD's sources, as plain text

function htmlToText(html) {
  return html
    .replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|blockquote|pre|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

// claude.ai pages tracked for the game as its GDD (role GDD, or a title that says so).
export const gddPages = (game) => db.cloudArtifacts.filter((c) => c.gameId === game.id && (c.role === 'gdd' || /\bgdd\b|game design doc/i.test(c.title || '')));

const gameRoot = (game) => (game.subdir ? path.join(game.repoPath, game.subdir) : game.repoPath);

// GDD and design files in the game's folder (and design/ or docs/ in it), at most 10 files of 2 MB.
function repoGddFiles(game) {
  const root = gameRoot(game);
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  const looks = (name) => /\.(md|markdown|txt)$/i.test(name) && /(^|[^a-z])(gdd|game[-_ ]?design|design[-_ ]?doc)/i.test(name);
  const walk = (dir, depth, anyName) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 10 || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1, anyName || /^(design|gdd|docs?)$/i.test(e.name)); continue; }
      if ((looks(e.name) || (anyName && /\.(md|markdown)$/i.test(e.name) && /design|gdd|pillar|mechanic|feature|level|story/i.test(e.name))) && fs.statSync(p).size < 2e6) out.push(p);
    }
  };
  walk(root, 0, false);
  return out;
}

// Pulls the latest GDD: claude.ai GDD pages re-read now, and the repo synced to its base branch.
async function refresh(game) {
  const pages = gddPages(game);
  for (const p of pages) p.forceRead = true;
  for (const accountId of [...new Set(pages.map((p) => p.accountId))]) {
    try { await cloud.syncAccount(accountId); } catch (err) { state(game).warning = `Couldn't re-read a GDD page from claude.ai: ${err.message}`; }
  }
  if (game.runner === 'cloud' && game.repoPath) await git.syncClone(game.repoPath, game.baseBranch);
  const commit = game.repoPath ? await git.head(game.repoPath).catch(() => '') : '';
  for (const h of ownSource) { try { const own = h(game); if (own) return { sources: [own], commit }; } catch { /* fall back to the pages */ } }
  const sources = [];
  for (const p of pages) {
    const file = path.join(paths.cloud, p.id, 'page.html');
    if (fs.existsSync(file)) sources.push({ name: `claude.ai: ${p.title}`, key: `page-${p.id}`, text: htmlToText(fs.readFileSync(file, 'utf8')) });
  }
  for (const h of extraSources) { try { sources.push(...h(game)); } catch { /* a source's own problem */ } }
  for (const f of repoGddFiles(game)) sources.push({ name: `repo: ${path.relative(game.repoPath, f).split(path.sep).join('/')}`, key: `repo-${sha(f).slice(0, 10)}`, text: fs.readFileSync(f, 'utf8') });
  return { sources, commit };
}

// Paragraph-level changes against the copy from the last run.
function diffSources(game, sources) {
  const dir = gddDir(game);
  const lines = [];
  for (const s of sources) {
    const prevFile = path.join(dir, `${s.key}.txt`);
    if (!fs.existsSync(prevFile)) { lines.push(`${s.name}: new to Ballast (no earlier copy to compare with).`); continue; }
    const before = new Set(fs.readFileSync(prevFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));
    const now = s.text.split('\n').map((l) => l.trim()).filter(Boolean);
    const nowSet = new Set(now);
    const added = now.filter((l) => !before.has(l));
    const removed = [...before].filter((l) => !nowSet.has(l));
    if (added.length || removed.length) lines.push(`${s.name}:\n${added.map((l) => `+ ${l}`).join('\n')}${added.length && removed.length ? '\n' : ''}${removed.map((l) => `- ${l}`).join('\n')}`);
  }
  return lines.join('\n\n').slice(0, 14000);
}

// The latest GDD as plain-text files a run can read (also used by the level audit).
export async function pullLatest(game) {
  const { sources, commit } = await refresh(game);
  const now = path.join(gddDir(game), 'current');
  fs.mkdirSync(now, { recursive: true });
  const files = sources.map((s) => { const f = path.join(now, `${s.key}.txt`); fs.writeFileSync(f, s.text); return f; });
  return { sources, files, commit, dir: gddDir(game) };
}

function keep(game, sources) {
  const dir = gddDir(game);
  fs.mkdirSync(dir, { recursive: true });
  for (const s of sources) fs.writeFileSync(path.join(dir, `${s.key}.txt`), s.text);
}

// ---------------------------------------------------------------------------
// The run

function prompt(game, { sources, files, diff, first, commit }) {
  const tasks = db.tasks.filter((t) => t.gameId === game.id);
  const live = tasks.filter((t) => t.status !== 'done').map((t) => `#${t.num} [${t.status}] ${t.title}`);
  const done = tasks.filter((t) => t.status === 'done' && !t.cancelled).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 150).map((t) => `#${t.num} ${t.title}`);
  const rm = game.roadmap?.features?.length ? game.roadmap.features.map((f) => `- ${f.name}: later levels already planned (${f.levels.flatMap((l) => l.tasks.map((t) => t.title)).slice(0, 8).join('; ') || 'none'})`).join('\n') : '';
  return `Re-evaluate "${game.name}" against its game design document and keep the board in step with it.

You are in the game's folder${commit ? ` (repo at ${commit})` : ''}. The GDD, as plain text (read every file):
${files.map((f, i) => `- ${f} (${sources[i].name})`).join('\n')}

${first ? 'This is the first re-evaluation, so there is no earlier GDD to compare with.' : `What changed in the GDD since the last re-evaluation (${new Date(game.gddReview.lastRunAt).toLocaleString()}), by paragraph (+ added, - removed):\n${diff || '(no change)'}`}

Then read the code to see what is really built.

Board, not done:
${live.join('\n') || '(none)'}

Done recently:
${done.join('\n') || '(none)'}
${rm ? `\nThe roadmap already plans these and adds them to the board by itself when a milestone needs them; don't add them again:\n${rm}\n` : ''}
Add tasks (at most ${MAX_TASKS}, most important first) for what the GDD asks for that is neither built in the repo nor covered by a ticket above, open or done. Changes to the GDD since the last run come first: anything new or changed there that isn't on the board. Don't re-add what a ticket already covers, even under other words. Board-sized tasks only: one agent, one sitting. Titles start with the department tag ([gameplay], [art], [audio], [ui], [backend], [docs], [qa]). Priority: urgent only for what blocks the core loop, high for core features, normal otherwise.

List open or in-progress tickets the current GDD contradicts or no longer asks for under "outdated"; don't add tasks to undo them.

Game brief:
${game.brief?.trim().slice(0, 2000) || '(none)'}`;
}

const running = new Set();

// `scheduled` runs may skip the model when neither the GDD nor the repo moved since the last run.
export async function start(gameId, { scheduled = false } = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  must(game.repoPath, 'This game has no folder Ballast can read.');
  const g = state(game);
  if (running.has(game.id)) return publicState(game);
  running.add(game.id);
  Object.assign(g, { status: 'running', startedAt: Date.now(), error: null, warning: null });
  changed();
  run(game, { scheduled }).catch((err) => { Object.assign(g, { status: 'error', error: err.message }); }).finally(() => {
    running.delete(game.id);
    g.nextAt = nextRun(g);
    if (g.status === 'running') g.status = 'idle';
    save();
    changed();
  });
  return publicState(game);
}

async function run(game, { scheduled }) {
  const g = game.gddReview;
  const { sources, commit } = await refresh(game);
  must(sources.length, 'No GDD found. Track the GDD page from claude.ai (Artifacts tab, role GDD) or add a GDD.md to the game\'s folder.');
  const fingerprint = sha(sources.map((s) => sha(s.text)).join('|'));
  const gddChanged = fingerprint !== g.fingerprint;
  if (scheduled && g.onlyOnChange && !gddChanged && g.lastRunAt) {
    g.last = { at: Date.now(), skipped: true, commit, summary: 'The GDD hasn\'t changed since the last run, so the scheduled run was skipped.' };
    g.status = 'idle';
    return;
  }
  const first = !g.lastRunAt;
  const diff = first ? '' : diffSources(game, sources);
  // The model reads the plain-text copies of this run (the claude.ai pages are HTML).
  const now = path.join(gddDir(game), 'current');
  fs.mkdirSync(now, { recursive: true });
  const files = sources.map((s) => { const f = path.join(now, `${s.key}.txt`); fs.writeFileSync(f, s.text); return f; });

  const acct = db.accounts.filter((a) => a.loggedIn && !(a.limitedUntil > Date.now()) && orch.utilization(a) * 100 < (db.settings.limitGuardPct || 95)).sort(pace.compareAccounts)[0];
  must(acct, 'No logged-in account has usage free right now.');
  const model = g.model || db.settings.gddReviewModel || 'sonnet';
  const { result } = await claude.runQuick({
    account: acct,
    cwd: gameRoot(game),
    args: ['--model', model, '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', '--add-dir', gddDir(game), ...jungledocs.forRun(game).args, '--json-schema', JSON.stringify(SCHEMA)],
    prompt: prompt(game, { sources, files, diff, first, commit }) + jungledocs.forRun(game).text,
  });
  if (result) recordUsage({ account: acct, gameId: game.id, kind: 'gdd-review', result });
  const out = result?.structured_output;
  must(out, result?.result?.slice(0, 300) || 'The re-evaluation returned nothing.');

  // Add what isn't on the board under the same title already.
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const titles = new Set(db.tasks.filter((t) => t.gameId === game.id).map((t) => norm(t.title)));
  const added = [];
  for (const t of (out.tasks || []).slice(0, MAX_TASKS)) {
    if (!t.title?.trim() || titles.has(norm(t.title))) continue;
    titles.add(norm(t.title));
    const task = orch.addTask(game.id, { title: t.title.trim().slice(0, 200), detail: `${t.detail}\n\n${t.why === 'gdd-changed' ? 'New or changed in the GDD since the last re-evaluation.' : 'In the GDD, not built yet.'}`, createdBy: 'GDD review' });
    if (t.priority && t.priority !== 'normal') orch.updateTask(task.id, { priority: t.priority });
    added.push(task.num);
  }
  const outdated = (out.outdated || []).filter((o) => db.tasks.some((t) => t.gameId === game.id && t.num === o.num && t.status !== 'done'));
  keep(game, sources);
  Object.assign(g, { fingerprint, lastRunAt: Date.now(), lastCommit: commit, status: 'idle' });
  g.last = { at: Date.now(), commit, model, account: acct.name, summary: out.summary, gddChanges: out.gddChanges || [], added, outdated, gddChanged: !first && gddChanged };

  orch.feedPost(game.id, {
    kind: 'task',
    from: 'GDD review',
    text: [
      `GDD re-evaluation${scheduled ? ' (scheduled)' : ''}: ${out.summary}`,
      (out.gddChanges || []).length ? `\nChanged in the GDD:\n${out.gddChanges.map((c) => `- ${c}`).join('\n')}` : '',
      added.length ? `\nAdded ${added.length} task${added.length > 1 ? 's' : ''}: ${added.map((n) => `#${n}`).join(', ')}` : '\nNo new tasks: the board already covers the GDD.',
      outdated.length ? `\nMay no longer match the GDD:\n${outdated.map((o) => `- #${o.num}: ${o.reason}`).join('\n')}` : '',
    ].filter(Boolean).join('\n'),
  });
}

// ---------------------------------------------------------------------------
// Schedule

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function nextRun(g, from = Date.now()) {
  if (!g || !SCHEDULES[g.every] || g.every === 'off') return null;
  if (g.every === 'hourly') return from + HOUR;
  if (g.every === '6h') return from + 6 * HOUR;
  const [h, m] = (TIME_RE.test(g.at || '') ? g.at : '09:00').split(':').map(Number);
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (g.every === 'daily') { if (d.getTime() <= from) d.setDate(d.getDate() + 1); return d.getTime(); }
  const day = Number.isInteger(g.day) ? g.day : 1;
  d.setDate(d.getDate() + ((day - d.getDay() + 7) % 7));
  if (d.getTime() <= from) d.setDate(d.getDate() + 7);
  return d.getTime();
}

export function configure(gameId, body = {}) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const g = state(game);
  if (body.every !== undefined) g.every = SCHEDULES[body.every] ? body.every : 'off';
  if (body.at !== undefined) g.at = must(TIME_RE.test(String(body.at)) && String(body.at).padStart(5, '0'), 'Times look like 09:00.');
  if (body.day !== undefined) g.day = Math.min(6, Math.max(0, Number(body.day) || 0));
  if (body.onlyOnChange !== undefined) g.onlyOnChange = !!body.onlyOnChange;
  if (body.model !== undefined) g.model = ['', 'opus', 'sonnet', 'haiku', 'fable'].includes(body.model) ? body.model : '';
  g.nextAt = nextRun(g);
  save();
  changed();
  return publicState(game);
}

export const publicState = (game) => ({ ...state(game), pages: gddPages(game).map((p) => p.title), schedules: SCHEDULES });

export function init() {
  for (const game of db.games) if (game.gddReview?.status === 'running') Object.assign(game.gddReview, { status: 'error', error: 'Ballast restarted during the run. Run it again.' });
  // A game that re-evaluates against its GDD (it has run, runs now, or is scheduled) takes GDD page
  // changes here: one pass against the whole GDD and the repo instead of a note about the change.
  cloud.gddHandlers.push((page) => {
    const game = orch.getGame(page.gameId);
    const g = game?.gddReview;
    if (!game || !(running.has(game.id) || g?.lastRunAt || (g?.every && g.every !== 'off'))) return false;
    if (!running.has(game.id) && (game.status || 'active') === 'active') start(game.id).catch(() => {});
    return true;
  });
  setInterval(() => {
    for (const game of db.games) {
      const g = game.gddReview;
      if (!g || g.every === 'off' || !g.nextAt || Date.now() < g.nextAt || running.has(game.id)) continue;
      if ((game.status || 'active') !== 'active') { g.nextAt = nextRun(g); continue; }
      start(game.id, { scheduled: true }).catch(() => {});
    }
  }, 60e3).unref();
}
