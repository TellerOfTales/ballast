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
  cloud: path.join(HOME, 'cloud'),
  clones: path.join(HOME, 'clones'), // GitHub repos of cloud-run games
  targets: path.join(HOME, 'targets'), // quality target images per game
  assets: path.join(HOME, 'assets'), // per-game asset index (file scan + AI catalog)
  studioAttachments: path.join(HOME, 'studio', 'attachments'),
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
    limitRefreshMin: 30, // probe idle accounts this often so limits stay current (0 = off)
    limitGuardPct: 95, // autopilot leaves an account alone above this usage
    cloudSyncMin: 10, // claude.ai artifact sync interval (0 = manual only)
    contentRefreshMin: 60, // re-read an artifact updated today at most this often
    syncModel: 'haiku',
    triageModel: 'sonnet', // splits notes into tasks for cloud-run games
    cloudTaskTimeoutMin: 240, // a cloud session with no report after this is marked blocked
    desktopArtifacts: true, // let sync runs load the CLI's Artifact tools (see cloud.mjs)
    reviewers: '', // comma list; when set, only these comment authors are routed to agents
    // Director review per discipline: skip ("not my field"), after (never blocks), gate (approve first).
    review: { gameplay: 'after', art: 'after', audio: 'after', backend: 'skip', other: 'after' },
    reviewAutoApproveHours: 24, // gated work nobody looked at is approved after this (0 = never)
    deliveryHeadsUpMin: 45, // tell the team this long before each check-in build
    deptNoteFallbackMin: 15, // a department note nobody picks up is broken down by Ballast after this (0 = never)
    workHours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }, // when the director is working (0 = Sunday)
    usageReportMin: 90, // every account reports its limits this often during working hours (0 = off)
    subagentLimit: 4, // subagents (in-chat helpers) one agent may run at once (0 = no limit); games can override
    delegateLimit: 3, // delegate chats one agent may have open at once (0 = none); games can override
    delegateDepth: 2, // how many levels deep delegate chats may open their own delegates
    reportWebhook: '', // Slack/Discord webhook that also gets each usage report
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
  cloudArtifacts: [], // claude.ai artifacts tracked per game
  cloudIndex: {}, // accountId -> last artifact listing, for discovery
  inbox: [], // Director's Inbox: questions agents asked without stopping
  deptNotes: [], // notes left for a whole department, tracked until their tasks are done
  targets: [], // quality targets: reference images per department
  usageReports: [], // periodic session/weekly limit reports, newest last
  audits: [], // Bartle audits: the audiences each game serves and how to market it to them
  devices: [], // phones paired to Ballast (hashed keys; revocable)
};

function load() {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(paths.state, 'utf8').replace(/^﻿/, '')); // tolerate hand edits saved with a BOM
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
export const usageFile = path.join(HOME, 'usage.jsonl');
