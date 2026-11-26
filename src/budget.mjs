// Budget tab: what development costs in account limits, per game. Cloud sessions don't report
// their tokens to Ballast, so the cost of a ticket is estimated from the accounts' own limit
// readings: each rise in an account's weekly use is split across the tickets that account was
// working at the time, by how long each was in hand. Rises with no ticket in hand are "off-ticket"
// (Ballast's own runs, or the account used by hand). Units are percent of one account's week.
import { db, usageFile, readJsonlTail } from './store.mjs';
import * as pace from './pace.mjs';
import * as perf from './perf.mjs';

const HOUR = 3600e3;
const WEEK = 7 * 24 * HOUR;
const ms = (t) => (!t ? null : t < 1e12 ? t * 1000 : t);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const tagOf = (t) => (String(t.title || '').match(/^\s*\[([^\]]+)\]/)?.[1] || '').toLowerCase().trim() || 'untagged';

// Weekly readings per account, oldest first: the periodic usage reports, the reading log and now.
function readings() {
  const by = new Map();
  const push = (id, ts, w, wr) => {
    if (w == null || !ts) return;
    if (!by.has(id)) by.set(id, []);
    by.get(id).push({ ts, w, wr: ms(wr) });
  };
  for (const rep of db.usageReports) for (const a of rep.accounts || []) if (a.weekly) push(a.id, a.checkedAt || rep.at, a.weekly.pct, a.weekly.resetsAt);
  for (const r of pace.readings()) push(r.accountId, r.ts, r.w, r.wr);
  for (const a of db.accounts) {
    const p = pace.accountPace(a);
    if (p.weekly) push(a.id, a.usage?.updatedAt || Date.now(), p.weekly.used, p.weekly.resetsAt);
  }
  for (const list of by.values()) {
    list.sort((a, b) => a.ts - b.ts);
    for (let i = list.length - 1; i > 0; i--) if (list[i].ts - list[i - 1].ts < 1000) list.splice(i - 1, 1);
  }
  return by;
}

// When each ticket was in an agent's hands, by account. `t.work` logs claims from now on; older
// tickets have only their last claim (claimedAt to doneAt).
function intervals() {
  const agents = new Map(db.agents.map((a) => [a.id, a]));
  const out = [];
  for (const t of db.tasks) {
    const work = t.work?.length ? t.work : t.claimedAt ? [{ a: t.doneBy || t.claimedBy, from: t.claimedAt }] : [];
    work.forEach((e, i) => {
      const agent = agents.get(e.a);
      if (!agent) return;
      const ends = [work[i + 1]?.from, t.doneAt, t.blockedAt].filter((x) => x && x > e.from);
      let to = ends.length ? Math.min(...ends) : t.status === 'claimed' && i === work.length - 1 ? Date.now() : t.updatedAt;
      if (!(to > e.from)) return;
      to = Math.min(to, e.from + 48 * HOUR); // held for days without a report isn't being worked
      out.push({ task: t, gameId: t.gameId, accountId: agent.accountId, from: e.from, to });
    });
  }
  return out;
}

// Was this ticket waiting on the board (open, nobody on it) at `ts`?
const openAt = (t, ts) => t.createdAt <= ts && !(t.doneAt && t.doneAt <= ts) && !((t.work?.[0]?.from || t.claimedAt || Infinity) <= ts);

