// Pace: how far through each limit window an account is against how much of it has gone by.
// A weekly limit left unused at its reset is gone, so the account closest to a reset with budget
// left gets work first, and an account far ahead of pace is held back. Every reading of an
// account's limits is also logged (limits.jsonl) so the Budget tab can estimate what each ticket cost.
import path from 'node:path';
import { HOME, appendJsonl, readJsonlTail } from './store.mjs';

export const limitsFile = path.join(HOME, 'limits.jsonl');
const SESSION_MS = 5 * 3600e3;
export const WEEK_MS = 7 * 86400e3;
const ms = (t) => (!t ? null : t < 1e12 ? t * 1000 : t); // the CLI reports seconds

// The account's 7-day window that is furthest along (the all-model one or a per-model one).
function weeklyWindow(acct) {
  const w = acct?.usage?.windows || {};
  return Object.entries(w).filter(([k]) => k.startsWith('seven_day')).map(([, v]) => v).sort((a, b) => (b?.utilization || 0) - (a?.utilization || 0))[0] || null;
}

// { used, elapsed, ahead, resetsAt, hoursLeft, projected, leftAtReset } for one window, in percent.
export function windowPace(win, lengthMs, now = Date.now()) {
  if (!win) return null;
  const used = (win.utilization || 0) * 100;
  const resetsAt = ms(win.resetsAt || win.resets_at);
  if (!resetsAt) return { used, elapsed: null, ahead: null, resetsAt: null, hoursLeft: null, projected: null, leftAtReset: null };
  const left = Math.max(0, resetsAt - now);
  const elapsed = Math.min(100, Math.max(0, 100 * (1 - left / lengthMs)));
  // Too early in a window, a straight-line projection says nothing useful.
  const projected = elapsed >= 5 ? Math.min(999, (used / elapsed) * 100) : null;
  return {
    used, elapsed, ahead: used - elapsed, resetsAt, hoursLeft: left / 3600e3,
    projected, leftAtReset: projected == null ? null : Math.max(0, 100 - projected),
  };
}

export function accountPace(acct, now = Date.now()) {
  const session = windowPace(acct?.usage?.windows?.five_hour, SESSION_MS, now);
  const weekly = windowPace(weeklyWindow(acct), WEEK_MS, now);
  const headroom = weekly ? 100 - weekly.used : 0;
  // Weekly budget that has to be spent per remaining hour to use all of it: higher = more urgent.
  const urgency = weekly?.hoursLeft != null ? headroom / Math.max(0.5, weekly.hoursLeft) : 0;
  const expiring = !!(weekly?.hoursLeft != null && weekly.hoursLeft <= 24 && headroom >= 20);
  return { session, weekly, headroom, urgency, expiring, updatedAt: acct?.usage?.updatedAt || null };
}

// Points ahead of pace (negative = behind) for policy rules.
export function ahead(acct, metric) {
  const p = accountPace(acct);
  const w = metric === 'session-pace' ? p.session : p.weekly;
  return w?.ahead ?? 0;
}

// Scheduling order: most weekly budget to spend per remaining hour first, then lowest session use.
export function compareAccounts(a, b) {
  const pa = accountPace(a);
  const pb = accountPace(b);
  return pb.urgency - pa.urgency || (pa.session?.used || 0) - (pb.session?.used || 0);
}

// One line per account reading; skipped when nothing moved and the last line is recent.
const last = new Map();
export function logReading(acct) {
  const p = accountPace(acct);
  if (!p.weekly && !p.session) return;
  const row = {
    ts: Date.now(),
    accountId: acct.id,
    s: p.session ? Math.round(p.session.used * 10) / 10 : null,
    w: p.weekly ? Math.round(p.weekly.used * 10) / 10 : null,
    sr: p.session?.resetsAt || null,
    wr: p.weekly?.resetsAt || null,
  };
  const prev = last.get(acct.id);
  if (prev && prev.s === row.s && prev.w === row.w && prev.wr === row.wr && row.ts - prev.ts < 15 * 60e3) return;
  last.set(acct.id, row);
  appendJsonl(limitsFile, row);
}

export const readings = () => readJsonlTail(limitsFile, 50000, 16 * 1024 * 1024);

// "resets in 2h 10m" / "in 3d 4h"
export function until(at, now = Date.now()) {
  if (!at) return '?';
  const m = Math.max(0, Math.round((at - now) / 60e3));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

// "behind pace by 51 points, ~58% would go unused" for reports and the feed.
export function describeWeekly(p) {
  const w = p.weekly;
  if (!w || w.ahead == null) return '';
  const side = Math.abs(w.ahead) < 3 ? 'on pace' : `${Math.round(Math.abs(w.ahead))} points ${w.ahead > 0 ? 'ahead of' : 'behind'} pace`;
  const lost = w.leftAtReset >= 5 ? `, ~${Math.round(w.leftAtReset)}% would go unused at this rate` : '';
  return `${side}${lost}`;
}
