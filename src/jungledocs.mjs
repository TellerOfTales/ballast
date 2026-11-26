// Jungle Engine docs: Ballast is a companion to the engine, so it keeps a daily copy of the engine's
// docs site and works within it. The site (VitePress) publishes hashmap.json, one hash per page that
// changes whenever the page does, so a sync fetches only the guide pages that changed. Ballast keeps
// them as plain text under ~/.ballast/jungle-docs/ for its own runs (triage, GDD checks, audits,
// conversation mode, away work, local agents), tells cloud agents where the docs are and what changed
// lately, has Claude summarize each day's changes, and checks every Jungle game against the ones that
// matter, adding tickets where a game's code is affected.
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { db, save, HOME } from './store.mjs';
import { changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import * as pace from './pace.mjs';
import { recordUsage } from './usage.mjs';
import * as git from './git.mjs';

export const SITE = 'https://thecompanylive.github.io/jungle-engine';
export const DIR = path.join(HOME, 'jungle-docs');
const PAGES = path.join(DIR, 'pages');
const HOUR = 3600e3;
const state = () => (db.jungleDocs ||= { changes: [] });
const must = (v, msg, status = 400) => { if (!v) throw Object.assign(new Error(msg), { status }); return v; };

// Guide pages only (API guide, Game Pack guide, getting started, release, playtest, changelog): the
// 3,000 generated API reference pages are read on the site when needed.
const wanted = (key) => !key.startsWith('fr_') && !key.startsWith('reference');
const urlOf = (key) => {
  const p = key.replace(/\.md$/, '').split('_').join('/');
  return `${SITE}/${p === 'index' ? '' : p.replace(/(^|\/)index$/, '$1')}`;
};

function htmlToText(html) {
  const start = html.indexOf('class="vp-doc');
  const body = start < 0 ? html : html.slice(html.indexOf('>', start) + 1, html.indexOf('</main>', start) > 0 ? html.indexOf('</main>', start) : undefined);
  const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  return decode(body
    .replace(/<(script|style|svg|button)[\s\S]*?<\/\1>/gi, '')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => `\n\`\`\`\n${code.replace(/<[^>]+>/g, '')}\n\`\`\`\n`)
    .replace(/<a class="header-anchor"[\s\S]*?<\/a>/gi, '')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<\/(h[1-6]|p|div|tr|li|table|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<td[^>]*>/gi, ' | ')
    .replace(/<code[^>]*>/gi, '`').replace(/<\/code>/gi, '`')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .split('\n').map((l) => l.replace(/[ \t]+$/g, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function get(url, json = false) {
  const r = await fetch(url, { headers: { 'user-agent': 'Ballast' }, signal: AbortSignal.timeout(20e3) });
  must(r.ok, `${url}: HTTP ${r.status}`, 502);
  return json ? r.json() : r.text();
}

function latestEngine() {
  return new Promise((resolve) => exec('npm view @thecompanylive/jungle-engine-client version --registry=https://npm.pkg.github.com', { timeout: 30e3, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim().split('\n').pop() || null)));
}

// Does this game run on Jungle Engine? (its repo depends on the engine's client package)
const jungleCache = new Map();
export function isJungle(game) {
  if (!game?.repoPath) return false;
  const hit = jungleCache.get(game.repoPath);
  if (hit && Date.now() - hit.at < HOUR) return hit.yes;
  let yes = !!game.jungle;
  try { const pkg = JSON.parse(fs.readFileSync(path.join(game.repoPath, 'package.json'), 'utf8')); yes ||= JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies }).includes('jungle-engine-client'); } catch { /* no package.json */ }
  jungleCache.set(game.repoPath, { at: Date.now(), yes });
  return yes;
}

// Paragraph-level changes between two copies of a page.
function diff(before, after) {
  const a = new Set(before.split('\n').map((l) => l.trim()).filter(Boolean));
  const b = after.split('\n').map((l) => l.trim()).filter(Boolean);
  const bs = new Set(b);
  return [...b.filter((l) => !a.has(l)).map((l) => `+ ${l}`), ...[...a].filter((l) => !bs.has(l)).map((l) => `- ${l}`)].join('\n');
}

// ---------------------------------------------------------------------------
// Sync

const SUMMARY_SCHEMA = {
  type: 'object',
  required: ['summary', 'items'],
  properties: {
    summary: { type: 'string', description: 'Two or three sentences for a game director: what changed in the engine and its guidance.' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'change', 'kind', 'actionable'],
        properties: {
          title: { type: 'string' },
          change: { type: 'string', description: 'What changed, concretely (APIs, rules, recommended patterns, versions).' },
          kind: { enum: ['release', 'rule', 'api', 'deprecation', 'feature', 'tooling', 'docs'] },
          actionable: { type: 'boolean', description: 'True when an existing game may need to change its code or setup because of this.' },
          whatToDo: { type: 'string', description: 'For actionable items: what a game should check or change.' },
        },
      },
    },
  },
};

