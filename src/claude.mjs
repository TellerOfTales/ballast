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
  // Prompt cache lifetime for Ballast's runs (Claude Code's main conversation). Agent turns are often
  // minutes to hours apart and one-off runs of a kind repeat within the hour, so a 1-hour cache is read
  // back far more than a 5-minute one. On a subscription Claude Code already uses 1 hour, but drops to
  // 5 minutes once an account runs on usage credits; pinning it keeps Ballast's caches warm there too.
  // Settings → promptCacheTtl: '1h' (default), '5m', or 'auto' to leave it to Claude Code.
  const ttl = db.settings.promptCacheTtl || '1h';
  if (ttl === '1h' || ttl === '5m') env.CLAUDE_CODE_PROMPT_CACHE_TTL = ttl;
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

// An account whose claude.ai sign-in has lapsed (the refresh token expired): every run and cloud
// message fails the same way until it signs in again. Hooks (orchestrator) pause its agents.
export const isAuthError = (text) => /OAuth session expired|could not be refreshed|need a claude\.ai sign-in|Failed to authenticate|Please run \/login|Invalid API key|authentication_error|401 Unauthorized|token (?:has )?expired/i.test(String(text || ''));
export const authErrorHooks = [];
const authFailed = (account, text) => { if (account && isAuthError(text)) for (const h of authErrorHooks) { try { h(account, String(text).slice(0, 300)); } catch { /* a hook's problem */ } } };

// A short, tool-limited, throwaway run for Ballast's own housekeeping (limit probes,
// artifact syncs). --safe-mode skips plugins, skills and MCP servers, so it's cheap. `connectors`
// keeps the account's claude.ai connectors (e.g. Claude Docs) for the runs that need them; what the
// run may call is still limited by its --allowedTools.
export async function runQuick({ account, args, prompt, onMessage, env = {}, cwd = path.join(paths.tmp, 'quick'), connectors = false }) {
  fs.mkdirSync(cwd, { recursive: true });
  let result = null;
  const { done } = runTurn({
    args: ['-p', '--output-format', 'stream-json', '--verbose', ...(connectors ? [] : ['--safe-mode']), '--no-session-persistence', ...args],
    cwd,
    env: accountEnv(account, env),
    prompt,
    onMessage: (msg) => {
      if (msg.type === 'result') result = msg;
      onMessage?.(msg);
    },
  });
  const res = await done;
  if (result?.is_error) authFailed(account, result.result);
  else if (!result) authFailed(account, res.stderr);
  return { ...res, result };
}

// ---------------------------------------------------------------------------
// Cloud sessions (Claude Code on the web). The session clones `cwd`'s GitHub remote at
// its current branch, works there, and pushes a branch back.

