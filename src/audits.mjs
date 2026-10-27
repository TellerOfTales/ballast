// Bartle Audit: reads a game (repo, brief, board) and names the four Bartle subtypes it serves
// best, with how to market the IP to each. Author developers have no marketing team; this is it.
import path from 'node:path';
import { db, save, uid } from './store.mjs';
import { changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import { recordUsage } from './usage.mjs';

// Bartle's eight player types (Designing Virtual Worlds): each of the four classic types split
// into an explicit (deliberate) and an implicit (instinctive) subtype.
export const SUBTYPES = {
  Planner: { family: 'Achiever', gist: 'sets a goal and pursues it deliberately; long-term mastery, plans and completion' },
  Opportunist: { family: 'Achiever', gist: 'grabs whatever chance to win or progress turns up; quick wins, improvisation' },
  Scientist: { family: 'Explorer', gist: 'experiments methodically to learn how the systems work; theories, testing, depth' },
  Hacker: { family: 'Explorer', gist: 'pokes at the world intuitively for surprises, secrets, exploits and emergent play' },
  Networker: { family: 'Socialiser', gist: 'seeks out new people to meet and connect with; communities, lobbies, meeting strangers' },
  Friend: { family: 'Socialiser', gist: 'plays to spend time with people they already know; shared laughs, in-jokes, hanging out' },
  Politician: { family: 'Killer', gist: 'acts on other players with forethought; reputation, deception, alliances and influence' },
  Griefer: { family: 'Killer', gist: 'acts on other players for the immediate reaction; pranks, chaos, getting a rise' },
};
const NAMES = Object.keys(SUBTYPES);
const strs = { type: 'array', items: { type: 'string' } };

const SCHEMA = {
  type: 'object',
  required: ['summary', 'positioning', 'ranking', 'top', 'comparables', 'storeCopy', 'launchPlan', 'risks'],
  properties: {
    summary: { type: 'string', description: 'Who this game is for and why, in 2-3 sentences a solo developer can act on.' },
    positioning: { type: 'string', description: 'One-line positioning for the IP.' },
    ranking: { type: 'array', description: 'All eight subtypes, best fit first.', items: { type: 'object', required: ['subtype', 'fit'], properties: { subtype: { enum: NAMES }, fit: { type: 'integer', minimum: 0, maximum: 100 } } } },
    top: {
      type: 'array', minItems: 4, maxItems: 4, description: 'The four best-fit subtypes, best first.',
      items: {
        type: 'object',
        required: ['subtype', 'fit', 'why', 'evidence', 'gaps', 'pitch', 'channels', 'content', 'say', 'avoid'],
        properties: {
          subtype: { enum: NAMES },
          fit: { type: 'integer', minimum: 0, maximum: 100 },
          why: { type: 'string', description: 'What in this game serves them, in player-facing terms.' },
          evidence: { ...strs, description: 'Concrete features, mechanics or moments from the repo/brief/board that back this up.' },
          gaps: { ...strs, description: 'What they would want that the game lacks or underplays; design or content to add.' },
          pitch: { type: 'string', description: 'A one-sentence pitch written for this subtype.' },
          channels: { ...strs, description: 'Where to find them: platforms, communities, creator types, events.' },
          content: { ...strs, description: 'Marketing content that lands with them: clip ideas, trailer beats, post formats, demo hooks.' },
          say: { ...strs, description: 'Messages and words that resonate.' },
          avoid: { ...strs, description: 'Messages that turn them off.' },
        },
      },
    },
    comparables: { ...strs, description: 'Comparable games these audiences already play, and what to borrow from how they were marketed.' },
    storeCopy: { type: 'string', description: 'A short store page description (under 120 words) aimed at the top two subtypes.' },
    launchPlan: { ...strs, description: 'Ordered steps a solo developer can run to reach these audiences, from now to launch.' },
    risks: { ...strs, description: 'Audience or positioning risks, e.g. features that attract one subtype but repel another.' },
  },
};

function prompt(game) {
  const tasks = db.tasks.filter((t) => t.gameId === game.id);
  const titles = (list) => list.slice(-60).map((t) => `- ${t.title}`).join('\n') || '(none)';
  const docs = db.cloudArtifacts.filter((c) => c.gameId === game.id).map((c) => `- ${c.title}${c.role ? ` (${c.role})` : ''}`).join('\n');
  return `Run a Bartle Audit of the game "${game.name}" for its solo developer (an author developer: one person making games entirely with AI, with no marketing team).

Bartle's eight player subtypes:
${NAMES.map((n) => `- ${n} (${SUBTYPES[n].family}): ${SUBTYPES[n].gist}`).join('\n')}

Work out which subtypes this game actually serves, from what is built and planned, not from the genre label. You are in the game's folder: read the README, any GDD or design docs, and skim the code layout and content to see the real mechanics, modes and social features. Keep it to what you need; don't read every file.

Then rank all eight subtypes and give the top four, each with evidence from the game, what they'd want added, and a concrete way to market this IP to them (channels, content, messaging). Be specific to this game and its platform; avoid generic marketing advice. Every channel and content idea should be something one person can do.

Game brief:
${game.brief?.trim().slice(0, 4000) || '(none)'}
${game.releases?.length ? `\nReleased: ${game.releases.map((r) => [r.version, r.platforms, r.url].filter(Boolean).join(' · ')).join('; ')}\n` : ''}
Finished board tasks (most recent):
${titles(tasks.filter((t) => t.status === 'done'))}

Open and in-progress tasks:
${titles(tasks.filter((t) => t.status !== 'done'))}
${docs ? `\nDesign documents tracked on claude.ai:\n${docs}\n` : ''}`;
}

const folderOf = (game) => (game.subdir ? path.join(game.repoPath, game.subdir) : game.repoPath);

async function run(audit) {
  const game = orch.getGame(audit.gameId);
  try {
    const acct = db.accounts.filter((a) => a.loggedIn && !(a.limitedUntil > Date.now())).sort((a, b) => orch.utilization(a) - orch.utilization(b))[0];
    if (!acct) throw new Error('No logged-in account has usage free right now.');
    audit.accountId = acct.id;
    changed();
    const { result } = await claude.runQuick({
      account: acct,
      cwd: folderOf(game),
      args: ['--model', audit.model, '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', 'Glob', 'Grep', '--json-schema', JSON.stringify(SCHEMA)],
      prompt: prompt(game),
    });
    if (result) recordUsage({ account: acct, gameId: game.id, kind: 'audit', result });
    const out = result?.structured_output;
    if (!out?.top?.length) throw new Error(result?.result?.slice(0, 300) || 'The audit returned nothing.');
    out.top = out.top.map((t) => ({ ...t, family: SUBTYPES[t.subtype]?.family || '' }));
    Object.assign(audit, { status: 'done', result: out, cost: result.total_cost_usd || 0 });
    orch.feedPost(game.id, { kind: 'system', text: `Bartle Audit: ${game.name} serves ${out.top.map((t) => `${t.subtype} (${t.fit})`).join(', ')}. ${out.positioning}` });
  } catch (err) {
    Object.assign(audit, { status: 'error', error: err.message });
  }
  audit.finishedAt = Date.now();
  save();
  changed();
}

export function start({ gameIds = [], model } = {}) {
  const games = gameIds.map((id) => orch.getGame(id)).filter(Boolean);
  if (!games.length) throw Object.assign(new Error('Pick at least one game.'), { status: 400 });
  const started = [];
  for (const game of games) {
    if (db.audits.some((a) => a.gameId === game.id && a.status === 'running')) continue;
    if (!game.repoPath) continue;
    const audit = { id: uid('aud'), kind: 'bartle', gameId: game.id, status: 'running', model: model || db.settings.auditModel || 'opus', startedAt: Date.now() };
    db.audits.push(audit);
    started.push(audit);
    run(audit);
  }
  // Keep the last few per game; older ones are superseded.
  const keep = new Set(db.games.flatMap((g) => db.audits.filter((a) => a.gameId === g.id).slice(-5).map((a) => a.id)));
  db.audits = db.audits.filter((a) => keep.has(a.id));
  save();
  changed();
  return { started: started.length };
}

export function remove(id) {
  db.audits = db.audits.filter((a) => a.id !== id);
  save();
  changed();
}

// Audits interrupted by a restart can't finish.
export function init() {
  for (const a of db.audits.filter((x) => x.status === 'running')) Object.assign(a, { status: 'error', error: 'Ballast restarted before the audit finished. Run it again.' });
}
