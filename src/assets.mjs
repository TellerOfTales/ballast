// Asset index per game, so quality targets can name exactly which in-game things they apply to.
// Two sources, merged for search:
//   files   - real asset files (models, textures, prefabs, audio...), from git, instant and free
//   catalog - an AI-built list of the things in the game (characters, places, props...), read
//             from the code; essential for games that build their assets procedurally
import fs from 'node:fs';
import path from 'node:path';
import { db, paths } from './store.mjs';
import { changed } from './bus.mjs';
import * as git from './git.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import { recordUsage } from './usage.mjs';

export const CATEGORIES = [
  { id: 'character', label: 'Characters', words: ['character', 'char', 'npc', 'player', 'avatar', 'body', 'creature', 'enemy', 'hero', 'outfit', 'face', 'hair', 'townsfolk', 'crew'] },
  { id: 'level', label: 'Level design', words: ['level', 'env', 'environment', 'world', 'terrain', 'map', 'scene', 'building', 'room', 'area', 'zone', 'dock', 'wharf', 'market', 'street', 'town'] },
  { id: 'props', label: 'Props', words: ['prop', 'props', 'item', 'barrel', 'crate', 'furniture', 'interactable', 'pickup', 'weapon', 'knife', 'dagger', 'lantern', 'bench', 'net', 'hide'] },
  { id: 'vehicles', label: 'Vehicles', words: ['vehicle', 'train', 'boat', 'dory', 'car', 'cart', 'ship', 'wagon'] },
  { id: 'ui', label: 'UI', words: ['ui', 'hud', 'icon', 'font', 'menu', 'screen', 'button', 'widget'] },
  { id: 'vfx', label: 'VFX', words: ['fx', 'vfx', 'particle', 'effect', 'smoke', 'fire', 'splash'] },
  { id: 'animation', label: 'Animation', words: ['anim', 'animation', 'pose', 'rig', 'idle', 'walk', 'run'] },
  { id: 'audio', label: 'Audio', words: ['audio', 'sound', 'sfx', 'music', 'ambience', 'voice'] },
  { id: 'materials', label: 'Materials & textures', words: ['material', 'mat', 'texture', 'tex', 'shader', 'palette', 'skin'] },
  { id: 'other', label: 'Other', words: [] },
];
const IDS = new Set(CATEGORIES.map((c) => c.id));

const EXT = {
  audio: /\.(wav|mp3|ogg|flac|aif+)$/i,
  animation: /\.(anim|controller|overrideController)$/i,
  level: /\.(unity|scene|tscn|umap|level)$/i,
  materials: /\.(mat|shader|shadergraph|png|jpe?g|tga|psd|exr|webp|ktx2|dds|tif+)$/i,
  model: /\.(fbx|obj|glb|gltf|blend|dae|prefab|uasset|mesh|vox)$/i,
};
const isAsset = (p) => Object.values(EXT).some((re) => re.test(p)) && !/(^|\/)(\.ballast|node_modules|Library|Temp|\.git)\//.test(p);

function categorize(p) {
  const lower = p.toLowerCase();
  const parts = lower.split(/[^a-z0-9]+/);
  const has = (cat) => CATEGORIES.find((c) => c.id === cat).words.some((w) => parts.includes(w));
  if (EXT.audio.test(p)) return 'audio';
  if (EXT.animation.test(p) || has('animation')) return 'animation';
  for (const cat of ['character', 'vehicles', 'ui', 'vfx', 'props', 'level']) if (has(cat)) return cat;
  if (EXT.level.test(p)) return 'level';
  if (EXT.materials.test(p) || has('materials')) return 'materials';
  return 'other';
}

const indexFile = (gameId) => path.join(paths.assets, `${gameId}.json`);
const cache = new Map();
function load(gameId) {
  if (!cache.has(gameId)) {
    try { cache.set(gameId, JSON.parse(fs.readFileSync(indexFile(gameId), 'utf8'))); } catch { cache.set(gameId, {}); }
  }
  return cache.get(gameId);
}
function store(gameId, index) {
  cache.set(gameId, index);
  fs.mkdirSync(paths.assets, { recursive: true });
  fs.writeFileSync(indexFile(gameId), JSON.stringify(index));
}

// Where the game's latest code is, without touching anyone's checkout.
async function listPaths(game) {
  const scope = game.subdir ? [game.subdir] : [];
  if (game.runner === 'cloud') {
    await git.git(game.repoPath, ['fetch', '--no-tags', '--quiet', 'origin', game.baseBranch]);
    return (await git.git(game.repoPath, ['ls-tree', '-r', '--name-only', `origin/${game.baseBranch}`, '--', ...scope])).split('\n');
  }
  if (await git.isRepo(game.repoPath)) {
    const ref = game.isolation === 'worktree' && (await git.branchExists(game.repoPath, game.integrationBranch)) ? game.integrationBranch : 'HEAD';
    return (await git.git(game.repoPath, ['ls-tree', '-r', '--name-only', ref])).split('\n');
  }
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length > 50000 || /^(node_modules|Library|Temp|\.git|\.ballast)$/.test(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  walk(game.repoPath, '');
  return out;
}

export async function scanFiles(gameId) {
  const game = orch.getGame(gameId);
  const files = (await listPaths(game)).filter((p) => p && isAsset(p));
  const items = files.slice(0, 20000).map((p) => ({ name: path.posix.basename(p).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '), category: categorize(p), refs: [p], source: 'file' }));
  const index = load(gameId);
  store(gameId, { ...index, files: { at: Date.now(), items } });
  changed();
  return items.length;
}

// ---------------------------------------------------------------------------
// AI catalog: what's in the game, read from the code

const CATALOG_SCHEMA = {
  type: 'object',
  properties: {
    assets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES.map((c) => c.id) },
          refs: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
        },
        required: ['name', 'category'],
      },
    },
  },
  required: ['assets'],
};
const scanning = new Set();
export const isScanning = (gameId) => scanning.has(gameId);

