#!/usr/bin/env node
// Ballast: local web app that leashes several Claude Code accounts into one game team.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { db, save, flush, paths } from './store.mjs';
import { bus, changed } from './bus.mjs';
import * as orch from './orchestrator.mjs';
import { runBuild, cancelBuild, startScheduler } from './scheduler.mjs';
import { usageSummary } from './usage.mjs';
import * as cloud from './cloud.mjs';
import * as remote from './remote.mjs';
import * as review from './review.mjs';
import * as inbox from './inbox.mjs';
import * as deptnotes from './deptnotes.mjs';
import * as targets from './targets.mjs';
import * as assets from './assets.mjs';
import * as reports from './reports.mjs';
import * as whisper from './whisper.mjs';
import * as audits from './audits.mjs';
import * as setup from './setup.mjs';
import * as phone from './phone.mjs';
import * as digest from './digest.mjs';
import * as discord from './discord.mjs';
import * as play from './play.mjs';
import * as roadmap from './roadmap.mjs';
import * as askMode from './ask.mjs';
import * as threads from './threads.mjs';
import * as unblock from './unblock.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const argv = process.argv.slice(2);
const PORT = Number(process.env.BALLAST_PORT || argv.find((a) => /^\d+$/.test(a)) || 4477);
const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}:${PORT}`;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.cs': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary',
  '.webmanifest': 'application/manifest+json',
};

// ---------------------------------------------------------------------------
// Helpers

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': isJson ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req, limit = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// The phone pairing form posts application/x-www-form-urlencoded.
function readForm(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 4096) { req.destroy(); reject(Object.assign(new Error('Too large'), { status: 413 })); } });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(s))));
    req.on('error', reject);
  });
}

function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

const safeEqual = (a, b) => !!a && !!b && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function serveFile(res, root, rel, extraHeaders = {}) {
  const file = path.resolve(root, rel);
  if (!file.startsWith(path.resolve(root) + path.sep) && file !== path.resolve(root)) return send(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-store',
      ...extraHeaders,
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Routes

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

route('GET', '/api/state', () => orch.publicState());
route('PATCH', '/api/settings', (_, body) => {
  for (const key of ['claudePath', 'directorName', 'syncModel', 'triageModel', 'reviewers', 'adbPath']) if (body[key] !== undefined) db.settings[key] = String(body[key]).trim();
  if (body.cloudTaskTimeoutMin !== undefined) db.settings.cloudTaskTimeoutMin = Math.max(10, Number(body.cloudTaskTimeoutMin) || 240);
  if (body.desktopArtifacts !== undefined) db.settings.desktopArtifacts = !!body.desktopArtifacts;
  if (body.review) review.setStudioPolicy(body.review);
  if (body.reportWebhook !== undefined) db.settings.reportWebhook = String(body.reportWebhook).trim();
  if (body.workHours) {
    const t = (v, d) => (/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v).padStart(5, '0') : d);
    const days = (Array.isArray(body.workHours.days) ? body.workHours.days : []).map(Number).filter((n) => n >= 0 && n <= 6);
    db.settings.workHours = { start: t(body.workHours.start, '09:00'), end: t(body.workHours.end, '18:00'), days };
  }
  for (const key of ['reviewAutoApproveHours', 'deliveryHeadsUpMin', 'deptNoteFallbackMin', 'usageReportMin', 'subagentLimit', 'delegateLimit', 'delegateDepth']) if (body[key] !== undefined) db.settings[key] = Math.max(0, Number(body[key]) || 0);
  for (const key of ['maxConcurrentPerAccount', 'autopilotDailyTurns']) if (body[key] !== undefined) db.settings[key] = Math.max(1, Number(body[key]) || 1);
  for (const key of ['limitRefreshMin', 'cloudSyncMin', 'contentRefreshMin']) if (body[key] !== undefined) db.settings[key] = Math.max(0, Number(body[key]) || 0);
  if (body.limitGuardPct !== undefined) db.settings.limitGuardPct = Math.min(100, Math.max(1, Number(body.limitGuardPct) || 95));
  if (body.digestDaily !== undefined) db.settings.digestDaily = !!body.digestDaily;
  if (body.blockTriage !== undefined) db.settings.blockTriage = !!body.blockTriage;
  if (body.weeklyReport) {
    const day = body.weeklyReport.day === '' || body.weeklyReport.day == null ? null : Math.min(6, Math.max(0, Number(body.weeklyReport.day)));
    db.settings.weeklyReport = { day, time: /^([01]?\d|2[0-3]):[0-5]\d$/.test(body.weeklyReport.time || '') ? body.weeklyReport.time.padStart(5, '0') : '16:00' };
  }
  save();
  changed();
  orch.pump();
  return db.settings;
});

route('POST', '/api/accounts', (_, body) => orch.addAccount(body));
route('PATCH', '/api/accounts/:id', (p, body) => orch.updateAccount(p.id, body));
route('DELETE', '/api/accounts/:id', (p) => orch.removeAccount(p.id));
route('POST', '/api/accounts/:id/login', (p) => orch.loginAccount(p.id));
route('POST', '/api/accounts/:id/refresh', (p) => orch.refreshAccount(p.id));
route('POST', '/api/accounts/:id/probe', (p) => {
  orch.probeAccount(p.id).catch(() => {});
  return { started: true };
});
route('POST', '/api/accounts/:id/sync', (p) => {
  cloud.syncAccount(p.id, { force: true }).catch(() => {});
  return { started: true };
});

route('POST', '/api/usage/report', () => reports.report({ reason: 'manual' }));
route('GET', '/api/usage',(_, __, q) => usageSummary(Math.min(60, Math.max(1, Number(q.get('days')) || 14))));
route('POST', '/api/studio/notes', (_, body) => orch.studioNote(body));
route('POST', '/api/studio/attachments', (_, body) => orch.saveStudioAttachment(body));

route('POST', '/api/cloud', (_, body) => cloud.track(body));
route('PATCH', '/api/cloud/:id', (p, body) => cloud.updateTracked(p.id, body));
route('DELETE', '/api/cloud/:id', (p) => cloud.untrack(p.id));

route('POST', '/api/games', (_, body) => orch.createGame(body));
route('PATCH', '/api/games/:id', (p, body) => orch.updateGame(p.id, body));
route('DELETE', '/api/games/:id', (p) => orch.removeGame(p.id));
route('GET', '/api/games/:id/feed', (p, _, q) => orch.readFeed(p.id, Number(q.get('limit')) || 300));
route('POST', '/api/games/:id/notes', (p, body) => orch.postNote(p.id, body));
route('POST', '/api/games/:id/attachments', (p, body) => orch.saveAttachment(p.id, body));
route('POST', '/api/games/:id/agents', (p, body) => orch.addAgent(p.id, body));
route('POST', '/api/games/:id/tasks', (p, body) => orch.addTask(p.id, body));
route('POST', '/api/games/:id/wake', (p) => ({ woken: orch.wakeIdle(p.id, true) }));
route('POST', '/api/games/:id/survey', (p) => orch.surveyGame(p.id));
route('POST', '/api/games/:id/build', (p) => {
  runBuild(p.id, 'manual').catch((err) => orch.feedPost(p.id, { kind: 'error', text: `Build failed to start: ${err.message}` }));
  return { started: true };
});
route('POST', '/api/games/:id/build/cancel', (p) => cancelBuild(p.id));

route('PATCH', '/api/agents/:id', (p, body) => orch.updateAgent(p.id, body));
route('DELETE', '/api/agents/:id', (p) => orch.removeAgent(p.id));
route('GET', '/api/agents/:id/transcript', (p, _, q) => orch.readTranscript(p.id, Number(q.get('limit')) || 500));
route('POST', '/api/agents/:id/stop', (p) => orch.stopAgent(p.id));
route('POST', '/api/agents/:id/reset', (p) => orch.resetAgent(p.id));
route('POST', '/api/agents/:id/terminal', (p) => orch.openAgentTerminal(p.id));
route('GET', '/api/agents/:id/sessions', (p) => orch.listSessions(p.id));
route('POST', '/api/agents/:id/cloud', (p, body) => remote.connect(orch.getAgent(p.id), body.link));
route('POST', '/api/agents/:id/cloud/start', (p) => {
  const agent = orch.getAgent(p.id);
  return remote.openConnector(agent && orch.getGame(agent.gameId), agent ? [agent.id] : []);
});
route('POST', '/api/games/:id/cloud/connect', (p) => remote.openConnector(orch.getGame(p.id)));
route('POST', '/api/agents/:id/adopt', (p, body) => orch.adoptSession(p.id, body));

route('PATCH', '/api/tasks/:id', (p, body) => orch.updateTask(p.id, body));
route('DELETE', '/api/tasks/:id', (p) => orch.removeTask(p.id));
route('POST', '/api/tasks/:id/triage', (p) => { unblock.triage(p.id).catch(() => {}); return { started: true }; });
route('POST', '/api/interventions/:id/resolve', (p, body) => unblock.resolve(p.id, body));
route('POST', '/api/interventions/:id/dismiss', (p) => unblock.dismiss(p.id));
route('GET', '/api/tasks/:id/thread', (p) => threads.read(p.id));
route('POST', '/api/tasks/:id/thread', (p, body) => threads.discuss(p.id, body));
route('POST', '/api/tasks/:id/thread/propose', (p) => threads.propose(p.id));
route('POST', '/api/tasks/:id/thread/apply', (p, body) => threads.apply(p.id, body));
route('POST', '/api/tasks/:id/approve', (p) => review.approve(p.id));
route('POST', '/api/tasks/:id/changes', (p, body) => review.requestChanges(p.id, body.feedback));
route('POST', '/api/games/:id/approve-all', (p, body) => review.approveAll(p.id, body.discipline));
route('POST', '/api/games/:id/queue-earlier', (p) => review.queueEarlierWork(p.id));
route('GET', '/api/games/:id/assets', (p, _, q) => assets.search(p.id, { q: q.get('q') || '', category: q.get('category') || '', limit: q.get('limit') }));
route('POST', '/api/games/:id/assets/scan', async (p) => ({ catalog: await assets.scanCatalog(p.id), files: await assets.scanFiles(p.id) }));
route('POST', '/api/games/:id/targets', (p, body) => targets.add(p.id, body));
route('POST', '/api/games/:id/targets/share', (p) => targets.share(p.id));
route('PATCH', '/api/targets/:id', (p, body) => targets.update(p.id, body));
route('DELETE', '/api/targets/:id', (p) => targets.remove(p.id));
route('POST', '/api/games/:id/tidy-transcript', (p, body) => orch.tidyTranscript(p.id, body));
route('POST', '/api/games/:id/ask', (p, body) => askMode.ask(p.id, body));
route('POST', '/api/games/:id/ask/reset', (p) => askMode.reset(p.id));
route('GET', '/api/games/:id/roadmap', (p) => roadmap.publicRoadmap(orch.getGame(p.id)));
route('POST', '/api/games/:id/roadmap', (p, body) => roadmap.start(p.id, body));
route('PATCH', '/api/games/:id/roadmap', (p, body) => roadmap.update(p.id, body));
route('POST', '/api/builds/:id/run', (p) => play.run(p.id));
route('POST', '/api/builds/:id/quest', (p) => play.questInstall(p.id));
route('POST', '/api/builds/:id/itch', (p, body) => play.itchPush(p.id, body));
route('POST', '/api/digest', () => digest.digestNow());
route('POST', '/api/weekly', () => { digest.weeklyNow().catch((err) => console.error('[ballast] weekly', err)); return { started: true }; });
route('GET', '/api/discord', () => discord.info());
route('POST', '/api/discord', (_, body) => discord.connect(body));
route('GET', '/api/discord/channels', () => discord.channels());
route('PATCH', '/api/games/:id/playtest', (p, body) => discord.setChannels(p.id, body));
route('POST', '/api/games/:id/playtest/flush', (p) => discord.flushNow(p.id));
route('GET', '/api/phone', () => phone.info());
route('PATCH', '/api/phone', (_, body) => phone.update(body));
route('POST', '/api/phone/code', () => { phone.newCode(); return phone.info(); });
route('DELETE', '/api/phone/devices/:id', (p) => phone.revoke(p.id));
route('GET', '/api/setup', () => setup.check());
route('POST', '/api/setup', (_, body) => setup.finish(body));
route('POST', '/api/audits', (_, body) => audits.start(body));
route('DELETE', '/api/audits/:id', (p) => audits.remove(p.id));
route('GET', '/api/whisper', () => whisper.info());
route('POST', '/api/whisper/warm', () => whisper.warm());
// One spoken phrase from Director Review. The prompt primes Whisper with the game's own words
// and the line before, which is most of what makes names come out right.
route('POST', '/api/games/:id/transcribe', (p, body) => {
  const game = orch.getGame(p.id);
  const words = [...new Set(db.tasks.filter((t) => t.gameId === p.id).slice(-40).map((t) => t.title.replace(/^\s*\[[^\]]+\]\s*/, '').replace(/^Changes to #\d+:\s*/, '')))];
  const prompt = `${game?.name || 'Game'} playtest notes. ${words.join('. ')}. ${String(body.context || '').slice(-300)}`;
  return whisper.transcribe({ audio: body.audio, lang: body.lang, prompt });
});
route('POST', '/api/games/:id/dept-notes', (p, body) => deptnotes.add(p.id, body));
route('POST', '/api/dept-notes/:id/breakdown', (p) => deptnotes.breakDownNow(p.id));
route('DELETE', '/api/dept-notes/:id', (p) => deptnotes.remove(p.id));
route('POST', '/api/inbox/:id/answer', (p, body) => inbox.answer(p.id, body.answer));
route('POST', '/api/inbox/:id/dismiss', (p) => inbox.dismiss(p.id));
route('DELETE', '/api/artifacts/:id', (p) => orch.removeArtifact(p.id));
route('GET', '/api/builds/:id/log', (p) => {
  const b = db.builds.find((x) => x.id === p.id);
  if (!b?.logFile || !fs.existsSync(b.logFile)) return '';
  const text = fs.readFileSync(b.logFile, 'utf8');
  return text.length > 200_000 ? `…\n${text.slice(-200_000)}` : text;
});
route('POST', '/api/open-folder', (_, body) => {
  const target = String(body.path || '');
  if (!fs.existsSync(target)) throw Object.assign(new Error('Folder not found'), { status: 400 });
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [target], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Server

const sseClients = new Set();
bus.on('event', (ev) => {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of sseClients) res.write(data);
});

// `remote` is the phone listener (home network / Tailscale). It serves the same UI and API to
// paired devices only; agents and the PC's own sign-in stay on 127.0.0.1.
async function handle(req, res, remote = false) {
  try {
    // DNS-rebinding guard: only answer to our own host name. Phones reach us by IP, and pair.
    if (!remote && !ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, 'Forbidden host');
    const url = new URL(req.url, ORIGIN);
    let pathname = decodeURIComponent(url.pathname);

    if (remote) {
      if (/^\/(manifest\.webmanifest|favicon\.svg|logo\.svg|icon\.svg)$/.test(pathname)) return serveFile(res, PUBLIC, pathname.slice(1));
      if (pathname === '/pair') return phone.pairPage(req, res, req.method === 'POST' ? await readForm(req) : null);
      const keyed = keyedFile(req, pathname); // sandboxed artifact frames send no cookie
      if (keyed) return await routeRequest(req, res, url, keyed, true);
      const device = phone.deviceFor(cookie(req, 'ballast_device'));
      if (!device) {
        if (req.method === 'GET' && !pathname.startsWith('/api/') && pathname !== '/events') { res.writeHead(302, { location: '/pair' }); return res.end(); }
        return send(res, 401, { error: 'Pair this device from Ballast on your PC first.' });
      }
      if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'Cross-origin request refused' });
      if (pathname.startsWith('/agent-api/')) return send(res, 403, { error: 'Forbidden' });
      if (pathname === '/' || pathname === '/index.html') return serveFile(res, PUBLIC, 'index.html');
      if (/^\/(app\.js|style\.css)$/.test(pathname)) return serveFile(res, PUBLIC, pathname.slice(1));
      return await routeRequest(req, res, url, pathname);
    }

    // Agents talk to us with their own key.
    if (pathname.startsWith('/agent-api/')) {
      if (req.method !== 'POST' || !safeEqual(req.headers['x-ballast-key'], db.secrets.agentKey)) return send(res, 403, { error: 'Forbidden' });
      const body = await readBody(req);
      try {
        return send(res, 200, { result: await orch.agentApi(body.agentId, pathname.slice(11), body.args || {}) });
      } catch (err) {
        return send(res, 200, { error: err.message });
      }
    }

    // The UI page hands out the session cookie; SameSite=Strict keeps other sites out.
    if (pathname === '/' || pathname === '/index.html') {
      return serveFile(res, PUBLIC, 'index.html', {
        'set-cookie': `ballast=${db.secrets.uiToken}; HttpOnly; SameSite=Strict; Path=/`,
      });
    }
    if (/^\/(app\.js|style\.css|favicon\.svg|logo\.svg|manifest\.webmanifest)$/.test(pathname)) return serveFile(res, PUBLIC, pathname.slice(1));

    // Sandboxed artifact frames get no cookie, so file URLs can carry a read-only key in
    // the path instead (/f/<key>/...). In the path, relative links inside HTML artifacts keep it.
    const keyed = keyedFile(req, pathname);
    if (keyed) return await routeRequest(req, res, url, keyed, true);
    if (!safeEqual(cookie(req, 'ballast'), db.secrets.uiToken)) return send(res, 401, { error: 'Open Ballast from its own address to sign in.' });
    if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== ORIGIN && req.headers.origin !== `http://localhost:${PORT}`) {
      return send(res, 403, { error: 'Cross-origin request refused' });
    }
    return await routeRequest(req, res, url, pathname);
  } catch (err) {
    if (!err.status) console.error('[ballast]', err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.message });
  }
}

