// Thin layer over the Claude Code CLI: locating it, running headless turns,
// checking auth, and opening a visible terminal for logins / manual takeover.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFile } from 'node:child_process';
import { db, paths, uid } from './store.mjs';

const IS_WIN = process.platform === 'win32';

export function resolveClaude() {
  const override = db.settings.claudePath?.trim();
  if (override) return override;
  const names = IS_WIN ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter),
    path.join(os.homedir(), '.local', 'bin'),
    ...(IS_WIN && process.env.APPDATA ? [path.join(process.env.APPDATA, 'npm')] : []),
  ];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (dir && fs.existsSync(candidate)) return candidate;
    }
  }
  return 'claude';
}

// Environment for one account. The default account uses the machine's normal
// Claude login, so CLAUDE_CONFIG_DIR must be absent rather than pointed at ~/.claude
// (Claude keeps ~/.claude.json outside the folder in that case).
export function accountEnv(account, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_CONFIG_DIR') delete env[key];
  }
  delete env.ANTHROPIC_API_KEY; // would silently bill every account to one key
  if (!account.isDefault) env.CLAUDE_CONFIG_DIR = account.configDir;
  Object.assign(env, account.env || {}, extra);
  return env;
}

function quoteWin(arg) {
  if (arg === '') return '""';
  if (!/[\s"&|<>^%]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function spawnProc(bin, args, opts) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(bin)) {
    return spawn(quoteWin(bin), args.map(quoteWin), { ...opts, shell: true, windowsHide: true });
  }
  return spawn(bin, args, { ...opts, windowsHide: true });
}

export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}

// Runs one headless turn. The prompt goes over stdin so long, multi-line notes
// never touch command-line quoting.
export function runTurn({ args, cwd, env, prompt, onMessage }) {
  const child = spawnProc(resolveClaude(), args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { msg = { type: 'raw', text: line }; }
    try { onMessage(msg); } catch (err) { console.error('[ballast] onMessage failed', err); }
  });
  const linesDone = new Promise((res) => rl.on('close', res));

  const done = new Promise((resolve) => {
    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      resolve({ code: -1, stderr: `${err.message}\n${stderr}` });
    });
    child.on('close', async (code) => {
      if (settled) return;
      settled = true;
      await linesDone;
      resolve({ code, stderr });
    });
  });
  return { child, done };
}

export function authStatus(account) {
  return new Promise((resolve) => {
    const bin = resolveClaude();
    const run = IS_WIN && /\.(cmd|bat)$/i.test(bin)
      ? (cb) => execFile('cmd.exe', ['/d', '/c', bin, 'auth', 'status', '--json'], { env: accountEnv(account), windowsHide: true, timeout: 30000 }, cb)
      : (cb) => execFile(bin, ['auth', 'status', '--json'], { env: accountEnv(account), windowsHide: true, timeout: 30000 }, cb);
    run((err, stdout) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ loggedIn: false, error: err?.message || 'Could not read auth status' });
      }
    });
  });
}

// Opens a real terminal window running `commandArgs` for the account (Windows/macOS).
// Returns the equivalent shell command so the UI can show it as a fallback.
export function openTerminal({ account, cwd, commandArgs, title }) {
  const bin = resolveClaude();
  const cwdDir = cwd || os.homedir();
  const envLine = account.isDefault ? null : account.configDir;

  if (IS_WIN) {
    const script = path.join(paths.tmp, `${uid('term')}.cmd`);
    const lines = [
      '@echo off',
      `title ${title.replace(/[&|<>^]/g, '')}`,
      envLine ? `set "CLAUDE_CONFIG_DIR=${envLine}"` : 'set "CLAUDE_CONFIG_DIR="',
      'set "ANTHROPIC_API_KEY="',
      `cd /d "${cwdDir}"`,
      `"${bin}" ${commandArgs.map(quoteWin).join(' ')}`,
      'echo.',
      'echo [Ballast] Finished. You can close this window.',
      'pause >nul',
    ];
    fs.writeFileSync(script, lines.join('\r\n'));
    spawn('cmd.exe', ['/d', '/c', `start "" "${script}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
    return { opened: true, command: `set CLAUDE_CONFIG_DIR=${envLine || ''} && "${bin}" ${commandArgs.join(' ')}` };
  }

  const shellCmd = `${envLine ? `CLAUDE_CONFIG_DIR='${envLine}' ` : 'unset CLAUDE_CONFIG_DIR; '}cd '${cwdDir}' && '${bin}' ${commandArgs.join(' ')}`;
  if (process.platform === 'darwin') {
    const osa = `tell application "Terminal" to do script ${JSON.stringify(shellCmd)}`;
    spawn('osascript', ['-e', osa, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
    return { opened: true, command: shellCmd };
  }
  return { opened: false, command: shellCmd };
}
