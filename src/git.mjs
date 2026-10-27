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

export const log = (dir, from, to) =>
  git(dir, ['log', '--oneline', '--no-decorate', '-n', '60', `${from}..${to}`]).catch(() => '');