export async function scanCatalog(gameId) {
  const game = orch.getGame(gameId);
  if (scanning.has(gameId)) throw Object.assign(new Error('A scan is already running.'), { status: 400 });
  const acct = db.accounts.filter((a) => a.loggedIn && !(a.limitedUntil > Date.now())).sort((a, b) => orch.utilization(a) - orch.utilization(b))[0];
  if (!acct) throw Object.assign(new Error('No logged-in account has usage free right now.'), { status: 400 });
  scanning.add(gameId);
  changed();
  try {
    // Cloud games read Ballast's own clone at the latest base branch; local games read the repo.
    if (game.runner === 'cloud') await git.syncClone(game.repoPath, game.baseBranch);
    const cwd = game.subdir ? path.join(game.repoPath, game.subdir) : game.repoPath;
    const { result, stderr } = await claude.runQuick({
      account: acct,
      cwd,
      args: ['--model', db.settings.triageModel || 'sonnet', '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', '--json-schema', JSON.stringify(CATALOG_SCHEMA)],
      prompt: `Catalog the in-game assets of "${game.name}" (the current folder). An art director will tag reference images against this list, so name things the way a player or artist would ("rain barrel", "fisherman NPC", "the wharf"), not by code identifiers.
Use Glob, Grep and Read to find what the game actually contains, whether it's built from asset files or generated in code. Cover:
- character: player, NPCs, creatures, outfits and their variants
- level: areas, rooms, buildings, terrain, set dressing layouts, spawn and hide spots
- props: interactable and decorative objects, items, weapons
- vehicles, ui (screens, HUD elements, prompts), vfx, animation (named animations and poses), audio (sounds, music, ambience cues), materials (palettes, textures, shaders)
For each asset: name, category, refs (the files that define it, relative to this folder), and a one-line description of what it looks like or does. Up to 300 assets; skip engine internals and tests. Read-only: never edit anything.`,
    });
    if (result) recordUsage({ account: acct, gameId, kind: 'triage', result });
    const assets = result?.structured_output?.assets;
    if (!assets) throw new Error((result?.is_error && result.result) || stderr.trim().split('\n').pop() || 'The scan returned no assets.');
    const prefix = game.subdir ? `${game.subdir.replace(/\/+$/, '')}/` : '';
    const items = assets.filter((a) => a.name?.trim()).map((a) => ({
      name: a.name.trim().slice(0, 80),
      category: IDS.has(a.category) ? a.category : 'other',
      refs: (a.refs || []).slice(0, 4).map((r) => `${prefix}${String(r).replace(/^\.?\//, '')}`),
      description: String(a.description || '').slice(0, 200),
      source: 'catalog',
    }));
    const index = load(gameId);
    store(gameId, { ...index, catalog: { at: Date.now(), items } });
    orch.feedPost(gameId, { kind: 'system', text: `Asset catalog built: ${items.length} assets (${CATEGORIES.filter((c) => items.some((i) => i.category === c.id)).map((c) => `${items.filter((i) => i.category === c.id).length} ${c.label.toLowerCase()}`).join(', ')}).` });
    return items.length;
  } finally {
    scanning.delete(gameId);
    changed();
  }
}

// ---------------------------------------------------------------------------
// Search

export async function search(gameId, { q = '', category = '', limit = 60 } = {}) {
  const game = orch.getGame(gameId);
  if (!game) throw Object.assign(new Error('Unknown game'), { status: 400 });
  let index = load(gameId);
  if (!index.files || Date.now() - index.files.at > 3600e3) {
    await scanFiles(gameId).catch(() => {});
    index = load(gameId);
  }
  const all = [...(index.catalog?.items || []), ...(index.files?.items || [])];
  const tokens = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const matches = all.filter((a) => {
    const hay = `${a.name} ${a.refs.join(' ')} ${a.description || ''}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.id, matches.filter((a) => a.category === c.id).length]));
  const byName = (a) => (tokens.length && tokens.every((t) => a.name.toLowerCase().includes(t)) ? 0 : 1);
  const items = matches.filter((a) => !category || a.category === category)
    .sort((a, b) => byName(a) - byName(b) || (a.source === 'catalog' ? -1 : 1) - (b.source === 'catalog' ? -1 : 1) || a.name.localeCompare(b.name))
    .slice(0, Math.min(200, Number(limit) || 60));
  return {
    items,
    counts,
    total: matches.length,
    catalog: index.catalog ? { at: index.catalog.at, count: index.catalog.items.length } : null,
    files: index.files ? { at: index.files.at, count: index.files.items.length } : null,
    scanning: scanning.has(gameId),
    categories: CATEGORIES.map(({ id, label }) => ({ id, label })),
  };
}
