// First-run checks: what this PC needs before an author developer can run agents.
import { execFile } from 'node:child_process';
import { db, save } from './store.mjs';
import { changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as whisper from './whisper.mjs';
import * as policy from './policy.mjs';

const IS_WIN = process.platform === 'win32';

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, shell: IS_WIN }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim() });
    });
  });
}

const version = (s) => s.match(/\d+\.\d+(?:\.\d+)?/)?.[0] || '';

export async function check() {
  const node = process.versions.node;
  const [cl, git, gh] = await Promise.all([
    run(`"${claude.resolveClaude()}"`, ['--version']),
    run('git', ['--version']),
    run('gh', ['--version']),
  ]);
  const ghAuth = gh.ok ? await run('gh', ['auth', 'status']) : { ok: false, out: '' };
  const w = whisper.info();
  const items = [
    {
      id: 'node', label: 'Node.js 20 or newer', ok: Number(node.split('.')[0]) >= 20, detail: `v${node}`, required: true,
      fix: 'Install the LTS version from nodejs.org, then restart Ballast.', cmd: IS_WIN ? 'winget install -e --id OpenJS.NodeJS.LTS' : '',
    },
    {
      id: 'claude', label: 'Claude Code', ok: cl.ok, detail: cl.ok ? version(cl.out) : 'not found', required: true,
      fix: 'Agents run through the Claude Code CLI. Install it, then press Check again.', cmd: IS_WIN ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash',
    },
    {
      id: 'git', label: 'git', ok: git.ok, detail: git.ok ? version(git.out) : 'not found', required: true,
      fix: 'Games live in git repos; agents commit to them.', cmd: IS_WIN ? 'winget install -e --id Git.Git' : '',
    },
    {
      id: 'gh', label: 'GitHub CLI, signed in', ok: gh.ok && ghAuth.ok, detail: !gh.ok ? 'not installed' : ghAuth.ok ? (ghAuth.out.match(/account (\S+)/)?.[1] || 'signed in') : 'not signed in', required: false,
      fix: 'Only needed for cloud games (agents running as Claude cloud sessions on a GitHub repo) and for merging their pull requests.', cmd: gh.ok ? 'gh auth login' : IS_WIN ? 'winget install -e --id GitHub.cli' : '',
    },
    {
      id: 'whisper', label: 'Local Whisper for voice reviews', ok: w.installed, detail: w.installed ? w.model : 'not installed', required: false,
      fix: 'Optional. Director Review works with Chrome\'s speech recognition; Whisper on your GPU is far more accurate. Ask Claude in Ballast\'s repo to set it up, or see the README.', cmd: '',
    },
  ];
  return { items, ready: items.filter((i) => i.required).every((i) => i.ok), platform: process.platform };
}

// The wizard's answers. Starter usage rules become the default for new games.
export function finish(body = {}) {
  if (body.directorName !== undefined) db.settings.directorName = String(body.directorName).trim() || 'Director';
  if (body.defaultRules !== undefined) db.settings.defaultUsagePolicy = body.defaultRules ? policy.normalize({ rules: policy.PRESETS.filter((p) => p.starter) }) : null;
  if (body.done) db.settings.setupDone = true;
  save();
  changed();
  return db.settings;
}