let cache = null;
function model() {
  if (cache && Date.now() - cache.at < 30e3) return cache;
  const by = readings();
  const work = intervals();
  const cost = new Map(); // taskId -> % of a week
  const events = []; // { ts, gameId, taskId, amount }
  const offTicket = new Map(); // accountId -> %
  const idle = new Map(); // accountId -> hours behind pace with tickets waiting and nothing in hand
  const gamesOf = new Map(db.accounts.map((a) => [a.id, new Set(db.agents.filter((x) => x.accountId === a.id).map((x) => x.gameId))]));
  for (const [accountId, list] of by) {
    const mine = work.filter((w) => w.accountId === accountId);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1];
      const b = list[i];
      const reset = a.wr && b.wr && Math.abs(b.wr - a.wr) > HOUR;
      const d = reset ? b.w : Math.max(0, b.w - a.w);
      const live = mine.map((w) => ({ w, o: Math.min(w.to, b.ts) - Math.max(w.from, a.ts) })).filter((x) => x.o > 0);
      const total = sum(live.map((x) => x.o));
      if (d > 0) {
        if (total > 0) {
          for (const { w, o } of live) {
            const amount = (d * o) / total;
            cost.set(w.task.id, (cost.get(w.task.id) || 0) + amount);
            events.push({ ts: Math.max(w.from, a.ts) + o / 2, gameId: w.gameId, taskId: w.task.id, amount });
          }
        } else offTicket.set(accountId, (offTicket.get(accountId) || 0) + d);
      }
      // Idle with budget: nothing in hand, behind weekly pace, and a ticket waiting in one of its games.
      // Only short gaps count (readings are sparse overnight, when nothing is known).
      const gap = b.ts - a.ts;
      if (!total && gap <= 3 * HOUR && a.wr) {
        const elapsed = 100 * (1 - (a.wr - a.ts) / WEEK);
        const games = gamesOf.get(accountId) || new Set();
        const mid = a.ts + gap / 2;
        if (a.w < elapsed - 5 && db.tasks.some((t) => games.has(t.gameId) && openAt(t, mid))) idle.set(accountId, (idle.get(accountId) || 0) + gap / HOUR);
      }
    }
  }
  const since = Math.min(...[...by.values()].map((l) => l[0]?.ts || Date.now()));
  cache = { at: Date.now(), cost, events, offTicket, idle, since };
  return cache;
}

function direction(runs, name) {
  let up = 0;
  for (const r of runs) for (const b of r.budgets) if (b.name === name && b.limit != null && b.value !== b.limit) up += (b.value > b.limit) === b.pass ? 1 : -1;
  return up ? Math.sign(up) : /fps|rate/i.test(name) ? 1 : -1;
}

