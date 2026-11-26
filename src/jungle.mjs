// New Jungle Engine games: a project made from the engine's own starter (jungle-engine/templates/starter),
// renamed to the game's id, installed against the published engine packages and checked, then added to
// Ballast as a game. The game runs on the engine alone: no Jungle Studio, no pod. Docs:
// https://thecompanylive.github.io/jungle-engine/guide/getting-started
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db, save, paths } from './store.mjs';
import * as git from './git.mjs';
import * as orch from './orchestrator.mjs';

const ENGINE_REPO = 'thecompanylive/jungle-engine';
const STARTER = 'templates/starter';
const REGISTRY = 'https://npm.pkg.github.com';
const DOCS = 'https://thecompanylive.github.io/jungle-engine';
// packages/shared/src/games/ids.ts RESERVED_GAME_IDS (with the core worlds), plus the starter's own packs.
const RESERVED = new Set(['abilities', 'app', 'assets', 'audio', 'avatar', 'combat', 'comfort', 'core', 'cosmetics', 'debug', 'economy', 'g',
  'gameplay', 'games', 'i18n', 'interaction', 'juice', 'lobby', 'net', 'party', 'platform', 'player', 'settings', 'style', 'ui', 'vehicles',
  'voice', 'watch', 'worlds', 'hub', 'jungle', 'sandbox', 'meadow', 'bench', 'demo', 'humandemo']);
const TEXT = /\.(ts|tsx|js|mjs|json|md|html|svg|webmanifest|css|txt)$|^\.(env|npmrc|gitignore)$/;
const must = (v, msg, status = 400) => { if (!v) throw Object.assign(new Error(msg), { status }); return v; };

// Runs a command line (npm is a .cmd on Windows, so through the shell); resolves { code, out } with the tail of its output.
function sh(command, cwd, timeoutMin = 15, keepChars = 6000) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } });
    const keep = (d) => { out = (out + d).slice(-keepChars); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { keep(`\n(timed out after ${timeoutMin} min)`); child.kill(); }, timeoutMin * 60e3);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim() }); });
  });
}
const tail = (s, n = 12) => s.split('\n').filter((l) => l.trim()).slice(-n).join('\n');

export const idFromName = (name) => String(name || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '').replace(/^[0-9]+/, '').slice(0, 24);

export function idProblem(id) {
  if (!/^[a-z][a-z0-9]*$/.test(id || '')) return 'The game id is lowercase letters and digits, starting with a letter (e.g. darkterritory).';
  if (RESERVED.has(id)) return `"${id}" is reserved by the engine. Pick another id.`;
  return null;
}

// Where new projects go: next to the most recent local game, else ~/Dev (C:\Dev on Windows) when it exists.
function defaultRoot() {
  const local = db.games.filter((g) => g.runner !== 'cloud' && g.repoPath && !g.repoPath.includes(`${path.sep}.ballast${path.sep}`)).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (local) return path.dirname(local.repoPath);
  for (const dir of [process.platform === 'win32' ? 'C:\\Dev' : '', path.join(os.homedir(), 'Dev')]) if (dir && fs.existsSync(dir)) return dir;
  return os.homedir();
}

// What this PC needs before a project can be made: Node 22, git, the GitHub CLI and a read token for the engine packages.
export async function check() {
  const [gitV, ghAuth, npmV] = await Promise.all([
    sh('git --version', os.homedir(), 1),
    sh('gh auth status --hostname github.com', os.homedir(), 1),
    sh(`npm view @thecompanylive/jungle-shared version --registry=${REGISTRY}`, os.homedir(), 2),
  ]);
  const major = Number(process.versions.node.split('.')[0]);
  const engine = npmV.code === 0 ? npmV.out.split('\n').pop().trim() : null;
  const items = [
    { key: 'node', ok: major >= 22, label: `Node ${process.versions.node}`, fix: 'Install Node 22 or later (nodejs.org), then restart Ballast.' },
    { key: 'git', ok: gitV.code === 0, label: gitV.code === 0 ? gitV.out.replace('git version ', 'git ') : 'git not found', fix: 'Install git (git-scm.com).' },
    { key: 'gh', ok: ghAuth.code === 0, label: ghAuth.code === 0 ? `GitHub CLI: ${ghAuth.out.match(/account (\S+)/)?.[1] || 'signed in'}` : 'GitHub CLI not signed in', fix: 'Install the GitHub CLI and run: gh auth login' },
    {
      key: 'npm', ok: !!engine, label: engine ? `Engine packages: ${engine} available` : 'Engine packages not reachable',
      fix: `npm needs a GitHub read token for @thecompanylive (once per PC): ${DOCS}/guide/install. Then: npm login --scope=@thecompanylive --auth-type=legacy --registry=${REGISTRY}`,
    },
  ];
  return { ok: items.every((i) => i.ok), engine, items, defaultRoot: defaultRoot(), gamesFolder: gamesFolder(), docs: `${DOCS}/guide/getting-started` };
}

