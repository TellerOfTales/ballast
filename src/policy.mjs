// Per-game usage policy. An author developer runs several games on the same few accounts, so
// each game gets a cap (how far into an account's limits it may go) and rules that change how
// its agents work as an account fills up: a cheaper model, one task at a time, no fan-out…
import { uid } from './store.mjs';

export const METRICS = { session: 'Session (5h)', weekly: 'Weekly (7d)', either: 'Session or weekly' };

export const ACTIONS = {
  'one-task': 'Claim one task at a time',
  'no-fanout': 'No delegate chats or subagents',
  'model-sonnet': 'Switch to Sonnet (agents on this PC)',
  'model-haiku': 'Switch to Haiku (agents on this PC)',
  'effort-low': 'Lower effort (agents on this PC)',
  instruct: 'Tell the agents…',
  'no-claims': 'Finish claimed tasks, claim nothing new',
  notify: 'Tell me (feed + report webhook)',
  stop: 'Stop work on this game',
};

const TIGHT = 'Usage is getting tight on this account. Prefer small, contained tasks; skip refactors, exploratory spikes and long test runs; keep reports short.';

// One-click rules; the starter set is a balanced way to stretch an account across a week.
export const PRESETS = [
  { metric: 'session', above: 60, action: 'one-task', starter: true },
  { metric: 'weekly', above: 70, action: 'model-sonnet', starter: true },
  { metric: 'weekly', above: 75, action: 'instruct', text: TIGHT, starter: true },
  { metric: 'session', above: 80, action: 'no-fanout', starter: true },
  { metric: 'weekly', above: 85, action: 'no-claims', starter: true },
  { metric: 'either', above: 90, action: 'notify', starter: true },
  { metric: 'weekly', above: 92, action: 'model-haiku' },
  { metric: 'weekly', above: 50, action: 'instruct', text: 'Another game shares this account. Work on the highest-value open tasks first and leave polish for later.' },
  { metric: 'session', above: 70, action: 'effort-low' },
  { metric: 'weekly', above: 80, action: 'stop' },
];

// Percent used, 0..100. "weekly" covers every 7-day window (all-model and per-model ones).
export function pct(acct, metric) {
  const w = acct?.usage?.windows || {};
  const session = (w.five_hour?.utilization || 0) * 100;
  const weekly = Math.max(0, ...Object.entries(w).filter(([k]) => k.startsWith('seven_day')).map(([, v]) => (v?.utilization || 0) * 100));
  return metric === 'session' ? session : metric === 'weekly' ? weekly : Math.max(session, weekly);
}

export function normalize(input = {}) {
  const cap = Number(input.cap);
  const rules = (Array.isArray(input.rules) ? input.rules : []).filter((r) => ACTIONS[r?.action]).map((r) => ({
    id: r.id || uid('rule'),
    metric: METRICS[r.metric] ? r.metric : 'either',
    above: Math.min(100, Math.max(1, Math.round(Number(r.above) || 80))),
    action: r.action,
    text: r.action === 'instruct' ? String(r.text || '').trim().slice(0, 600) : '',
    on: r.on !== false,
  })).filter((r) => r.action !== 'instruct' || r.text);
  return { cap: cap >= 1 && cap <= 100 ? Math.round(cap) : null, rules };
}

const met = (r, acct) => pct(acct, r.metric) >= r.above;

// Everything the game's policy says about work on this account right now.
export function effects(game, acct) {
  const p = game?.usagePolicy || {};
  const capHit = !!(p.cap && acct && pct(acct, 'either') >= p.cap);
  const rules = (p.rules || []).filter((r) => r.on && acct && met(r, acct));
  const has = (a) => rules.some((r) => r.action === a);
  return {
    capHit,
    stop: capHit || has('stop'),
    rules,
    oneTask: has('one-task'),
    noClaims: has('no-claims'),
    noFanout: has('no-fanout'),
    model: has('model-haiku') ? 'haiku' : has('model-sonnet') ? 'sonnet' : null,
    effort: has('effort-low') ? 'low' : null,
    instructions: rules.filter((r) => r.action === 'instruct').map((r) => r.text),
    notify: has('notify'),
  };
}

export const describe = (r) => `${METRICS[r.metric].replace(/ \(.+\)/, '').toLowerCase()} over ${r.above}% → ${r.action === 'instruct' ? `"${r.text.slice(0, 80)}${r.text.length > 80 ? '…' : ''}"` : ACTIONS[r.action].replace(/ \(.+\)/, '').toLowerCase()}`;

// What an agent is told while rules are in force (cloud and local alike).
export function promptNote(fx, acct) {
  const lines = [];
  if (fx.noFanout) lines.push("Don't open delegate chats or start subagents; do the work yourself.");
  if (fx.oneTask) lines.push('Take one task at a time.');
  lines.push(...fx.instructions);
  if (!lines.length) return '';
  return `[Usage rules for this game are in force: ${acct.name} is at ${Math.round(pct(acct, 'session'))}% of its session and ${Math.round(pct(acct, 'weekly'))}% of its weekly limit.]\n${lines.map((l) => `- ${l}`).join('\n')}\n\n`;
}
