// Persistence: one JSON state file plus append-only JSONL logs (feeds, transcripts).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const HOME = path.resolve(process.env.BALLAST_HOME || path.join(os.homedir(), '.ballast'));

export const paths = {
  state: path.join(HOME, 'state.json'),
  accounts: path.join(HOME, 'accounts'),
  games: path.join(HOME, 'games'),
  agents: path.join(HOME, 'agents'),
  artifacts: path.join(HOME, 'artifacts'),
  builds: path.join(HOME, 'builds'),
  tmp: path.join(HOME, 'tmp'),
};
for (const dir of Object.values(paths)) if (!dir.endsWith('.json')) fs.mkdirSync(dir, { recursive: true });

export const uid = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';

const DEFAULTS = {
  settings: {
    claudePath: '',
    maxConcurrentPerAccount: 2,
    directorName: 'Director',
    autopilotDailyTurns: 150,
  },
  secrets: {
    uiToken: crypto.randomBytes(24).toString('hex'),
    agentKey: crypto.randomBytes(24).toString('hex'),
    // Read-only key for /files URLs: sandboxed artifact iframes don't send the UI cookie.
    fileKey: crypto.randomBytes(24).toString('hex'),
  },
  accounts: [],
  games: [],
  agents: [],
  tasks: [],
  builds: [],
  artifacts: [],
};

function load() {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      const backup = `${paths.state}.corrupt-${Date.now()}`;
      fs.copyFileSync(paths.state, backup);
      console.error(`[ballast] state.json unreadable, backed up to ${backup}`);
    }
  }
  const merged = structuredClone(DEFAULTS);
  for (const key of Object.keys(DEFAULTS)) {
    if (data[key] === undefined) continue;
    merged[key] = Array.isArray(DEFAULTS[key]) ? data[key] : { ...DEFAULTS[key], ...data[key] };
  }
  return merged;
}

export const db = load();

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 150);
}

export function flush() {
  clearTimeout(saveTimer);
  const tmp = `${paths.state}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, paths.state);
}
flush();

export function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// Reads the last `limit` records without loading huge files fully.
export function readJsonlTail(file, limit = 300, maxBytes = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // first line is likely partial
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
    }
    return out.slice(-limit);
  } finally {
    fs.closeSync(fd);
  }
}

export const feedFile = (gameId) => path.join(paths.games, gameId, 'feed.jsonl');
export const transcriptFile = (agentId) => path.join(paths.agents, agentId, 'transcript.jsonl');
export const attachmentsDir = (gameId) => path.join(paths.games, gameId, 'attachments');