function collect(args, { account, cwd, input, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawnProc(resolveClaude(), args, { cwd, env: accountEnv(account), stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    if (input != null) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, out: `${out}\n${err.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

// Session ids are tagged "cse_…" or "session_…"; accept a bare id or any claude.ai link holding one.
export function parseCloudSession(input) {
  const id = String(input || '').match(/\b(?:cse|session)_[\w-]+/)?.[0];
  return id ? { sessionId: id, url: `https://claude.ai/code/${id}` } : null;
}

// Creating a cloud session needs an interactive terminal (`claude --cloud` refuses to run
// headless), and the CLI keeps no local record of the session it made. So one terminal
// walks through the agents: create a session under each account, take the link it printed
// (read off the screen on Windows, pasted elsewhere) and write it to `outFile` for Ballast.
// steps: [{ account, label, intro, outFile }]
export function openCloudConnector({ cwd, steps, title }) {
  const bin = resolveClaude();
  // Windows: a PowerShell console reads the session link straight off its own screen after
  // `claude --cloud` prints it, so nothing needs pasting. (Creating a session needs a real
  // terminal; piping its output makes the CLI ignore --cloud.) Paste stays as a fallback.
  if (IS_WIN) {
    const id = uid('connect');
    const script = path.join(paths.tmp, `${id}.ps1`);
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const lines = [
      '$ErrorActionPreference = "Continue"',
      `$Host.UI.RawUI.WindowTitle = ${q(title)}`,
      `Set-Location -LiteralPath ${q(cwd)}`,
      'Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue',
      'function Get-Links {',
      '  try {',
      '    $raw = $Host.UI.RawUI; $w = $raw.BufferSize.Width; $bottom = $raw.CursorPosition.Y',
      '    $rect = New-Object System.Management.Automation.Host.Rectangle 0, ([Math]::Max(0, $bottom - 400)), ($w - 1), $bottom',
      '    $cells = $raw.GetBufferContents($rect); $sb = New-Object System.Text.StringBuilder',
      '    for ($y = 0; $y -le $cells.GetUpperBound(0); $y++) { for ($x = 0; $x -le $cells.GetUpperBound(1); $x++) { [void]$sb.Append($cells.GetValue($y, $x).Character) } }',
      "    return @([regex]::Matches($sb.ToString(), 'https://claude\\.ai/code/session_[A-Za-z0-9]+') | ForEach-Object { $_.Value })",
      '  } catch { return @() }',
      '}',
    ];
    steps.forEach((s, i) => {
      // PowerShell 5.1 mangles double quotes inside native arguments.
      const intro = s.intro.replace(/"/g, "'");
      lines.push(
        'Write-Host ""',
        `Write-Host ${q(`===== ${i + 1} of ${steps.length}: ${s.label} =====`)} -ForegroundColor Yellow`,
        s.account.isDefault ? 'Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue' : `$env:CLAUDE_CONFIG_DIR = ${q(s.account.configDir)}`,
        '$before = Get-Links',
        `& ${q(bin)} --cloud ${q(intro)}`,
        '$new = @(Get-Links | Where-Object { $before -notcontains $_ })',
        'if ($new.Count) { $link = $new[-1]; Write-Host "[Ballast] Connected: $link" -ForegroundColor Green }',
        'else { $link = Read-Host "Paste the View link printed above, then press Enter (Enter alone skips)" }',
        `if ($link) { Set-Content -LiteralPath ${q(s.outFile)} -Value $link }`,
      );
    });
    lines.push('Write-Host ""', 'Write-Host "[Ballast] All done. This window closes in 10 seconds." -ForegroundColor Green', 'Start-Sleep -Seconds 10');
    fs.writeFileSync(script, `﻿${lines.join('\r\n')}`); // BOM: PowerShell 5.1 reads BOM-less scripts as ANSI
    spawn('cmd.exe', ['/d', '/c', `start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${script}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
    return { opened: true };
  }
  const sh =(v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const script = path.join(paths.tmp, `${uid('connect')}.sh`);
  const lines = ['#!/bin/bash', `cd ${sh(cwd)}`, 'unset ANTHROPIC_API_KEY'];
  steps.forEach((s, i) => {
    lines.push(
      `echo; echo "===== ${i + 1} of ${steps.length}: ${s.label.replace(/["$`\\]/g, '')} ====="`,
      s.account.isDefault ? 'unset CLAUDE_CONFIG_DIR' : `export CLAUDE_CONFIG_DIR=${sh(s.account.configDir)}`,
      `${sh(bin)} --cloud ${sh(s.intro)}`,
      'read -r -p "Paste the View link printed above, then press Enter (Enter alone skips): " LINK',
      `[ -n "$LINK" ] && printf '%s\\n' "$LINK" > ${sh(s.outFile)}`,
    );
  });
  fs.writeFileSync(script, lines.join('\n'), { mode: 0o755 });
  if (process.platform === 'darwin') {
    spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(`bash ${sh(script)}`)}`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
    return { opened: true };
  }
  return { opened: false, command: `bash ${sh(script)}` };
}

// Documented: posts one message to the session and returns {ok, session_id, url} without waiting.
export async function sendCloudMessage({ account, cwd, sessionId, text }) {
  const { out } = await collect(['-p', '--output-format', 'json', '--cloud', sessionId], { account, cwd, input: text, timeoutMs: 90e3 });
  let res;
  try { res = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop()); } catch { /* fall through */ }
  if (!res?.ok) { const msg = res?.error || out.trim().slice(-300) || 'Message not delivered'; authFailed(account, msg); throw new Error(msg); }
  return res;
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
