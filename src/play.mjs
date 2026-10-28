// One-click play of a build: web builds open from a local play server, Windows builds run,
// Android builds install on a Quest over USB (adb), and any build can go to itch.io (butler).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { db, save } from './store.mjs';
import { changed } from './bus.mjs';

const IS_WIN = process.platform === 'win32';
let playPort = 0;

// What a build can be played as, from its collected output.
export function kinds(build) {
  const root = build?.outDir;
  if (!root || !fs.existsSync(root)) return {};
  const found = { web: null, apk: null, exe: null };
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile()) {
        if (!found.web && /^index\.html?$/i.test(e.name)) found.web = path.relative(root, dir).split(path.sep).join('/');
        if (!found.apk && /\.apk$/i.test(e.name)) found.apk = full;
        if (!found.exe && IS_WIN && /\.exe$/i.test(e.name) && !/unitycrashhandler|uninstall|setup|redist|vc_redist|crashpad/i.test(e.name)) found.exe = full;
      }
    }
    if (depth > 0) for (const e of entries) if (e.isDirectory() && !/^(node_modules|\.git)$/.test(e.name)) walk(path.join(dir, e.name), depth - 1);
  };
  walk(root, 4);
  return found;
}

// For the UI: cached per finished build, since state is sent on every change.
const cache = new Map();
export function playable(build) {
  if (build.status === 'running') return null;
  if (!cache.has(build.id)) {
    const k = kinds(build);
    cache.set(build.id, k.web != null || k.exe || k.apk ? { web: k.web != null, exe: k.exe ? path.basename(k.exe) : null, apk: k.apk ? path.basename(k.apk) : null } : null);
  }
  const p = cache.get(build.id);
  return p && { ...p, url: p.web ? playUrl(build) : null };
}

export const playUrl = (build) => {
  const k = kinds(build);
  return k.web != null && playPort ? `http://localhost:${playPort}/${build.id}/${k.web ? `${k.web}/` : ''}` : null;
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.pck': 'application/octet-stream', '.data': 'application/octet-stream',
  '.webmanifest': 'application/manifest+json', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

// Its own origin (localhost, a different site from Ballast's 127.0.0.1), so a game's code never
// shares Ballast's cookie. Cross-origin isolation headers let Godot and Unity threaded web
// builds use SharedArrayBuffer; localhost counts as secure, so WebXR works in a desktop browser.
export function init(basePort) {
  playPort = Number(process.env.BALLAST_PLAY_PORT) || basePort + 3;
  const srv = http.createServer((req, res) => {
    const host = String(req.headers.host || '');
    if (host !== `localhost:${playPort}` && host !== `127.0.0.1:${playPort}`) { res.writeHead(403); return res.end('Forbidden host'); }
    const parts = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).split('/').filter(Boolean);
    const build = db.builds.find((b) => b.id === parts[0]);
    if (!build?.outDir) { res.writeHead(404); return res.end('No such build'); }
    let file = path.resolve(build.outDir, ...parts.slice(1));
    if (!file.startsWith(path.resolve(build.outDir))) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    // Pre-compressed exports (Unity's .gz/.br) are served with the matching encoding.
    let encoding = null;
    let type = MIME[path.extname(file).toLowerCase()];
    const m = file.match(/^(.*?)(\.gz|\.br)$/i);
    if (m && fs.existsSync(file)) { encoding = m[2].toLowerCase() === '.gz' ? 'gzip' : 'br'; type = MIME[path.extname(m[1]).toLowerCase()]; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, {
        'content-type': type || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store',
        'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin',
        ...(encoding ? { 'content-encoding': encoding } : {}),
      });
      fs.createReadStream(file).pipe(res);
    });
  });
  srv.on('error', (err) => console.error(`[ballast] play server: ${err.message}`));
  srv.listen(playPort, '127.0.0.1');
}

const must = (v, msg) => { if (!v) throw Object.assign(new Error(msg), { status: 400 }); return v; };
const getBuild = (id) => must(db.builds.find((b) => b.id === id), 'Unknown build');

