// Daily check-ins: build the integration line, collect the output, share it, and
// post a changelog to the game feed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db, save, uid, paths } from './store.mjs';
import { changed } from './bus.mjs';
import * as git from './git.mjs';
import { feedPost, getGame, checkLimits, requestCheckinReport, probeAccount, isAccountBusy } from './orchestrator.mjs';
import { killTree } from './claude.mjs';
import { syncAccount, isSyncing } from './cloud.mjs';
import { poll as pollCloudSessions } from './remote.mjs';
import { autoApproveTick } from './review.mjs';

const running = new Map(); // gameId -> child process
const SLOT_WINDOW_MS = 90 * 60e3; // a missed check-in still fires if Ballast starts within 90 min

const stamp = (d = new Date()) => d.toISOString().slice(0, 16).replace(/[:T]/g, '-');

function runShell(command, { cwd, env, logFile, timeoutMin, gameId }) {
  return new Promise((resolve) => {
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    log.write(`$ ${command}\n(cwd ${cwd})\n\n`);
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true });
    running.set(gameId, child);
    const timer = setTimeout(() => {
      log.write(`\n[ballast] Timed out after ${timeoutMin} min.\n`);
      killTree(child);
    }, timeoutMin * 60e3);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const finish = (code) => {
      clearTimeout(timer);
      running.delete(gameId);
      log.end(`\n[ballast] exit code ${code}\n`, () => resolve(code));
    };
    child.on('error', (err) => { log.write(`\n[ballast] ${err.message}\n`); finish(-1); });
    child.on('close', finish);
  });
}

async function share(game, build, text) {
  if (!game.build.webhookUrl) return;
  try {
    // Slack reads `text`, Discord reads `content`; each ignores the other.
    await fetch(game.build.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, content: text.slice(0, 1900) }),
    });
  } catch (err) {
    build.shareError = err.message;
  }
}

export async function runBuild(gameId, reason = 'manual', slot = null) {
  const game = getGame(gameId);
  if (!game) throw Object.assign(new Error('Unknown game'), { status: 400 });
  if (running.has(gameId) || db.builds.some((b) => b.gameId === gameId && b.status === 'running')) {
    throw Object.assign(new Error('A build is already running for this game.'), { status: 400 });
  }

  const build = { id: uid('b'), gameId, reason, slot, status: 'running', startedAt: Date.now() };
  const dir = path.join(paths.builds, gameId, build.id);
  const outDir = path.join(dir, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  build.logFile = path.join(dir, 'build.log');
  build.outDir = outDir;
  db.builds.push(build);
  save();
  changed();

  const previous = db.builds.filter((b) => b.gameId === gameId && b.id !== build.id && b.commit).at(-1);
  try {
    let cwd = game.repoPath;
    if (game.isolation === 'worktree') cwd = await git.prepareBuildWorktree(game.repoPath, game.integrationBranch);
    // Cloud games build what has been merged on GitHub, in Ballast's own clone.
    if (game.runner === 'cloud') {
      await git.syncClone(cwd, game.baseBranch);
      if (game.subdir) cwd = path.join(cwd, game.subdir);
    }
    build.cwd = cwd;
    build.commit = await git.head(cwd).catch(() => null);
    if (previous?.commit && build.commit && previous.commit !== build.commit) build.changelog = await git.log(cwd, previous.commit, build.commit);
    const since = previous?.startedAt || Date.now() - 24 * 3600e3;
    build.tasksDone = db.tasks.filter((t) => t.gameId === gameId && t.status === 'done' && (t.doneAt || 0) > since).map((t) => `#${t.num} ${t.title}`);

    if (game.build.command) {
      const code = await runShell(game.build.command, {
        cwd,
        logFile: build.logFile,
        timeoutMin: game.build.timeoutMin || 120,
        gameId,
        env: { ...process.env, BALLAST_BUILD_ID: build.id, BALLAST_OUTPUT_DIR: outDir, BALLAST_COMMIT: build.commit || '', BALLAST_GAME: game.name },
      });
      build.status = code === 0 ? 'success' : 'failed';
      build.exitCode = code;
    } else {
      fs.writeFileSync(build.logFile, 'No build command set; this check-in only records changes.\n');
      build.status = 'checkin';
    }

    if (build.status === 'success' && game.build.outputPath) {
      const src = path.resolve(cwd, game.build.outputPath);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(outDir, path.basename(src)), { recursive: true });
      else build.warning = `Output path not found: ${src}`;
    }
    build.files = fs.existsSync(outDir) ? fs.readdirSync(outDir) : [];
    if (build.status === 'success' && game.build.shareDir && build.files.length) {
      const dest = path.join(game.build.shareDir, game.slug, `${stamp()}${build.commit ? `-${build.commit}` : ''}`);
      fs.cpSync(outDir, dest, { recursive: true });
      build.sharedTo = dest;
    }
  } catch (err) {
    build.status = 'failed';
    build.error = err.message;
    fs.appendFileSync(build.logFile, `\n[ballast] ${err.stack || err.message}\n`);
  }
  build.finishedAt = Date.now();

  const mins = Math.max(1, Math.round((build.finishedAt - build.startedAt) / 60e3));
  const label = { success: 'Build ready', failed: 'Build failed', checkin: 'Check-in' }[build.status];
  const lines = [
    `${label}${slot ? ` (${slot} check-in)` : ''}: ${game.name}${build.commit ? ` @ ${build.commit}` : ''} · ${mins} min`,
    build.error && `Error: ${build.error}`,
    build.warning,
    build.sharedTo && `Shared to ${build.sharedTo}`,
    build.tasksDone?.length ? `Done since last build:\n${build.tasksDone.map((t) => `• ${t}`).join('\n')}` : 'No board tasks finished since the last build.',
    build.changelog && `Commits:\n${build.changelog}`,
  ].filter(Boolean);
  const text = lines.join('\n');
  await share(game, build, text);
  feedPost(gameId, { kind: 'build', buildId: build.id, status: build.status, text });
  save();
  changed();
  if (game.build.agentReport && reason === 'checkin') requestCheckinReport(gameId, build, slot);
  return build;
}

