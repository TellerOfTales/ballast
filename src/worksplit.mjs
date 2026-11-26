// How a game's work is split, and how far Ballast may reach:
// - Work split: per discipline, Ballast's agents or Jungle Studio (e.g. programming in Jungle Studio,
//   art in Ballast). Tickets for Jungle Studio stay on the board, but no Ballast agent takes them; the
//   Board tab lists them as a brief to paste into Jungle Studio.
// - Jungle Engine strict: for games set up with Jungle. Agents change only the game's own Game Pack
//   folder and work the engine's documented way; every finished pull request is checked, and changes
//   outside the folder come back as a ticket.
// - Repo work: maintenance across a repo (merge conflicts, CI, dependencies) that any game's agents
//   in that repo may take, outside strict confinement because the director asked for it directly.
import { execFile } from 'node:child_process';
import { db, save } from './store.mjs';
import { changed } from './bus.mjs';
import * as orch from './orchestrator.mjs';
import * as review from './review.mjs';
import { SITE as DOCS } from './jungledocs.mjs';

export const OWNERS = ['ballast', 'jungle'];
export const SPLIT_KEYS = ['gameplay', 'backend', 'art', 'audio', 'other'];
const must = (v, msg, status = 400) => { if (!v) throw Object.assign(new Error(msg), { status }); return v; };
const LABEL = { gameplay: 'gameplay', backend: 'backend and tech', art: 'art', audio: 'audio', other: 'untagged work' };

export const disciplineOfTask = (t) => t.discipline || review.disciplineOf(t.title);

// Who does this ticket: a per-ticket override, else the game's split for its discipline.
export function ownerOf(game, t) {
  if (t.repoWide) return 'ballast';
  if (OWNERS.includes(t.owner)) return t.owner;
  return game?.split?.[disciplineOfTask(t)] === 'jungle' ? 'jungle' : 'ballast';
}
export const forBallast = (game, t) => ownerOf(game, t) === 'ballast';
export const jungleShare = (game) => SPLIT_KEYS.filter((k) => game?.split?.[k] === 'jungle');

// Games share a repo when their GitHub repo (or, failing that, their folder) is the same.
export function repoKey(game) {
  if (!game) return null;
  const gh = typeof game.github === 'string' ? game.github : game.github?.repo || game.jungle?.repo;
  return (gh || game.repoPath || '').toLowerCase().replace(/\\/g, '/').replace(/\.git$/, '') || null;
}

export function normalizeSplit(split) {
  const out = {};
  for (const k of SPLIT_KEYS) if (split?.[k] === 'jungle') out[k] = 'jungle';
  return out;
}

// ---------------------------------------------------------------------------
// What agents and triage are told

export function agentNote(game) {
  if (!game) return '';
  const parts = [];
  const jungle = jungleShare(game);
  if (jungle.length) {
    const ours = SPLIT_KEYS.filter((k) => !jungle.includes(k) && k !== 'other').map((k) => LABEL[k]);
    parts.push(`Work split: on this game Jungle Studio does the ${jungle.map((k) => LABEL[k]).join(', ')}; Ballast's agents do ${ours.join(', ') || 'only what the director hands them'}. Don't write or change ${jungle.map((k) => LABEL[k]).join(' or ')} code yourself beyond what your change needs to load (asset paths, manifest or registry entries). When your work needs more than that, finish your part, add a board ticket tagged for that department (it goes to Jungle Studio), and say so in your report.`);
  }
  if (game.jungleMode === 'strict') {
    const folder = game.subdir ? `${game.subdir}/` : 'this game\'s own files';
    const extra = (game.jungleAllow || []).length ? ` (also allowed: ${game.jungleAllow.join(', ')})` : '';
    parts.push(`Jungle Engine strict: this game was set up with Jungle and must stay within how the engine does things. Change only files under ${folder}${extra}, unless a ticket says REPO-WIDE. Use the engine's documented APIs and Game Pack conventions (${DOCS}); don't patch or work around the engine packages, the shared apps or other games, and don't build your own version of something the engine provides. When the engine can't do what the ticket needs, stop and ask in your report (a Decision or Question block) instead of building around it. Every finished pull request is checked for files outside ${folder}.`);
  }
  return parts.length ? `[${parts.join('\n')}]\n\n` : '';
}

export function triageNote(game) {
  const jungle = jungleShare(game);
  const parts = [];
  if (jungle.length) parts.push(`On this game Jungle Studio does the ${jungle.map((k) => LABEL[k]).join(', ')}, not Ballast's agents. Still add those tasks (tagged by department) so the director can hand them to Jungle Studio: write them as self-contained briefs a Jungle Studio pod could act on without this conversation.`);
  if (game.jungleMode === 'strict') parts.push(`This game follows Jungle Engine strictly: tasks must fit the engine's documented way of doing things and stay inside ${game.subdir ? `${game.subdir}/` : 'the game\'s own files'}. Where a note asks for something the engine doesn't support, make the task "find the engine's way to do X, or ask the director" rather than building around the engine.`);
  return parts.length ? `\n${parts.join('\n')}\n` : '';
}

// ---------------------------------------------------------------------------
// Strict mode: a finished pull request's files, checked against the game's folder.

const gh = (args) => new Promise((resolve, reject) => {
  execFile('gh', args, { windowsHide: true, timeout: 60e3 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())));
});

