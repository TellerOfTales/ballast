// Git helpers for per-agent worktrees and the shared integration branch.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
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

// Fetches the given remote branches into a private namespace so the user's refs are untouched.
export async function fetchBranches(dir, branches) {
  if (!branches.length) return;
  await git(dir, ['fetch', '--no-tags', '--quiet', 'origin', ...branches.map((b) => `+refs/heads/${b}:refs/ballast/remote/${b}`)]);
}

export const showRemoteFile = (dir, branch, file) => git(dir, ['show', `refs/ballast/remote/${branch}:${file}`]).catch(() => null);

// Brings the local clone to the remote base branch. It must be a real branch, not a detached
// commit: `claude --cloud` starts the session from the clone's remote at its current branch.
export async function syncClone(dir, base) {
  await git(dir, ['fetch', '--no-tags', '--quiet', 'origin', base]);
  await git(dir, ['checkout', '--quiet', '--force', '-B', base, `origin/${base}`]);
}

export const log = (dir, from, to) =>
  git(dir, ['log', '--oneline', '--no-decorate', '-n', '60', `${from}..${to}`]).catch(() => '');