const syncing = { on: false };

export async function sync({ force = false } = {}) {
  const st = state();
  if (syncing.on) return publicState();
  if (!force && st.lastSync && Date.now() - st.lastSync < 20 * HOUR) return publicState();
  syncing.on = true;
  changed();
  try {
    fs.mkdirSync(PAGES, { recursive: true });
    const hashes = await get(`${SITE}/hashmap.json`, true);
    const prevFile = path.join(DIR, 'hashmap.json');
    const prev = fs.existsSync(prevFile) ? JSON.parse(fs.readFileSync(prevFile, 'utf8')) : null;
    const keys = Object.keys(hashes).filter(wanted);
    const touched = keys.filter((k) => !prev || prev[k] !== hashes[k] || !fs.existsSync(path.join(PAGES, k)));
    const removed = prev ? Object.keys(prev).filter((k) => wanted(k) && !hashes[k]) : [];
    const pageChanges = [];
    for (let i = 0; i < touched.length; i += 6) {
      await Promise.all(touched.slice(i, i + 6).map(async (k) => {
        try {
          const text = htmlToText(await get(urlOf(k)));
          const file = path.join(PAGES, k);
          const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/^Source: .*\n\n/, '') : null;
          fs.writeFileSync(file, `Source: ${urlOf(k)}\n\n${text}`);
          if (prev) pageChanges.push({ key: k, url: urlOf(k), title: (text.match(/^# (.+)$/m)?.[1] || k).trim(), status: old == null ? 'new' : 'changed', diff: old == null ? text.slice(0, 2500) : diff(old, text) });
        } catch (err) { console.error('[ballast] jungle docs page', k, err.message); }
      }));
    }
    for (const k of removed) { fs.rmSync(path.join(PAGES, k), { force: true }); pageChanges.push({ key: k, url: urlOf(k), title: k, status: 'removed', diff: '' }); }
    fs.writeFileSync(prevFile, JSON.stringify(hashes));
    // An index the runs read first.
    const titles = keys.map((k) => { try { return { k, t: (fs.readFileSync(path.join(PAGES, k), 'utf8').match(/^# (.+)$/m)?.[1] || k).trim() }; } catch { return { k, t: k }; } });
    const groups = {};
    for (const { k, t } of titles) (groups[k.split('_')[0].replace(/\.md$/, '')] ||= []).push(`- ${t}: pages/${k} (${urlOf(k)})`);
    const engine = await latestEngine();
    fs.writeFileSync(path.join(DIR, 'INDEX.md'), `# Jungle Engine docs (synced ${new Date().toLocaleString()} from ${SITE})
Latest published engine release: ${engine || 'unknown'}. Release notes: pages/changelog.md. The generated API reference (every symbol) is on the site under ${SITE}/reference/.

${Object.entries(groups).map(([g, list]) => `## ${g}\n${list.join('\n')}`).join('\n\n')}
`);
    Object.assign(st, { lastSync: Date.now(), pages: keys.length, engine, error: null, references: Object.keys(hashes).filter((k) => k.startsWith('reference')).length });
    const real = pageChanges.filter((p) => p.status !== 'changed' || p.diff.trim());
    if (real.length) await summarize(real);
    return publicState();
  } catch (err) {
    st.error = err.message;
    st.lastSync = Date.now() - 18 * HOUR; // try again in about two hours
    return publicState();
  } finally {
    syncing.on = false;
    save();
    changed();
  }
}

function account() {
  return db.accounts.filter((a) => a.loggedIn && !(a.limitedUntil > Date.now()) && orch.utilization(a) * 100 < (db.settings.limitGuardPct || 95)).sort(pace.compareAccounts)[0] || null;
}

async function summarize(pages) {
  const st = state();
  const acct = account();
  const record = { at: Date.now(), pages: pages.map(({ key, url, title, status }) => ({ key, url, title, status })), summary: '', items: [] };
  if (acct) {
    let budget = 80000;
    const body = pages.map((p) => { const d = `### ${p.title} (${p.status}) ${p.url}\n${p.diff.slice(0, Math.max(0, Math.min(p.key === 'changelog.md' ? 30000 : 6000, budget)))}`; budget -= d.length; return d; }).join('\n\n');
    const { result } = await claude.runQuick({
      account: acct,
      args: ['--model', db.settings.reportModel || 'sonnet', '--tools', 'Read', '--permission-mode', 'dontAsk', '--json-schema', JSON.stringify(SUMMARY_SCHEMA)],
      prompt: `The Jungle Engine's docs site changed since yesterday. Below is each changed page with its changed paragraphs (+ added, - removed; new pages show their opening). Summarize what changed in the engine and its guidance for a team building games on it, and mark which changes an existing game may need to act on (a new release worth upgrading to, a new or changed rule, a renamed or removed API, a deprecated pattern, a better recommended way). Pure wording or typo fixes are docs with actionable false.

${body}`,
    });
    if (result) recordUsage({ account: acct, kind: 'jungle-docs', result });
    Object.assign(record, result?.structured_output || {});
  }
  st.changes = [...(st.changes || []), record].slice(-30);
  fs.writeFileSync(path.join(DIR, 'CHANGES.md'), `# Recent Jungle Engine docs changes\n\n${st.changes.slice().reverse().map((c) => `## ${new Date(c.at).toLocaleDateString()}\n${c.summary || ''}\n${(c.items || []).map((i) => `- ${i.title}${i.actionable ? ' (act on it)' : ''}: ${i.change}${i.whatToDo ? ` What to do: ${i.whatToDo}` : ''}`).join('\n') || c.pages.map((p) => `- ${p.title} (${p.status})`).join('\n')}`).join('\n\n')}\n`);
  for (const game of db.games.filter((g) => (g.status || 'active') === 'active' && isJungle(g))) {
    const acts = (record.items || []).filter((i) => i.actionable);
    orch.feedPost(game.id, { kind: 'system', text: `Jungle Engine docs changed: ${record.summary || record.pages.map((p) => p.title).join(', ')}${acts.length ? ` Checking ${game.name} against ${acts.length} change${acts.length > 1 ? 's' : ''} it may need to act on.` : ''}` });
    if (acts.length) await adapt(game, acts).catch((err) => console.error('[ballast] jungle docs adapt', game.name, err.message));
  }
}

const ADAPT_SCHEMA = {
  type: 'object',
  required: ['tasks', 'notes'],
  properties: {
    notes: { type: 'string', description: 'One or two sentences: which changes affect this game and which don\'t.' },
    tasks: { type: 'array', maxItems: 5, items: { type: 'object', required: ['title', 'detail'], properties: { title: { type: 'string', description: 'Starts with a department tag like [backend] or [gameplay].' }, detail: { type: 'string', description: 'What to change, which docs page says so, and how to check it.' } } } },
  },
};

// Checks one game's code against engine changes that may need action; tickets only where it's affected.
async function adapt(game, items, { intro = 'The engine\'s docs just changed in ways a game may need to act on:', max = 5 } = {}) {
  const acct = must(account(), 'No account free.');
  const board = db.tasks.filter((t) => t.gameId === game.id && t.status !== 'done').map((t) => `#${t.num} ${t.title}`).slice(-100).join('\n');
  const schema = { ...ADAPT_SCHEMA, properties: { ...ADAPT_SCHEMA.properties, tasks: { ...ADAPT_SCHEMA.properties.tasks, maxItems: max } } };
  const { result } = await claude.runQuick({
    account: acct,
    cwd: game.repoPath,
    args: ['--model', db.settings.reportModel || 'sonnet', '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', '--add-dir', DIR, '--json-schema', JSON.stringify(schema)],
    prompt: `"${game.name}" is a Jungle Engine game${game.subdir ? ` (its folder in this repo: ${game.subdir}/)` : ''}. ${intro}
${items.map((i) => `- ${i.title}: ${i.change}${i.whatToDo ? ` (${i.whatToDo})` : ''}`).join('\n')}

The full docs are in ${DIR} (INDEX.md first). Check this game's code and setup for each change. Add a task only where this game is actually affected (it uses the changed API or pattern, breaks the new rule, or the release brings something it needs), at most ${max}, naming the docs page. Don't repeat what's on the board:
${board || '(empty)'}`,
  });
  if (result) recordUsage({ account: acct, gameId: game.id, kind: 'jungle-docs', result });
  const out = result?.structured_output;
  if (!out) return;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const titles = new Set(db.tasks.filter((t) => t.gameId === game.id).map((t) => norm(t.title)));
  const added = [];
  for (const t of out.tasks || []) {
    if (!t.title?.trim() || titles.has(norm(t.title))) continue;
    titles.add(norm(t.title));
    added.push(orch.addTask(game.id, { title: t.title.trim().slice(0, 200), detail: `${t.detail}\n\nFrom a Jungle Engine docs change (${SITE}).`, createdBy: 'Jungle Engine docs' }).num);
  }
  orch.feedPost(game.id, { kind: 'task', from: 'Jungle Engine docs', text: `${out.notes}${added.length ? `\nAdded ${added.map((n) => `#${n}`).join(', ')}.` : '\nNothing to change here.'}` });
}

// ---------------------------------------------------------------------------
// Catch-up: a game whose code was written against an older engine is checked against every release
// since, from the changelog. The engine version installed (package-lock) can be newer than the one the
// code was checked against: an upgrade that only regenerates the lockfile changes nothing in the game.

const vnum = (v) => String(v || '').replace(/^[^\d]*/, '').split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
const vcmp = (a, b) => { const x = vnum(a); const y = vnum(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

export function installedEngine(game) {
  for (const dir of [game.subdir && path.join(game.repoPath, game.subdir), game.repoPath].filter(Boolean)) {
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
      const hit = Object.entries(lock.packages || {}).find(([k, v]) => /node_modules\/@(jungle\/engine-client|thecompanylive\/jungle-engine-client)$/.test(k) && v.version);
      if (hit) return hit[1].version;
    } catch { /* no lock here */ }
  }
  return null;
}

// Changelog sections for releases after `from`, up to `to`.
function changelogSince(from, to) {
  const file = path.join(PAGES, 'changelog.md');
  must(fs.existsSync(file), 'The Jungle Engine docs aren\'t synced yet.');
  // One block per package (# @jungle/engine-client, ...), each with its releases (## 0.43.0, ...).
  const out = [];
  for (const pkg of fs.readFileSync(file, 'utf8').split(/\n(?=# @)/).slice(1)) {
    const name = pkg.match(/^# (\S+)/)[1];
    for (const p of pkg.split(/\n(?=## \d+\.\d+\.\d+)/).slice(1)) {
      const v = p.match(/^## (\d+\.\d+\.\d+)/)[1];
      if (vcmp(v, from) > 0 && (!to || vcmp(v, to) <= 0)) out.push({ version: v, text: p.replace(/^## /, `## ${name} `) });
    }
  }
  return out;
}

const catching = { on: false };

export async function catchUp({ gameIds = null, from = null } = {}) {
  must(!catching.on, 'A catch-up check is already running.', 409);
  catching.on = true;
  const report = [];
  try {
    const games = db.games.filter((g) => (g.status || 'active') === 'active' && (!gameIds || gameIds.includes(g.id)));
    const groups = new Map();
    for (const game of games) {
      if (game.runner === 'cloud' && game.repoPath) await git.syncClone(game.repoPath, game.baseBranch).catch((err) => console.error('[ballast] catch-up sync', game.name, err.message));
      if (!isJungle(game)) continue;
      if (game.subdir && !fs.existsSync(path.join(game.repoPath, game.subdir))) { report.push({ game: game.name, skipped: `${game.subdir}/ isn't in the repo any more` }); continue; }
      const installed = installedEngine(game);
      const base = from || game.engineChecked || installed;
      if (!base) { report.push({ game: game.name, skipped: 'no engine version found' }); continue; }
      const key = `${base}..${installed || ''}`;
      if (!groups.has(key)) groups.set(key, { base, installed, games: [] });
      groups.get(key).games.push(game);
    }
    for (const { base, installed, games: list } of groups.values()) {
      const sections = changelogSince(base, installed);
      if (!sections.length) {
        for (const game of list) { game.engineChecked = installed || base; orch.feedPost(game.id, { kind: 'system', text: `Jungle Engine catch-up: ${game.name} is on ${installed || base} and has been checked against it. Nothing to catch up on.` }); report.push({ game: game.name, from: base, to: installed, releases: 0, added: [] }); }
        continue;
      }
      const acct = must(account(), 'No account free.');
      const releases = [...new Set(sections.map((s) => s.version))];
      let budget = 300000;
      const body = sections.map((s) => { const d = s.text.slice(0, Math.max(0, Math.min(20000, budget))); budget -= d.length; return d; }).join('\n\n');
      const { result } = await claude.runQuick({
        account: acct,
        args: ['--model', db.settings.reportModel || 'sonnet', '--tools', 'Read', '--permission-mode', 'dontAsk', '--json-schema', JSON.stringify(SUMMARY_SCHEMA)],
        prompt: `These games were built against Jungle Engine ${base}${installed && vcmp(installed, base) > 0 ? ` and now install ${installed}, but their code hasn't been checked against the releases in between` : ''}: ${list.map((g) => g.name).join(', ')}. Below are the engine's release notes for every release after ${base}${installed ? ` up to ${installed}` : ''}. Summarize what changed for a team building games on it, and mark which changes an existing game may need to act on (breaking changes, renamed or removed APIs, new rules or required setup, deprecated patterns, better recommended ways, fixes that games may have worked around). Merge related changes across releases into one item; pure internal or docs changes are actionable false.

${body}`,
      });
      if (result) recordUsage({ account: acct, kind: 'jungle-docs', result });
      const out = result?.structured_output || { summary: '', items: [] };
      const acts = (out.items || []).filter((i) => i.actionable);
      const range = `${base} → ${installed || releases[0]}`;
      for (const game of list) {
        orch.feedPost(game.id, { kind: 'system', text: `Jungle Engine catch-up (${range}, ${releases.length} releases): ${out.summary}${acts.length ? ` Checking ${game.name} against ${acts.length} change${acts.length > 1 ? 's' : ''} it may need to act on.` : ''}` });
        const before = new Set(db.tasks.filter((t) => t.gameId === game.id).map((t) => t.num));
        if (acts.length) await adapt(game, acts, { max: 8, intro: `Its code was written against engine ${base}; the repo now installs ${installed || 'a newer release'}, and nobody has checked the game against the releases in between. These changes since ${base} may need action:` }).catch((err) => console.error('[ballast] catch-up adapt', game.name, err.message));
        game.engineChecked = installed || base;
        report.push({ game: game.name, from: base, to: installed, releases: releases.length, actionable: acts.length, added: db.tasks.filter((t) => t.gameId === game.id && !before.has(t.num)).map((t) => `#${t.num} ${t.title}`) });
      }
    }
    return report;
  } finally {
    catching.on = false;
    save();
    changed();
  }
}

// ---------------------------------------------------------------------------
// What runs and agents get

// For Ballast's own Claude runs about a Jungle game: read access to the copy, and a line saying so.
export function forRun(game) {
  if (!isJungle(game) || !fs.existsSync(path.join(DIR, 'INDEX.md'))) return { args: [], text: '' };
  return { args: ['--add-dir', DIR], text: `\nThis is a Jungle Engine game. The engine's docs (copied daily from ${SITE}) are in ${DIR}: read INDEX.md, then the pages that apply. Work within the engine's framework, rules and recommended patterns; recent engine changes are in CHANGES.md.\n` };
}

// For agents' hand-offs: where the docs are and what changed lately (cloud agents read the site).
export function agentNote(game, { local = false } = {}) {
  if (!isJungle(game)) return '';
  const st = state();
  const recent = (st.changes || []).filter((c) => Date.now() - c.at < 7 * 24 * HOUR && c.summary);
  return `[Jungle Engine: build within the engine's framework and follow its docs (${local && fs.existsSync(DIR) ? `a copy is in ${DIR}, INDEX.md first; ` : ''}${SITE}). Check the relevant API guide page before using an engine system.${st.engine ? ` Latest engine release: ${st.engine}.` : ''}${recent.length ? ` Recent engine changes: ${recent.map((c) => c.summary).join(' ').slice(0, 900)}` : ''}]\n\n`;
}

export const publicState = () => {
  const st = state();
  return { lastSync: st.lastSync || null, pages: st.pages || 0, references: st.references || 0, engine: st.engine || null, error: st.error || null, syncing: syncing.on, changes: (st.changes || []).slice(-5).reverse().map((c) => ({ at: c.at, summary: c.summary, pages: c.pages.length, actionable: (c.items || []).filter((i) => i.actionable).length })) };
};

export function init() {
  setInterval(() => { if (db.settings.jungleDocs !== false) sync().catch(() => {}); }, HOUR).unref();
  setTimeout(() => { if (db.settings.jungleDocs !== false) sync().catch(() => {}); }, 45e3).unref();
}