// The games folder last used, else the parent folder of a cloud game that lives in one (games/<id>).
function gamesFolder() {
  if (db.settings.jungleGamesFolder) return db.settings.jungleGamesFolder;
  const g = [...db.games].reverse().find((x) => x.runner === 'cloud' && x.github && /^(.+)\/[^/]+$/.test(x.subdir || ''));
  return g ? `https://github.com/${g.github}/tree/${g.baseBranch || 'main'}/${g.subdir.replace(/\/[^/]+$/, '')}` : '';
}

// The engine commit a published release was built from (npm records it as gitHead), so the starter
// matches the engine version the project installs. `version` is a version or a tag ('latest').
async function releaseCommit(version) {
  const r = await sh(`npm view @thecompanylive/jungle-engine-client@${version} gitHead --registry=${REGISTRY}`, os.homedir(), 2);
  return r.code === 0 ? r.out.split('\n').map((l) => l.match(/[0-9a-f]{40}/)?.[0]).filter(Boolean).pop() || null : null;
}

// The engine's starter at `ref` (a commit; main when the release has none), through a shallow
// sparse fetch: only templates/starter is checked out.
async function fetchStarter(ref) {
  const dir = path.join(paths.tmp, `jungle-starter-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  await git.git(dir, ['init', '--quiet']);
  await git.git(dir, ['remote', 'add', 'origin', `https://github.com/${ENGINE_REPO}.git`]);
  await git.git(dir, ['sparse-checkout', 'set', STARTER]);
  await git.git(dir, ['fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', ref || 'main']);
  await git.git(dir, ['checkout', '--quiet', 'FETCH_HEAD']);
  const sha = await git.git(dir, ['rev-parse', '--short', 'HEAD']);
  return { dir, starter: path.join(dir, STARTER), sha };
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const edit = (file, fn) => { if (fs.existsSync(file)) fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8'))); };
const pascal = (id) => id[0].toUpperCase() + id.slice(1);
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The starter's `demo` pack becomes the game's pack: every name in the table of « Your first change »
// (docs: guide/getting-started), plus its TypeScript names and log prefix. Links are left alone.
function renameDemo(text, id) {
  return text.split(/(https?:\/\/\S+)/).map((part, i) => (i % 2 ? part : part
    .replace(/\bdemo(?=[A-Z])/g, id)
    .replace(/\bdemo\b/g, id)
    .replace(/\bDemo(?=[A-Z]|\b)/g, pascal(id))
    .replace(/\bDEMO_/g, `${id.toUpperCase()}_`))).join('');
}

// The « Taille humaine » sample pack and its avatar, out of the project and its three app files.
function dropHumanDemo(root) {
  fs.rmSync(path.join(root, 'games/humandemo'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'art-source/jungle'), { recursive: true, force: true });
  edit(path.join(root, 'apps/client/src/main.ts'), (s) => s.replace(/^import humandemo from .*\n/m, '').replace(/,\s*humandemo\]/, ']'));
  for (const f of ['index.ts', 'bots.ts', 'gameDocument.ts']) {
    edit(path.join(root, 'apps/server/src', f), (s) => s.replace(/^import \{ humanDemoPlugin \} from .*\n/m, '').replace(/,\s*humanDemoPlugin\]/, ']'));
  }
  edit(path.join(root, 'apps/client/src/room.worker.ts'), (s) => s.replace(/ `humandemo` has no room plugin, so it is not listed\./, ''));
  edit(path.join(root, 'README.md'), (s) => s
    .replace(/^games\/humandemo\/.*\n/m, '')
    .replace(/A project on the Jungle engine: two thin apps and two Game Packs\./, 'A project on the Jungle engine: two thin apps and one Game Pack.')
    .replace(/\nThe second pack, `games\/humandemo\/`[\s\S]*?gorilla envelope\.\n/, '\n'));
}

function splashSvg(title) {
  const words = title.toUpperCase().split(/\s+/).filter(Boolean);
  const half = Math.ceil(words.length / 2);
  const lines = title.length > 12 && words.length > 1 ? [words.slice(0, half).join(' '), words.slice(half).join(' ')] : [words.join(' ')];
  const size = Math.max(36, Math.min(72, Math.floor(1000 / Math.max(...lines.map((l) => l.length)))));
  const ys = lines.length > 1 ? [236, 320] : [278];
  const fills = ['#f4f1ea', '#f2c14e'];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="512" viewBox="0 0 1024 512" role="img" aria-label="${xml(title)}">
  <!-- The game's splash (StartAppOptions.splash in src/main.ts): a placeholder made by Ballast, replace it with the game's own art. -->
  <rect x="112" y="96" width="320" height="320" rx="64" fill="#2f7d5b"/>
  <circle cx="272" cy="256" r="96" fill="#f2c14e"/>
  <path d="M272 176 L340 296 L204 296 Z" fill="#2f7d5b"/>
${lines.map((l, i) => `  <text x="480" y="${ys[i]}" font-family="system-ui, sans-serif" font-size="${size}" font-weight="800" fill="${fills[i]}">${xml(l)}</text>`).join('\n')}
</svg>
`;
}

function claudeMd({ id, title, engine }) {
  return `# ${title}

A Jungle Engine game: one Game Pack, \`games/${id}/\`, in a project made from the engine's starter (engine ${engine}).
The engine is the four \`@jungle/*\` npm packages; this repo never holds or edits engine code. Read \`README.md\` for the
layout, and the docs site for the API: ${DOCS}/ (Game Pack guide, API guide, Testing on a Quest).

## First time in a checkout or worktree

\`npm install\` (the engine comes from GitHub Packages; the token is in the user's ~/.npmrc, never in this repo).
\`npm run dev\` serves the game at https://localhost:5173 (self-signed certificate) with the server on :2567.

## Rules

- Import the engine only through its public subpaths: \`@jungle/engine-client/<module>\`, \`@jungle/engine-server/…\`,
  \`@jungle/shared\` (\`npm run api\` checks it). Never import from \`node_modules\` paths or edit engine packages: an engine
  change is asked of the engine team.
- Everything the game names starts with its id: keys, settings, services, item kinds \`${id}.<name>\`, events
  \`${id}:<name>\`, network messages \`g.${id}.<name>\`.
- A game is registered in three places: \`apps/client/src/main.ts\` (\`games\`), \`apps/client/src/room.worker.ts\` (its
  \`room/\` entry) and \`apps/server/src/\` (\`runGameServer({ games })\`, bots, gameDocument).
- \`games/${id}/room/\` runs in a Web Worker as well as on the server: it imports only the game's \`shared/\`,
  \`@jungle/shared\` and \`@jungle/shared/room/plugin\` (no Node, no \`@jungle/engine-server\`).
- The testing kits (\`@jungle/engine-client/testing\`, \`@jungle/engine-server/testing\`) are for \`*.test.ts\` files only.
- Art sources go in \`art-source/${id}/\` with their licence in that folder's \`import.json\`; commit the \`CREDITS.md\`
  the import rewrites. \`.jungle/\` is generated, never committed.
- Quest first: keep the client build inside \`npm run budget\`, follow the docs site's rendering rules (GLSL materials,
  no RawShaderMaterial, one directional light, no realtime shadows in VR).

## Before you hand work in

\`npm run check\`: typecheck, tests, the API check, a build and the download budget. All of it passes.
`;
}

const jobs = new Map(); // gameId -> running setup, so a second click does not run it twice

// Makes the project in `dir` and adds it to Ballast. The copy and the first commit happen before this returns
// (seconds); npm install and the checks then run in the background and report in the game's feed, and the agents
// join once the project is installed.
export async function createProject({ name, id, dir, tagline = '', keepHumanDemo = false, brief = '', accountIds = [], isolation = 'worktree', github = null }) {
  const title = must(String(name || '').trim(), 'Give the game a name.');
  id = String(id || idFromName(title)).trim();
  must(!idProblem(id), idProblem(id));
  const root = path.resolve(must(String(dir || '').trim(), 'Choose a folder for the project.'));
  must(!fs.existsSync(root) || fs.readdirSync(root).length === 0, `${root} already has files in it. Pick a new or empty folder.`);
  must(!db.games.some((g) => g.repoPath && path.resolve(g.repoPath) === root), 'Another Ballast game already uses that folder.');
  const pre = await check();
  const missing = pre.items.filter((i) => !i.ok && i.key !== 'gh');
  must(!missing.length, `This PC is not ready: ${missing.map((i) => `${i.label}. ${i.fix}`).join(' ')}`);

  const src = await fetchStarter(await releaseCommit('latest'));
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(src.starter, root, { recursive: true });
  } finally {
    fs.rmSync(src.dir, { recursive: true, force: true });
  }
  const engine = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies['@jungle/engine-client'].match(/@\^?([\d.]+)/)?.[1] || pre.engine;

  if (!keepHumanDemo) dropHumanDemo(root);
  fs.renameSync(path.join(root, 'games/demo'), path.join(root, `games/${id}`));
  fs.renameSync(path.join(root, 'art-source/demo'), path.join(root, `art-source/${id}`));
  for (const file of walk(root)) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (!TEXT.test(path.basename(file)) || rel.startsWith('games/humandemo/') || rel.startsWith('art-source/jungle/')) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = renameDemo(before.replace(/My Jungle Game/g, title), id);
    if (after !== before) fs.writeFileSync(file, after);
  }
  const en = tagline.trim() || `${title}, a game on the Jungle engine.`;
  edit(path.join(root, `games/${id}/client/manifest.ts`), (s) => s
    .replace(/'DÉMO'/, q(title)).replace(/'DEMO'/, q(title))
    .replace(/'Le plus petit Game Pack possible\.'/, q(tagline.trim() || `${title}, un jeu sur le moteur Jungle.`))
    .replace(/'The smallest possible Game Pack\.'/, q(en)));
  edit(path.join(root, `art-source/${id}/world.scene.json`), (s) => s.replace(/"title": "[^"]*"/, `"title": ${JSON.stringify(title)}`));
  fs.writeFileSync(path.join(root, 'apps/client/public/splash.svg'), splashSvg(title));
  edit(path.join(root, 'quest.config.example.json'), (s) => s.replace(/myjunglegame/g, id));
  edit(path.join(root, 'package.json'), (s) => {
    const pkg = JSON.parse(s);
    pkg.name = `jungle-${id}`;
    pkg.scripts.check = 'npm run typecheck && npm test && npm run api && npm run build && npm run budget';
    return `${JSON.stringify(pkg, null, 2)}\n`;
  });
  edit(path.join(root, 'README.md'), (s) => s.replace(/^# Jungle game starter\n/, `# ${title}\n\nMade from the Jungle Engine starter (engine ${engine}, jungle-engine ${src.sha}) by Ballast.\n`));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), claudeMd({ id, title, engine }));

  await git.git(root, ['init', '--quiet', '--initial-branch=main']);
  await git.git(root, ['add', '-A']);
  const ident = (await git.git(root, ['config', 'user.email']).catch(() => '')) ? [] : ['-c', 'user.name=Ballast', '-c', 'user.email=ballast@localhost'];
  await git.git(root, [...ident, 'commit', '--quiet', '-m', `Jungle Engine starter (engine ${engine}) as ${id}`]);

  const game = await orch.createGame({
    name: title, repoPath: root, isolation, survey: false, accountIds: [],
    brief: brief.trim() || `${title}: a Jungle Engine game (Game Pack \`${id}\`). Pillars, platform and art direction to come.`,
  });
  orch.updateGame(game.id, { checkCommand: 'npm run check', build: { command: 'npm install --no-audit --no-fund && npm run build', outputPath: 'apps/client/dist' } });
  game.jungle = { id, engine, starterSha: src.sha, createdAt: Date.now() };
  save();
  orch.feedPost(game.id, {
    kind: 'system',
    text: `Made from the Jungle Engine starter (engine ${engine}): Game Pack \`${id}\` in ${root}${keepHumanDemo ? ', with the « Taille humaine » sample pack' : ''}. Installing the engine packages and running the checks next; agents join when that passes.`,
  });
  const job = finishSetup(game, { root, accountIds, github }).finally(() => jobs.delete(game.id));
  jobs.set(game.id, job);
  return game;
}

async function finishSetup(game, { root, accountIds, github }) {
  const post = (text) => orch.feedPost(game.id, { kind: 'system', text });
  const install = await sh('npm install --no-audit --no-fund', root, 20);
  if (install.code !== 0) {
    post(`✗ npm install failed, so no agents were added yet. Fix it, then add agents from the Agents tab.\n${tail(install.out)}`);
    return;
  }
  // The checks the engine's starter ships with; a failure is reported, not fatal: the agents fix it first.
  const results = [];
  for (const [label, cmd, min] of [['Tests', 'npm test', 10], ['Engine API', 'npm run api', 5], ['Typecheck', 'npm run typecheck', 15], ['Build', 'npm run build', 20]]) {
    const r = await sh(cmd, root, min);
    results.push({ label, ok: r.code === 0, out: r.out });
  }
  // The starter ships without a lockfile: commit the one npm install wrote (and anything the first build rewrote, like CREDITS.md).
  const dirty = await git.git(root, ['status', '--porcelain']).catch(() => '');
  if (dirty.trim()) {
    await git.git(root, ['add', '-A']);
    const ident = (await git.git(root, ['config', 'user.email']).catch(() => '')) ? [] : ['-c', 'user.name=Ballast', '-c', 'user.email=ballast@localhost'];
    await git.git(root, [...ident, 'commit', '--quiet', '-m', 'Lock the engine install (package-lock.json)']).catch(() => {});
    if (game.isolation === 'worktree') await git.git(root, ['branch', '-f', game.integrationBranch, 'HEAD']).catch(() => {});
  }
  const failed = results.filter((r) => !r.ok);
  post(`${results.map((r) => `${r.ok ? '✓' : '✗'} ${r.label}`).join('  ')}${failed.length ? `\n\n${failed.map((r) => `${r.label}:\n${tail(r.out, 8)}`).join('\n\n')}` : '\n\nRun it: npm run dev in the project folder, then open https://localhost:5173.'}`);

  if (github?.repo) {
    const vis = github.public ? '--public' : '--private';
    const r = await sh(`gh repo create ${github.repo} ${vis} --source . --remote origin --push`, root, 5);
    post(r.code === 0 ? `Pushed to github.com/${github.repo} (${github.public ? 'public' : 'private'}).` : `✗ Could not create github.com/${github.repo}:\n${tail(r.out, 6)}`);
  }

  for (const accountId of accountIds) {
    try { await orch.addAgent(game.id, { accountId }); } catch (err) { post(`✗ Could not add an agent: ${err.message}`); }
  }
  if (failed.length && accountIds.length) {
    orch.addTask(game.id, {
      title: `[build & tools] Make the starter's checks pass: ${failed.map((r) => r.label).join(', ')}`,
      detail: `The fresh Jungle Engine project failed ${failed.map((r) => r.label).join(', ')} right after npm install. Run npm run check, fix what fails without editing engine packages, and report what was wrong.\n\n${failed.map((r) => `${r.label}:\n${tail(r.out, 12)}`).join('\n\n')}`,
    });
  }
}

export const settingUp = (gameId) => jobs.has(gameId);

// ---------------------------------------------------------------------------
// A new game in a games repo the developer already has: one project, one Game Pack per game
// (thecompanylive/jungle-<name> repos are laid out this way). The starter's demo pack, from the
// engine release the project installs, lands in <games folder>/<id> on a branch, registered in the
// project's apps, and goes up as a pull request. The Ballast game is a cloud game on that folder;
// its autopilot stays off until the pull request is merged.

// Adds `line` after the last `import … from '@game/…'` line.
function addImport(src, line) {
  const m = [...src.matchAll(/^import [^\n]*from '@game\/[^']+';[ \t]*$/gm)].pop();
  if (!m) return null;
  const at = m.index + m[0].length;
  return `${src.slice(0, at)}\n${line}${src.slice(at)}`;
}
// Adds `entry` to the list that follows `games:` (an array `[…]` or an object `{…}`), in the list's own
// layout: one line stays one line, one entry per line stays that way with its trailing-comma style.
// Brackets are matched by depth, skipping strings, so any formatting of the file works.
function addGameEntry(src, entry, from = 0) {
  const key = /\bgames:\s*([[{])/g;
  key.lastIndex = from;
  const m = key.exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const [o, c] = m[1] === '[' ? ['[', ']'] : ['{', '}'];
  let depth = 0;
  let close = -1;
  for (let i = open, quote = null; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === o) depth++;
    else if (ch === c && --depth === 0) { close = i; break; }
  }
  if (close < 0) return null;
  const inner = src.slice(open + 1, close);
  const body = inner.replace(/\s+$/, '');
  const after = inner.slice(body.length);
  let next;
  if (!body.trim()) next = o === '[' ? entry : ` ${entry} `;
  else if (body.includes('\n')) {
    const indent = body.match(/\n([ \t]*)\S[^\n]*$/)?.[1] ?? '  ';
    const comma = body.endsWith(',');
    next = `${comma ? body : `${body},`}\n${indent}${entry}${comma ? ',' : ''}${after}`;
  } else next = `${body.replace(/,$/, '')}, ${entry}${after}`;
  return `${src.slice(0, open + 1)}${next}${src.slice(close)}`;
}

// The three places a game is registered (the starter's README): client games, room worker, server apps.
function register(root, id) {
  const patch = (rel, fn, required = true) => {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
      if (required) throw Object.assign(new Error(`The project has no ${rel}, so ${id} can't be registered there. Nothing was pushed.`), { status: 400 });
      return;
    }
    const before = fs.readFileSync(file, 'utf8');
    const after = fn(before);
    if (!after || after === before) throw Object.assign(new Error(`Couldn't add ${id} to the games list in ${rel}: it doesn't look like the starter's. Nothing was pushed.`), { status: 400 });
    fs.writeFileSync(file, after);
  };
  const server = (s) => { const t = addImport(s, `import { ${id}Plugin } from '@game/${id}/server';`); return t && addGameEntry(t, `${id}Plugin`, Math.max(0, t.search(/\brun(GameServer|Bots|GameDocumentCli)\(/))); };
  patch('apps/client/src/main.ts', (s) => { const t = addImport(s, `import ${id} from '@game/${id}/client';`); return t && addGameEntry(t, id, Math.max(0, t.indexOf('startApp('))); });
  patch('apps/client/src/room.worker.ts', (s) => { const at = s.indexOf('runRoomWorker('); return at < 0 ? null : addGameEntry(s, `${id}: () => import('@game/${id}/room')`, at); });
  patch('apps/server/src/index.ts', server);
  for (const f of ['bots.ts', 'gameDocument.ts']) patch(`apps/server/src/${f}`, server, false);
}

// The demo pack's names, title and tagline, in the copied pack and art folders.
function adaptPack([packDir, artDir], { id, title, tagline }) {
  for (const dir of [packDir, artDir]) {
    for (const file of walk(dir)) {
      if (!TEXT.test(path.basename(file))) continue;
      const before = fs.readFileSync(file, 'utf8');
      const after = renameDemo(before, id);
      if (after !== before) fs.writeFileSync(file, after);
    }
  }
  edit(path.join(packDir, 'client/manifest.ts'), (s) => s
    .replace(/'DÉMO'/, q(title)).replace(/'DEMO'/, q(title))
    .replace(/'Le plus petit Game Pack possible\.'/, q(tagline.trim() || `${title}, un jeu sur le moteur Jungle.`))
    .replace(/'The smallest possible Game Pack\.'/, q(tagline.trim() || `${title}, a game on the Jungle engine.`)));
  edit(path.join(artDir, 'world.scene.json'), (s) => s.replace(/"title": "[^"]*"/, `"title": ${JSON.stringify(title)}`));
}

// Scaffolds the pack in a shallow sparse clone of the repo (root files, apps/ and the games folder).
async function scaffoldInRepo({ gh, games, id, title, tagline }) {
  const work = path.join(paths.tmp, `jungle-add-${id}-${Date.now().toString(36)}`);
  await git.git(paths.tmp, ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--sparse', ...(gh.branch ? ['--branch', gh.branch] : []), gh.url, work]);
  try {
    await git.git(work, ['sparse-checkout', 'set', 'apps', games, `art-source/${id}`]);
    const base = await git.currentBranch(work);
    const pkg = JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8').replace(/^﻿/, ''));
    must((pkg.workspaces || []).includes(`${games}/*`), `${gh.slug} doesn't list ${games}/* as npm workspaces, so a game there wouldn't be installed. Link the games folder of a Jungle Engine project (…/tree/main/games).`);
    must(!fs.existsSync(path.join(work, games, id)), `${games}/${id} already exists in ${gh.slug}. Pick another game id.`);
    let engine = null;
    try { engine = JSON.parse(fs.readFileSync(path.join(work, 'package-lock.json'), 'utf8')).packages?.['node_modules/@jungle/engine-client']?.version || null; } catch { /* no lockfile */ }
    engine ||= pkg.dependencies?.['@jungle/engine-client']?.match(/@[\^~]?([\d.]+)/)?.[1];
    must(engine, `${gh.slug} doesn't depend on @jungle/engine-client, so it isn't a Jungle Engine project.`);
    const src = await fetchStarter(await releaseCommit(engine));
    const packDir = path.join(work, games, id);
    const artDir = path.join(work, 'art-source', id);
    try {
      fs.cpSync(path.join(src.starter, 'games/demo'), packDir, { recursive: true });
      fs.cpSync(path.join(src.starter, 'art-source/demo'), artDir, { recursive: true });
    } finally {
      fs.rmSync(src.dir, { recursive: true, force: true });
    }
    adaptPack([packDir, artDir], { id, title, tagline });
    register(work, id);
    return { work, base, engine, starterSha: src.sha, check: pkg.scripts?.check ? 'npm run check' : '' };
  } catch (err) {
    fs.rmSync(work, { recursive: true, force: true });
    throw err;
  }
}

async function installAndCheck(work, packPath) {
  const install = await sh('npm install --no-audit --no-fund', work, 20);
  if (install.code !== 0) return { installed: false, results: [], out: tail(install.out) };
  const results = [];
  const mine = (out) => out.split('\n').some((l) => l.replace(/\\/g, '/').includes(`${packPath}/`));
  for (const [label, cmd, min] of [['Tests', `npx vitest run ${packPath}`, 10], ['Engine API', 'npm run api', 5], ['Typecheck', 'npm run typecheck', 20]]) {
    const r = await sh(cmd, work, min, 400000);
    const ok = r.code === 0;
    // Tests run on the new game alone; the other two cover every game in the repo.
    const elsewhere = !ok && label !== 'Tests' && !mine(r.out);
    const others = elsewhere ? [...new Set(r.out.split('\n').map((l) => l.replace(/\\/g, '/').match(/^(?:\S*?)(games\/[a-z0-9]+)\//)?.[1]).filter(Boolean))] : [];
    results.push({ label, ok: ok || elsewhere, elsewhere, others, out: r.out });
  }
  return { installed: true, results };
}

// `folder` is a GitHub link to the games folder (…/tree/main/games). With `dryRun`, nothing is pushed
// and no Ballast game is made: the scaffold is installed and checked, and the work folder is kept.
export async function addToGamesRepo({ name, id, folder, tagline = '', brief = '', accountIds = [], dryRun = false }) {
  const title = must(String(name || '').trim(), 'Give the game a name.');
  id = String(id || idFromName(title)).trim();
  must(!idProblem(id), idProblem(id));
  const gh = must(git.parseGithub(folder), 'Give the games folder as a GitHub link, e.g. https://github.com/owner/repo/tree/main/games');
  const games = (gh.subdir || 'games').replace(/^\/+|\/+$/g, '');
  must(!db.games.some((g) => g.github === gh.slug && g.subdir === `${games}/${id}`), 'A Ballast game already uses that folder.');
  const pre = await check();
  const missing = pre.items.filter((i) => !i.ok);
  must(!missing.length, `This PC is not ready: ${missing.map((i) => `${i.label}. ${i.fix}`).join(' ')}`);

  const s = await scaffoldInRepo({ gh, games, id, title, tagline });
  if (dryRun) return { ...s, ...(await installAndCheck(s.work, `${games}/${id}`)) };

  db.settings.jungleGamesFolder = `https://github.com/${gh.slug}/tree/${s.base}/${games}`;
  const game = await orch.createGame({
    name: title, runner: 'cloud', github: `https://github.com/${gh.slug}/tree/${s.base}/${games}/${id}`, baseBranch: s.base, survey: false, accountIds,
    brief: brief.trim() || `${title}: a Jungle Engine game (Game Pack \`${id}\` in ${games}/${id} of ${gh.slug}). Pillars, platform and art direction to come.`,
  });
  orch.updateGame(game.id, { autopilot: false, checkCommand: s.check });
  game.jungle = { id, engine: s.engine, starterSha: s.starterSha, repo: gh.slug, folder: `${games}/${id}`, waitingForMerge: true, createdAt: Date.now() };
  save();
  orch.feedPost(game.id, {
    kind: 'system',
    text: `Game Pack \`${id}\` made from the Jungle Engine starter for engine ${s.engine} (what ${gh.slug} installs), in ${games}/${id} and registered in the project's apps. Installing and checking it next, then opening a pull request into ${s.base}. Autopilot stays off until that pull request is merged.`,
  });
  const job = finishRepoSetup(game, { ...s, gh, games, id, title }).finally(() => jobs.delete(game.id));
  jobs.set(game.id, job);
  return game;
}

const resultLine = (r, id) => (r.elsewhere
  ? `✓ ${r.label} (nothing in ${id}; already failing on the base branch${r.others.length ? ` in ${r.others.join(', ')}` : ''})`
  : `${r.ok ? '✓' : '✗'} ${r.label}`);

async function finishRepoSetup(game, { work, base, engine, gh, games, id, title }) {
  const post = (text, kind = 'system') => orch.feedPost(game.id, { kind, text });
  try {
    const { installed, results, out } = await installAndCheck(work, `${games}/${id}`);
    if (!installed) { post(`✗ npm install failed in a copy of ${gh.slug}, so nothing was pushed. The copy is at ${work}.\n${out}`, 'error'); return; }
    const failed = results.filter((r) => !r.ok);
    const branch = `ballast/new-game-${id}`;
    await git.git(work, ['checkout', '--quiet', '-b', branch]);
    // Only what this game adds: its pack, its art, the app registrations and the lockfile entry.
    await git.git(work, ['add', '--sparse', '--', `${games}/${id}`, `art-source/${id}`, 'apps', 'package-lock.json']);
    await git.git(work, ['commit', '--quiet', '-m', `Add ${title} (Game Pack ${id}) from the Jungle Engine starter`]);
    await git.git(work, ['push', '--quiet', '-u', 'origin', branch]);
    const fence = '```';
    const body = [
      `Adds **${title}**, Game Pack \`${id}\`, made by Ballast from the Jungle Engine starter's demo pack for engine ${engine} (the version this project installs).`,
      '',
      `- \`${games}/${id}/\`: the pack, renamed to \`${id}\``,
      `- \`art-source/${id}/\`: its starter art`,
      '- registered in `apps/client/src/main.ts`, `apps/client/src/room.worker.ts` and `apps/server/src/`',
      '- `package-lock.json`: the new workspace package',
      '',
      `Checks on this branch: ${results.map((r) => resultLine(r, id)).join(' · ')}`,
      ...(failed.length ? ['', ...failed.map((r) => `<details><summary>${r.label}</summary>\n\n${fence}\n${tail(r.out, 20)}\n${fence}\n</details>`)] : []),
      '',
      "The game's Ballast agents start once this is merged.",
    ].join('\n');
    const bodyFile = path.join(paths.tmp, `pr-${id}.md`);
    fs.writeFileSync(bodyFile, body);
    const pr = await sh(`gh pr create --repo ${gh.slug} --base ${base} --head ${branch} --title "Add ${title.replace(/"/g, "'")} (Game Pack ${id})" --body-file "${bodyFile}"`, work, 3);
    fs.rmSync(bodyFile, { force: true });
    const url = pr.out.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
    if (!url) { post(`✗ Pushed ${branch} to ${gh.slug} but couldn't open the pull request:\n${tail(pr.out, 6)}`, 'error'); return; }
    game.jungle.pr = url;
    save();
    post(`${results.map((r) => resultLine(r, id)).join('\n')}\n\nPull request: ${url}\nMerge it to start the agents: autopilot turns on by itself once it's in ${base}.${failed.length ? `\n\n${failed.map((r) => `${r.label}:\n${tail(r.out, 8)}`).join('\n\n')}` : ''}`);
    fs.rmSync(work, { recursive: true, force: true });
  } catch (err) {
    post(`✗ Setting up ${id} in ${gh.slug} stopped: ${err.message}. The copy is at ${work}.`, 'error');
  }
}

// Turns autopilot on for a games-repo game once its pull request is merged.
async function watchMerges() {
  for (const game of db.games.filter((g) => g.jungle?.waitingForMerge && g.jungle.pr)) {
    const r = await sh(`gh pr view ${game.jungle.pr} --json state`, os.homedir(), 1);
    const state = r.code === 0 ? r.out.match(/"state":"(\w+)"/)?.[1] : null;
    if (state === 'MERGED') {
      game.jungle.waitingForMerge = false;
      orch.updateGame(game.id, { autopilot: true });
      orch.feedPost(game.id, { kind: 'system', text: `${game.jungle.pr} is merged: ${game.jungle.folder} is on ${game.baseBranch}, and autopilot is on.` });
    } else if (state === 'CLOSED') {
      game.jungle.waitingForMerge = false;
      save();
      orch.feedPost(game.id, { kind: 'system', text: `${game.jungle.pr} was closed without merging, so ${game.jungle.folder} isn't in the repo. Autopilot stays off.` });
    }
  }
}

export function init() {
  setInterval(() => { watchMerges().catch(() => {}); }, 5 * 60e3).unref();
  setTimeout(() => { watchMerges().catch(() => {}); }, 30e3).unref();
}