function exec(cmd, args, { timeout = 600e3, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code, out: `${stdout || ''}${stderr || ''}`.trim() });
    });
  });
}

export function run(id) {
  const b = getBuild(id);
  const exe = must(kinds(b).exe, 'This build has no Windows .exe to run.');
  spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' }).unref();
  return { ok: true, exe: path.basename(exe) };
}

// adb ships with Meta Quest Developer Hub and Android platform-tools.
const adb = () => db.settings.adbPath || 'adb';

export async function questInstall(id) {
  const b = getBuild(id);
  const apk = must(kinds(b).apk, 'This build has no .apk to install.');
  const devs = await exec(adb(), ['devices']);
  if (!devs.ok && /ENOENT|not recognized/i.test(devs.out + devs.code)) throw Object.assign(new Error('adb isn\'t installed. Install Meta Quest Developer Hub (or Android platform-tools) and try again, or set its path in Settings.'), { status: 400 });
  const connected = devs.out.split('\n').filter((l) => /\tdevice$/.test(l.trim()) || /\s+device$/.test(l));
  if (!connected.length) {
    const unauthorized = /unauthorized/.test(devs.out);
    throw Object.assign(new Error(unauthorized ? 'Your Quest is connected but hasn\'t allowed USB debugging yet: put the headset on and accept the prompt.' : 'No Quest found. Plug it in with USB, turn on Developer Mode, and allow USB debugging in the headset.'), { status: 400 });
  }
  b.quest = { status: 'installing', at: Date.now(), apk: path.basename(apk) };
  changed();
  exec(adb(), ['install', '-r', '-g', apk], { timeout: 900e3 }).then((r) => {
    b.quest = r.ok && /Success/i.test(r.out)
      ? { status: 'installed', at: Date.now(), apk: path.basename(apk) }
      : { status: 'failed', at: Date.now(), apk: path.basename(apk), error: r.out.split('\n').slice(-3).join(' ').slice(0, 300) || 'adb install failed' };
    save();
    changed();
  });
  return { started: true };
}

// game.itch = { target: "user/game" }; the channel follows the build type itch.io expects.
export async function itchPush(id, { kind } = {}) {
  const b = getBuild(id);
  const game = db.games.find((g) => g.id === b.gameId);
  const target = must(game?.itch?.target?.trim(), 'Set your itch.io page first (game Settings → Builds: itch.io page, like yourname/your-game).');
  const k = kinds(b);
  const pick = kind || (k.web != null ? 'web' : k.exe ? 'exe' : k.apk ? 'apk' : null);
  must(pick, 'Nothing in this build to upload.');
  const dir = pick === 'web' ? path.join(b.outDir, k.web || '') : path.dirname(pick === 'exe' ? k.exe : k.apk);
  const channel = { web: 'html5', exe: 'windows', apk: 'android' }[pick];
  const ver = await exec('butler', ['-V'], { timeout: 15e3 });
  if (!ver.ok) throw Object.assign(new Error('butler (itch.io\'s upload tool) isn\'t installed. Get it from itch.io/docs/butler, run "butler login" once, then try again.'), { status: 400 });
  b.itch = { status: 'uploading', channel, at: Date.now() };
  changed();
  exec('butler', ['push', dir, `${target}:${channel}`, '--userversion', b.commit || b.id], { timeout: 3600e3 }).then((r) => {
    b.itch = r.ok
      ? { status: 'uploaded', channel, at: Date.now(), url: `https://${target.split('/')[0]}.itch.io/${target.split('/')[1]}` }
      : { status: 'failed', channel, at: Date.now(), error: /login|credentials|api key/i.test(r.out) ? 'butler isn\'t logged in: run "butler login" once in a terminal.' : r.out.split('\n').slice(-3).join(' ').slice(0, 300) };
    save();
    changed();
  });
  return { started: true, channel };
}
