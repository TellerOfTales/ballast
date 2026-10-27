// Quality targets: reference images (or clips) the director uploads per department to set the
// bar for asset quality: "this level of grime", "this lantern light", "this silhouette".
// Agents get the targets that match their task; reviews show them next to the captures.
// Cloud agents can't read this PC, so for cloud games the targets are published to a
// separate `ballast/targets` branch of the game's repo (never main).
import fs from 'node:fs';
import path from 'node:path';
import { db, save, uid, paths } from './store.mjs';
import { changed } from './bus.mjs';
import * as git from './git.mjs';
import * as orch from './orchestrator.mjs';

db.targets ||= [];
export const TARGETS_BRANCH = 'ballast/targets';
const root = paths.targets;

function must(value, message) {
  if (!value) throw Object.assign(new Error(message), { status: 400 });
  return value;
}

const kindOf = (name) => (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name) ? 'image' : /\.(mp4|webm|mov)$/i.test(name) ? 'video' : /\.(mp3|wav|ogg)$/i.test(name) ? 'audio' : 'file');
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
const tagList = (tags) => (Array.isArray(tags) ? tags : String(tags || '').split(',')).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 12);

export const fileOf = (t) => path.join(root, t.gameId, t.id, t.file);

// Tagged assets are kept as a snapshot (name, category, defining files) so a target still makes
// sense to agents after the asset index is rebuilt.
const assetList = (list) => (Array.isArray(list) ? list : []).filter((a) => a?.name).slice(0, 30)
  .map((a) => ({ name: String(a.name).slice(0, 80), category: String(a.category || 'other'), refs: (a.refs || []).slice(0, 4).map(String) }));

export function add(gameId, { discipline = 'art', title, notes = '', tags = '', category = '', assets = [], name, data }) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  must(data, 'Empty file');
  const file = path.basename(String(name || 'target.png')).replace(/[^\w.\-]+/g, '_').slice(-80);
  const t = {
    id: uid('tg'),
    gameId,
    discipline,
    title: String(title || file.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')).trim().slice(0, 120),
    notes: String(notes || '').trim().slice(0, 2000),
    tags: tagList(tags),
    category: String(category || ''),
    assets: assetList(assets),
    file,
    kind: kindOf(file),
    createdAt: Date.now(),
  };
  fs.mkdirSync(path.dirname(fileOf(t)), { recursive: true });
  fs.writeFileSync(fileOf(t), Buffer.from(data, 'base64'));
  db.targets.push(t);
  save();
  changed();
  if (game.runner === 'cloud') scheduleShare(game);
  return t;
}

export function update(id, patch) {
  const t = must(db.targets.find((x) => x.id === id), 'Unknown target');
  if (patch.title !== undefined) t.title = String(patch.title).trim().slice(0, 120) || t.title;
  if (patch.notes !== undefined) t.notes = String(patch.notes).trim().slice(0, 2000);
  if (patch.tags !== undefined) t.tags = tagList(patch.tags);
  if (patch.category !== undefined) t.category = String(patch.category || '');
  if (patch.assets !== undefined) t.assets = assetList(patch.assets);
  if (patch.discipline) t.discipline = patch.discipline;
  save();
  changed();
  const game = orch.getGame(t.gameId);
  if (game?.runner === 'cloud') scheduleShare(game);
  return t;
}

export function remove(id) {
  const t = must(db.targets.find((x) => x.id === id), 'Unknown target');
  fs.rmSync(path.dirname(fileOf(t)), { recursive: true, force: true });
  db.targets = db.targets.filter((x) => x.id !== id);
  save();
  changed();
  const game = orch.getGame(t.gameId);
  if (game?.runner === 'cloud') scheduleShare(game);
}

// Targets for a task: same department, ranked by how many subject words the task shares with
// the target's title and tags. With no overlap the whole department's set still applies.
export function forTask(task, game) {
  const pool = db.targets.filter((t) => t.gameId === game.id && t.discipline === (task.discipline || 'art'));
  const tw = new Set(words(`${task.title} ${task.detail || ''}`));
  // Tagged assets count double: a task naming "rain barrel" wants the target tagged with it.
  const scored = pool.map((t) => ({
    t,
    score: [...t.tags.flatMap(words), ...words(t.title)].filter((w) => tw.has(w)).length
      + 2 * (t.assets || []).flatMap((a) => [...words(a.name), ...a.refs.flatMap(words)]).filter((w) => tw.has(w)).length,
  }));
  const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).map((s) => s.t);
  return (hits.length ? hits : pool).slice(0, 6);
}

// Name each target gets on the shared branch: readable and unique.
export const branchName = (t) => `${t.id.slice(3)}-${t.file}`;

const appliesTo = (t) => (t.assets?.length ? `\n    Applies to: ${t.assets.map((a) => `${a.name} (${a.category}${a.refs.length ? `: ${a.refs.join(', ')}` : ''})`).join('; ')}` : '');

export function describe(list, { local }) {
  return list.map((t) => `- ${t.title}${t.category ? ` {${t.category}}` : ''}${t.tags.length ? ` [${t.tags.join(', ')}]` : ''}: ${local ? fileOf(t) : branchName(t)}${t.notes ? `\n    Match: ${t.notes.replace(/\n/g, ' ')}` : ''}${appliesTo(t)}`).join('\n');
}

// ---------------------------------------------------------------------------
// Cloud sharing: one commit holding just the targets plus an index, force-pushed to its own
// branch. Built with a temporary index so Ballast's clone and the user's branches are untouched.

const shareTimers = new Map();
function scheduleShare(game) {
  clearTimeout(shareTimers.get(game.id));
  shareTimers.set(game.id, setTimeout(() => share(game.id).catch(() => {}), 4000));
}

export async function share(gameId) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  if (game.runner !== 'cloud') return null;
  const list = db.targets.filter((t) => t.gameId === gameId);
  const index = `# Ballast quality targets for ${game.name}\n\nReference images the director chose to set the quality bar. Match them; don't copy them.\n\n${
    ['gameplay', 'art', 'audio', 'backend'].map((d) => {
      const ts = list.filter((t) => t.discipline === d);
      return ts.length ? `## ${d}\n${ts.map((t) => `- \`${branchName(t)}\`: ${t.title}${t.tags.length ? ` (${t.tags.join(', ')})` : ''}${t.notes ? `\n  Match: ${t.notes.replace(/\n/g, ' ')}` : ''}${appliesTo(t).replace(/\n {4}/, '\n  ')}`).join('\n')}\n` : '';
    }).join('\n')}`;
  const indexFile = path.join(root, gameId, 'README.md');
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(indexFile, index);
  try {
    await git.publishFlatBranch(game.repoPath, TARGETS_BRANCH, [
      { name: 'README.md', path: indexFile },
      ...list.map((t) => ({ name: branchName(t), path: fileOf(t) })),
    ], `Ballast quality targets (${list.length})`);
    game.targetsShared = { at: Date.now(), count: list.length, error: null };
    orch.feedPost(gameId, { kind: 'system', text: `Shared ${list.length} quality target(s) with the cloud agents on branch ${TARGETS_BRANCH}.` });
  } catch (err) {
    game.targetsShared = { at: Date.now(), count: list.length, error: err.message.slice(0, 300) };
    orch.feedPost(gameId, { kind: 'error', text: `Couldn't share quality targets with the cloud agents (${TARGETS_BRANCH}): ${err.message.slice(0, 200)}` });
  }
  save();
  changed();
  return game.targetsShared;
}