export function outsideScope(game, files) {
  const allow = [game.subdir ? `${game.subdir.replace(/\/$/, '')}/` : null, ...(game.jungleAllow || [])].filter(Boolean).map((p) => p.replace(/\\/g, '/').replace(/^\.?\//, ''));
  if (!allow.length) return [];
  // Ballast's own report and capture files sit under .ballast/ by design.
  return files.filter((f) => !allow.some((p) => f === p.replace(/\/$/, '') || f.startsWith(p.endsWith('/') ? p : `${p}/`) || f === p) && !/(^|\/)\.ballast\//.test(f));
}

export async function checkScope(task, game, pr) {
  if (game?.jungleMode !== 'strict' || task.repoWide || !pr) return null;
  let files;
  try { files = (await gh(['pr', 'view', pr, '--json', 'files', '--jq', '.files[].path'])).split('\n').filter(Boolean); } catch (err) {
    orch.feedPost(game.id, { kind: 'error', from: 'Jungle strict', text: `Couldn't check the files in ${pr} (#${task.num}): ${err.message.slice(0, 200)}` });
    return null;
  }
  const out = outsideScope(game, files);
  task.scopeCheck = { at: Date.now(), pr, outside: out.slice(0, 50) };
  save();
  if (!out.length) return task.scopeCheck;
  const fix = orch.addTask(game.id, {
    title: `[backend] Undo #${task.num}'s changes outside ${game.subdir || 'the game folder'}`,
    detail: `Jungle Engine strict: ${game.name} may only change files under ${game.subdir}/ and must work the engine's documented way. ${pr} (#${task.num} ${task.title}) also changed:\n${out.slice(0, 30).map((f) => `- ${f}`).join('\n')}${out.length > 30 ? `\n- …and ${out.length - 30} more` : ''}\n\nMove what's needed inside ${game.subdir}/ using the engine's APIs, and revert the rest. If a change outside the folder is truly needed (the engine can't do it), don't make it: ask the director in your report with a Decision block, and say what the engine would need.`,
    createdBy: 'Jungle strict',
    assignee: task.doneBy || null,
  });
  orch.feedPost(game.id, { kind: 'error', from: 'Jungle strict', text: `#${task.num} changed ${out.length} file${out.length > 1 ? 's' : ''} outside ${game.subdir}/ (${out.slice(0, 4).join(', ')}${out.length > 4 ? ', …' : ''}). Added #${fix.num} to move or revert them.` });
  return task.scopeCheck;
}

// ---------------------------------------------------------------------------
// Jungle Studio's share of a board

export function handoff(gameId) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  const tasks = db.tasks.filter((t) => t.gameId === game.id && ['open', 'blocked'].includes(t.status) && !forBallast(game, t));
  const brief = `${game.name}${game.subdir ? ` (${game.subdir}/ in ${repoKey(game)})` : ''}: work for Jungle Studio, from Ballast's board.\n\n${tasks.map((t) => `#${t.num} ${t.title}\n${(t.detail || '').trim()}`).join('\n\n---\n\n')}`;
  return { split: jungleShare(game), tasks: tasks.map((t) => ({ id: t.id, num: t.num, title: t.title, status: t.status })), brief };
}

// A ticket handed to Jungle Studio and finished there, or taken back by Ballast.
export function setOwner(taskId, owner) {
  const t = must(db.tasks.find((x) => x.id === taskId), 'Unknown task');
  must(OWNERS.includes(owner) || owner === '' || owner === 'done-in-jungle', 'Unknown owner');
  if (owner === 'done-in-jungle') {
    orch.updateTask(t.id, { status: 'done', summary: 'Done in Jungle Studio.' });
    t.owner = 'jungle';
  } else if (owner) t.owner = owner;
  else delete t.owner;
  save();
  changed();
  if (owner === 'ballast') setTimeout(() => orch.wakeIdle(t.gameId), 300);
  return t;
}

// ---------------------------------------------------------------------------
// Repo work

export function repos() {
  const map = new Map();
  for (const g of db.games.filter((x) => (x.status || 'active') !== 'archived')) {
    const k = repoKey(g);
    if (!k) continue;
    if (!map.has(k)) map.set(k, { key: k, label: k.includes('/') && !k.includes(':') ? k : k.split('/').slice(-2).join('/'), games: [] });
    map.get(k).games.push({ id: g.id, name: g.name, status: g.status || 'active', cloud: g.runner === 'cloud' });
  }
  return [...map.values()].map((r) => ({ ...r, tasks: db.tasks.filter((t) => t.repoWide && t.repo === r.key).slice(-40).reverse().map((t) => ({ id: t.id, num: t.num, gameId: t.gameId, title: t.title, status: t.status, claimedBy: t.claimedBy ? orch.getAgent(t.claimedBy)?.name : null, doneBy: t.doneBy ? orch.getAgent(t.doneBy)?.name : null, pr: t.pr || null, createdAt: t.createdAt })) }));
}

export function addRepoWork({ repo, text }) {
  text = String(text || '').trim();
  must(text, 'Say what needs doing.');
  const r = must(repos().find((x) => x.key === repo), 'Pick a repo.');
  // The ticket lives on the board of the repo's most active game; agents of every game in the repo can take it.
  const home = r.games.find((g) => g.status === 'active') || r.games[0];
  const first = text.split('\n')[0].replace(/\s+/g, ' ').trim();
  const title = `[repo] ${first.length > 110 ? `${first.slice(0, 107)}…` : first}`;
  const t = orch.addTask(home.id, {
    title,
    detail: `REPO-WIDE MAINTENANCE for ${r.label}, asked for by the director. This ticket isn't about one game: it covers the whole repo (any game's folder, the shared apps, CI, open pull requests), so it may touch files outside your game's folder, and strict-mode confinement doesn't apply to it. Keep each change as small as it can be, and don't change game design or content while doing it.\n\n${text}`,
    createdBy: orch.directorName(),
  });
  Object.assign(t, { repoWide: true, repo: r.key, priority: Math.max(t.priority ?? 1, 2) });
  save();
  changed();
  for (const g of r.games) setTimeout(() => orch.wakeIdle(g.id), 300);
  return t;
}