const keyedFile = (req, pathname) => {
  const keyed = pathname.match(/^\/f\/([^/]+)(\/.*)$/);
  return req.method === 'GET' && keyed && safeEqual(keyed[1], db.secrets.fileKey) ? `/files${keyed[2]}` : null;
};

// Everything past sign-in: live events, files and the JSON API.
async function routeRequest(req, res, url, pathname, fileRead = false) {
  {
    if (pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    // Artifacts are agent-written HTML: sandbox them so they can't act as the Ballast UI.
    const files = pathname.match(/^\/files\/(artifacts|builds|attachments|studio|cloud|targets)\/(.+)$/);
    if (fileRead && !files) return send(res, 404, 'Not found');
    if (files) {
      const roots = { attachments: paths.games, studio: paths.studioAttachments, cloud: paths.cloud, targets: paths.targets };
      const root = roots[files[1]] || paths[files[1]];
      const rel = files[1] === 'attachments' ? files[2].replace(/^([^/]+)\//, '$1/attachments/') : files[2];
      const download = url.searchParams.has('download') ? { 'content-disposition': `attachment; filename="${path.basename(rel)}"` } : {};
      return serveFile(res, root, rel, { 'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock', ...download });
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const out = await r.handler(m.groups || {}, body, url.searchParams);
      return send(res, 200, out ?? { ok: true });
    }
    send(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer((req, res) => handle(req, res));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`[ballast] Port ${PORT} is busy. Is Ballast already running? Try: node src/server.mjs ${PORT + 1}`);
  else console.error('[ballast]', err);
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  orch.runtime.baseUrl = ORIGIN;
  await orch.init();
  audits.init();
  phone.init(handle, PORT);
  digest.init();
  discord.init();
  play.init(PORT);
  roadmap.init();
  unblock.init();
  startScheduler();
  console.log(`\n  BALLAST  ${ORIGIN}\n  data     ${paths.state}\n`);
  if (!argv.includes('--no-open')) openBrowser(ORIGIN);
});

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
}

function shutdown() {
  orch.shutdown();
  whisper.stop();
  flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