export function cancelBuild(gameId) {
  const child = running.get(gameId);
  if (child) killTree(child);
}

function todayAt(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

// One housekeeping run at a time: limit probes for idle accounts, then claude.ai syncs.
let housekeeping = false;
async function keepFresh() {
  if (housekeeping) return;
  housekeeping = true;
  try {
    const now = Date.now();
    const s = db.settings;
    const ready = db.accounts.filter((a) => a.loggedIn && !(a.limitedUntil > now));
    if (s.limitRefreshMin > 0) {
      for (const acct of ready) {
        const last = Math.max(acct.usage?.updatedAt || 0, acct.usage?.probedAt || 0);
        // Busy accounts report limits with every turn, so they never need a probe.
        if (!isAccountBusy(acct.id) && now - last > s.limitRefreshMin * 60e3) await probeAccount(acct.id).catch(() => {});
      }
    }
    if (s.cloudSyncMin > 0) {
      for (const acct of ready) {
        const tracked = db.cloudArtifacts.some((c) => c.accountId === acct.id);
        const every = (tracked ? s.cloudSyncMin : Math.max(60, s.cloudSyncMin)) * 60e3; // discovery-only: hourly
        if (!isSyncing(acct.id) && now - (acct.cloudSyncedAt || 0) > every) await syncAccount(acct.id).catch(() => {});
      }
    }
  } finally {
    housekeeping = false;
  }
}

let ticks = 0;
function tick() {
  checkLimits();
  keepFresh();
  if (ticks++ % 3 === 0) pollCloudSessions().catch(() => {}); // every 90s
  if (ticks % 10 === 0) autoApproveTick().catch(() => {}); // every 5 min
  const now = Date.now();
  for (const game of db.games) {
    if (game.status === 'paused') continue;
    const fired = (game.build.fired ||= {});
    for (const time of game.build.checkins || []) {
      const at = todayAt(time);
      const key = `${at.toDateString()} ${time}`;
      // Heads-up before each delivery, so the director (and the feed agents read) see what's landing.
      const lead = (db.settings.deliveryHeadsUpMin || 0) * 60e3;
      if (lead && !fired[`${key} heads-up`] && now >= at.getTime() - lead && now < at.getTime()) {
        fired[`${key} heads-up`] = true;
        save();
        const tasks = db.tasks.filter((t) => t.gameId === game.id);
        const inProgress = tasks.filter((t) => t.status === 'claimed').length;
        const waiting = tasks.filter((t) => t.review?.state === 'pending' && t.status === 'review').length;
        feedPost(game.id, { kind: 'system', text: `${time} build in ${Math.round((at.getTime() - now) / 60e3)} min. ${inProgress} task(s) in progress${waiting ? `, ${waiting} waiting for your approval (unapproved work won't be in this build)` : ''}. Agents are landing only finished work until then.` });
      }
      if (fired[key] || now < at.getTime() || now - at.getTime() > SLOT_WINDOW_MS) continue;
      fired[key] = true;
      save();
      runBuild(game.id, 'checkin', time).catch((err) => feedPost(game.id, { kind: 'error', text: `Check-in ${time} failed to start: ${err.message}` }));
    }
    // keep a week of history so the map doesn't grow forever
    for (const key of Object.keys(fired)) {
      const day = key.match(/^\w{3} \w{3} \d{2} \d{4}/)?.[0];
      if (!day || now - new Date(day).getTime() > 7 * 86400e3) delete fired[key];
    }
  }
}

export function startScheduler() {
  // Builds can't survive a restart; mark any left "running" as interrupted.
  for (const b of db.builds) if (b.status === 'running') Object.assign(b, { status: 'failed', error: 'Ballast restarted mid-build' });
  save();
  tick();
  return setInterval(tick, 30e3);
}