export function report(gameId, { days = 14 } = {}) {
  const game = db.games.find((g) => g.id === gameId);
  if (!game) throw Object.assign(new Error('Unknown game'), { status: 400 });
  const m = model();
  const now = Date.now();
  const from = Math.max(now - days * 24 * HOUR, m.since);
  const tasks = db.tasks.filter((t) => t.gameId === gameId);
  const costOf = (t) => m.cost.get(t.id) || 0;
  const events = m.events.filter((e) => e.gameId === gameId && e.ts >= from);

  // Accounts this game's agents use, with pace now and their idle/off-ticket figures for the period.
  const accountIds = [...new Set(db.agents.filter((a) => a.gameId === gameId && !a.retired).map((a) => a.accountId))];
  const accounts = accountIds.map((id) => db.accounts.find((a) => a.id === id)).filter(Boolean).map((a) => {
    const p = pace.accountPace(a);
    const agents = db.agents.filter((x) => x.accountId === a.id && x.gameId === gameId && !x.retired);
    return {
      id: a.id, name: a.name, pace: p, note: pace.describeWeekly(p),
      agents: agents.map((x) => ({ name: x.name, model: x.model || '' })),
      idleHours: round(m.idle.get(a.id) || 0), offTicket: round(m.offTicket.get(a.id) || 0),
    };
  }).sort((a, b) => b.pace.urgency - a.pace.urgency);

  // Spend per day and tickets done per day.
  const perDay = new Map();
  for (let t = from; t <= now + 1; t += 24 * HOUR) perDay.set(dayKey(t), { day: dayKey(t), spend: 0, done: 0 });
  for (const e of events) { const d = perDay.get(dayKey(e.ts)); if (d) d.spend += e.amount; }
  const doneTasks = tasks.filter((t) => t.status === 'done' && !t.cancelled && t.doneAt >= from);
  for (const t of doneTasks) { const d = perDay.get(dayKey(t.doneAt)); if (d) d.done++; }

  // Cost per ticket shipped, overall and by discipline (the ticket's [tag]).
  const priced = doneTasks.filter((t) => costOf(t) > 0);
  const disc = new Map();
  for (const t of doneTasks) {
    const k = tagOf(t);
    const d = disc.get(k) || { tag: k, done: 0, spend: 0, priced: 0 };
    d.done++; d.spend += costOf(t); if (costOf(t) > 0) d.priced++;
    disc.set(k, d);
  }

  // Work done again or thrown away, with what it cost.
  const group = (label, list, extra = {}) => ({ label, count: list.length, spend: round(sum(list.map(costOf)), 2), tickets: list.slice(-8).map((t) => ({ num: t.num, title: t.title, cost: round(costOf(t), 2) })), ...extra });
  const recent = (t) => (t.updatedAt || t.createdAt) >= from;
  const builds = (db.builds || []).filter((b) => b.gameId === gameId && (b.startedAt || 0) >= from);
  const waste = [
    group('Sent back in review', tasks.filter((t) => t.review?.state === 'changes' && recent(t))),
    group('Reopened by playtest feedback', tasks.filter((t) => t.feedbackCheck?.verdict === 'reopen' && recent(t))),
    group('Went blocked', tasks.filter((t) => (t.everBlocked || t.blockedAt || t.blockedMs || t.triage || t.status === 'blocked') && recent(t))),
    group('Cancelled', tasks.filter((t) => t.cancelled && recent(t))),
    ...(builds.length ? [{ label: 'Failed builds', count: builds.filter((b) => b.status === 'failed').length, spend: null, of: builds.length, tickets: [] }] : []),
  ];

  // Time lost waiting on people.
  const ivs = (db.interventions || []).filter((i) => i.gameId === gameId);
  const openIv = ivs.filter((i) => i.status === 'open');
  const solved = ivs.filter((i) => i.resolvedAt && i.resolvedAt >= from);
  const pending = tasks.filter((t) => t.review?.state === 'pending');
  const decided = tasks.filter((t) => t.review?.at && t.review.since && t.review.at >= from && t.review.state !== 'skipped');
  const blockedNow = tasks.filter((t) => t.status === 'blocked');
  const blockedHours = sum(tasks.map((t) => (t.blockedMs || 0) + (t.status === 'blocked' && t.blockedAt ? now - t.blockedAt : 0))) / HOUR;
  const waiting = {
    interventions: { open: openIv.length, oldestHours: openIv.length ? round(Math.max(...openIv.map((i) => (now - i.createdAt) / HOUR))) : null, solved: solved.length, medianHours: round(median(solved.map((i) => (i.resolvedAt - i.createdAt) / HOUR))) },
    reviews: { pending: pending.length, oldestHours: pending.length ? round(Math.max(...pending.map((t) => (now - (t.review.since || now)) / HOUR))) : null, decided: decided.length, medianHours: round(median(decided.map((t) => (t.review.at - t.review.since) / HOUR))) },
    blocked: { now: blockedNow.length, oldestHours: blockedNow.length ? round(Math.max(...blockedNow.map((t) => (now - (t.blockedAt || t.updatedAt)) / HOUR))) : null, hours: round(blockedHours) },
    idleHours: round(sum(accounts.map((a) => a.idleHours))),
  };

  // Results against spend: each profiler run against the one before, with the budget spent between them.
  const runs = perf.runs(gameId).filter((r) => !r.hidden);
  const results = runs.slice(1).map((b, i) => {
    const a = runs[i];
    const spend = sum(m.events.filter((e) => e.gameId === gameId && e.ts > a.at && e.ts <= b.at).map((e) => e.amount));
    const names = [...new Set([...a.budgets, ...b.budgets].map((x) => x.name))];
    const measures = names.map((name) => {
      const x = a.budgets.find((y) => y.name === name);
      const y = b.budgets.find((z) => z.name === name);
      const dir = direction(runs, name);
      const better = x && y && x.value !== y.value ? Math.sign(y.value - x.value) === dir : null;
      return { name, unit: (y || x).unit, before: x?.value ?? null, after: y?.value ?? null, pass: y ? y.pass : null, better };
    });
    return {
      from: { id: a.id, at: a.at, noteNum: a.noteNum, label: a.label }, to: { id: b.id, at: b.at, noteNum: b.noteNum, label: b.label },
      spend: round(spend, 1), landed: b.landed.length,
      passing: { before: a.budgets.filter((x) => x.pass).length, after: b.budgets.filter((x) => x.pass).length, of: b.budgets.length },
      improved: measures.filter((x) => x.better === true).length, worse: measures.filter((x) => x.better === false).length, measures,
    };
  });

  // Prompt cache: how much of what Ballast's own Claude runs sent (this game's, plus the housekeeping
  // that belongs to no game) was read from the cache. A drop after a change means something now alters
  // the start of the prompt. Cloud sessions run on claude.ai and report nothing here.
  const usageRuns = readJsonlTail(usageFile, 20000).filter((u) => u.ts >= from && (u.gameId === gameId || !u.gameId) && u.kind !== 'probe');
  const byKind = new Map();
  for (const u of usageRuns) {
    const k = `${u.gameId ? '' : 'housekeeping: '}${u.kind}`;
    const b = byKind.get(k) || { kind: k, runs: 0, read: 0, write: 0, fresh: 0 };
    b.runs++; b.read += u.cacheRead || 0; b.write += u.cacheWrite || 0; b.fresh += u.input || 0;
    byKind.set(k, b);
  }
  const share = (b) => (b.read + b.write + b.fresh ? b.read / (b.read + b.write + b.fresh) : null);
  const all = [...byKind.values()].reduce((a, b) => ({ runs: a.runs + b.runs, read: a.read + b.read, write: a.write + b.write, fresh: a.fresh + b.fresh }), { runs: 0, read: 0, write: 0, fresh: 0 });
  const cache = {
    runs: all.runs, read: all.read, write: all.write, fresh: all.fresh, hit: round(share(all) * 100),
    ttl: db.settings.promptCacheTtl || '1h',
    kinds: [...byKind.values()].map((b) => ({ ...b, hit: round(share(b) * 100) })).sort((a, b) => b.read + b.write + b.fresh - (a.read + a.write + a.fresh)),
  };

  const spend = sum(events.map((e) => e.amount));
  return {
    cache,
    from, days, since: m.since,
    accounts,
    spend: round(spend, 1),
    lastWeek: round(sum(events.filter((e) => e.ts >= now - WEEK).map((e) => e.amount)), 1),
    perDay: [...perDay.values()].map((d) => ({ ...d, spend: round(d.spend, 2) })),
    tickets: {
      done: doneTasks.length, priced: priced.length,
      median: round(median(priced.map(costOf)), 2), mean: priced.length ? round(sum(priced.map(costOf)) / priced.length, 2) : null,
      top: [...priced].sort((a, b) => costOf(b) - costOf(a)).slice(0, 5).map((t) => ({ num: t.num, title: t.title, cost: round(costOf(t), 2) })),
    },
    disciplines: [...disc.values()].map((d) => ({ ...d, spend: round(d.spend, 1), perTicket: d.priced ? round(d.spend / d.priced, 2) : null })).sort((a, b) => b.spend - a.spend),
    waste, waiting, results,
  };
}

// Cloud agents' work per game since the first limit reading, in % of one account's week (estimated
// from limit readings; cloud sessions don't report tokens).
export function spendByGame() {
  const m = model();
  const byGame = {};
  for (const e of m.events) if (e.gameId) byGame[e.gameId] = (byGame[e.gameId] || 0) + e.amount;
  return { since: Number.isFinite(m.since) ? m.since : null, byGame };
}
