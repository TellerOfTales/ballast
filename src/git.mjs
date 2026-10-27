// Git helpers for per-agent worktrees and the shared integration branch.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

function run(cwd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 128 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(String(stderr || err.message).trim()), { stderr: String(stderr || '') }));
      else resolve(opts.encoding === 'buffer' ? stdout : stdout.trim());
    });
  });
}

// Several agents can be handed work at the same moment, and two git commands in one folder
// collide on .git/index.lock. So Ballast runs its git commands one at a time per folder.
const queues = new Map(); // folder -> tail of its promise chain
function serial(cwd, fn) {
  const key = path.resolve(cwd).toLowerCase();
  const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}

const LOCK_RE = /index\.lock'?: File exists|Unable to create .*\.lock/i;

// Another program (an IDE, a terminal) can still hold the lock briefly: wait and retry. A lock
// left behind by a killed git in one of Ballast's own clones is removed once it's clearly stale.
async function withLockRetry(cwd, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!LOCK_RE.test(err.message) || attempt >= 5) throw err;
      const lock = err.message.match(/'([^']+\.lock)'/)?.[1];
      const age = lock && fs.existsSync(lock) ? Date.now() - fs.statSync(lock).mtimeMs : 0;
      if (lock && age > 120e3 && /[\\/]\.ballast[\\/]clones[\\/]/i.test(path.resolve(lock))) fs.rmSync(lock, { force: true });
      await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
    }
  }
}

export function git(cwd, args, opts) {
  return serial(cwd, () => withLockRetry(cwd, () => run(cwd, args, opts)));
}

export const isRepo = (dir) => git(dir, ['rev-parse', '--is-inside-work-tree']).then((o) => o === 'true', () => false);
export const hasCommits = (dir) => git(dir, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false);
export const currentBranch = (dir) => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
export const head = (dir) => git(dir, ['rev-parse', '--short', 'HEAD']);
export const branchExists = (dir, branch) =>
  git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);

async function identityArgs(dir) {
  const email = await git(dir, ['config', 'user.email']).catch(() => '');
  return email ? [] : ['-c', 'user.name=Ballast', '-c', 'user.email=ballast@localhost'];
}

// New games start from an empty folder: make it a repo with one commit so branches work.
export async function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (!(await isRepo(dir))) await git(dir, ['init']);
  if (!(await hasCommits(dir))) {
    await git(dir, [...(await identityArgs(dir)), 'commit', '--allow-empty', '-m', 'Ballast: start project']);
  }
}

export async function ensureBranch(repo, branch, from) {
  if (!(await branchExists(repo, branch))) await git(repo, ['branch', branch, from || 'HEAD']);
}

export const worktreeRoot = (repo) => `${path.resolve(repo)}.ballast`;

export async function ensureWorktree(repo, wtPath, branch, from) {
  if (fs.existsSync(path.join(wtPath, '.git'))) return;
  await git(repo, ['worktree', 'prune']);
  if (await branchExists(repo, branch)) await git(repo, ['worktree', 'add', wtPath, branch]);
  else await git(repo, ['worktree', 'add', '-b', branch, wtPath, from]);
}

// Builds run in a detached worktree so the integration branch is never checked out
// (agents fast-forward it with `git push . HEAD:<branch>`).
export async function prepareBuildWorktree(repo, ref) {
  const wt = path.join(worktreeRoot(repo), '_build');
  if (!fs.existsSync(path.join(wt, '.git'))) {
    await git(repo, ['worktree', 'prune']);
    await git(repo, ['worktree', 'add', '--detach', wt, ref]);
  } else {
    await git(wt, ['checkout', '--detach', '--force', ref]);
  }
  return wt;
}

// ---------------------------------------------------------------------------
// GitHub-backed games (agents run in Claude's cloud; Ballast watches the remote)

// Accepts "owner/name", https or ssh URLs, and folder links like
// https://github.com/owner/name/tree/main/game (branch "main", project folder "game").
export function parseGithub(input) {
  const s = String(input || '').trim().replace(/\/+$/, '');
  const m = s.match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+))?)?$/);
  if (!m) return null;
  return { slug: `${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/${m[2]}.git`, branch: m[3] || null, subdir: m[4] ? decodeURIComponent(m[4]) : null };
}

export async function remoteSlug(dir) {
  const url = await git(dir, ['remote', 'get-url', 'origin']).catch(() => '');
  return parseGithub(url)?.slug || null;
}

export async function cloneRepo(url, dir) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(path.dirname(dir), ['clone', url, dir]);
}

// Remote branch heads, without fetching anything.
export async function remoteHeads(dir) {
  const out = await git(dir, ['ls-remote', '--heads', 'origin']);
  const heads = {};
  for (const line of out.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref?.startsWith('refs/heads/')) heads[ref.slice(11)] = sha;
  }
  return heads;
}

// Every branch on origin plus the one GitHub calls the default, in one round trip.
export async function remoteBranches(dir) {
  const out = await git(dir, ['ls-remote', '--symref', 'origin', 'HEAD', 'refs/heads/*']);
  const heads = {};
  let defaultBranch = null;
  for (const line of out.split('\n')) {
    const sym = line.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/);
    if (sym) { defaultBranch = sym[1]; continue; }
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref?.startsWith('refs/heads/')) heads[ref.slice(11)] = sha;
  }
  return { heads, defaultBranch };
}

// Fetches the given remote branches into a private namespace so the user's refs are untouched.
export async function fetchBranches(dir, branches) {
  if (!branches.length) return;
  await git(dir, ['fetch', '--no-tags', '--quiet', 'origin', ...branches.map((b) => `+refs/heads/${b}:refs/ballast/remote/${b}`)]);
}

export const listRemoteFiles = (dir, branch, prefix) =>
  git(dir, ['ls-tree', '-r', '--name-only', `refs/ballast/remote/${branch}`, '--', prefix]).then((o) => o.split('\n').filter(Boolean));

export const readRemoteBlob = (dir, branch, file) => git(dir, ['show', `refs/ballast/remote/${branch}:${file}`], { encoding: 'buffer' });

export const showRemoteFile =(dir, branch, file) => git(dir, ['show', `refs/ballast/remote/${branch}:${file}`]).catch(() => null);

// Publishes a set of files as the only contents of `branch` on origin, without touching the
// clone's working tree, index or other branches: blobs are written straight to the object store,
// a tree is built in a throwaway index, and a parentless commit is force-pushed to the branch.
export async function publishFlatBranch(dir, branch, files, message) {
  const tmpIndex = path.join(dir, '.git', `ballast-index-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    for (const f of files) {
      const sha = await git(dir, ['hash-object', '-w', f.path]);
      await git(dir, ['update-index', '--add', '--cacheinfo', `100644,${sha},${f.name}`], { env });
    }
    const tree = await git(dir, ['write-tree'], { env });
    const commit = await git(dir, [...(await identityArgs(dir)), 'commit-tree', tree, '-m', message]);
    await git(dir, ['push', '--force', '--quiet', 'origin', `${commit}:refs/heads/${branch}`]);
    return commit;
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

// Brings the local clone to the remote base branch. It must be a real branch, not a detached
// commit: `claude --cloud` starts the session from the clone's remote at its current branch.
export async function syncClone(dir, base) {
  await git(dir, ['fetch', '--no-tags', '--quiet', 'origin', base]);
  await git(dir, ['checkout', '--quiet', '--force', '-B', base, `origin/${base}`]);
}

export const log = (dir, from, to) =>
  git(dir, ['log', '--oneline', '--no-decorate', '-n', '60', `${from}..${to}`]).catch(() => '');
