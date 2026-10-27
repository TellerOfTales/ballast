// Usage reports: during the director's working hours, every account reports its session (5h)
// and weekly (7d) limits plus today's tokens, on a fixed interval (90 minutes by default).
import { db, save } from './store.mjs';
import { changed } from './bus.mjs';
import * as orch from './orchestrator.mjs';
import { usageSummary } from './usage.mjs';

const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export function inWorkHours(d = new Date()) {
  const w = db.settings.workHours;
  if (!w?.start || !w?.end) return true;
  if (Array.isArray(w.days) && w.days.length && !w.days.includes(d.getDay())) return false;
  const t = hm(d);
  return w.start <= w.end ? t >= w.start && t < w.end : t >= w.start || t < w.end; // overnight shifts wrap
}

const win = (acct, key) => {
  const w = acct.usage?.windows?.[key];
  return w && w.utilization != null ? { pct: Math.round(w.utilization * 100), resetsAt: w.resetsAt ? w.resetsAt * 1000 : null } : null;
};

const until = (ms) => {
  if (!ms) return '';
  const m = Math.max(0, Math.round((ms - Date.now()) / 60e3));
  return m < 60 ? `${m}m` : m < 36 * 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};

let running = false;

export async function report({ reason = 'scheduled' } = {}) {
  if (running) return null;
  running = true;
  try {
    // Make every number current first: idle accounts get a quick limit check.
    for (const acct of db.accounts.filter((a) => a.loggedIn && !(a.limitedUntil > Date.now()))) {
      const fresh = Date.now() - Math.max(acct.usage?.updatedAt || 0, acct.usage?.probedAt || 0) < 10 * 60e3;
      if (!fresh && !orch.isAccountBusy(acct.id)) await orch.probeAccount(acct.id).catch(() => {});
    }
    const usage = usageSummary(14);
    const guard = db.settings.limitGuardPct || 95;
    const accounts = db.accounts.map((a) => {
      const session = win(a, 'five_hour');
      const weekly = win(a, 'seven_day');
      const today = usage.accounts?.[a.id]?.today;
      const top = Math.max(session?.pct || 0, weekly?.pct || 0);
      return {
        id: a.id,
        name: a.name,
        email: a.email || '',
        status: !a.loggedIn ? 'logged out' : a.limitedUntil > Date.now() ? 'out of usage' : top >= guard ? 'near limit' : 'ok',
        session,
        weekly,
        tokensToday: today?.tokens || 0,
        costToday: today?.cost || 0,
        checkedAt: a.usage?.updatedAt || null,
      };
    });
    const entry = { at: Date.now(), reason, accounts };
    db.usageReports.push(entry);
    if (db.usageReports.length > 300) db.usageReports.splice(0, db.usageReports.length - 300);
    save();
    changed();
    await share(entry);
    return entry;
  } finally {
    running = false;
  }
}

function text(entry) {
  const lines = entry.accounts.map((a) => {
    const s = a.session ? `session ${a.session.pct}% (resets in ${until(a.session.resetsAt)})` : 'session ?';
    const w = a.weekly ? `weekly ${a.weekly.pct}% (resets ${until(a.weekly.resetsAt)})` : 'weekly ?';
    const flag = a.status === 'ok' ? '' : ` [${a.status.toUpperCase()}]`;
    return `• ${a.name}${flag}: ${s}, ${w}, ${(a.tokensToday / 1000).toFixed(1)}k tokens today`;
  });
  const best = [...entry.accounts].filter((a) => a.status === 'ok' && a.weekly).sort((a, b) => a.weekly.pct - b.weekly.pct)[0];
  return `Ballast usage report ${new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}\n${lines.join('\n')}${best ? `\nMost headroom: ${best.name}` : ''}`;
}

async function share(entry) {
  const url = db.settings.reportWebhook?.trim();
  if (!url) return;
  const body = text(entry);
  try {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: body, content: body.slice(0, 1900) }) });
  } catch (err) {
    entry.shareError = err.message;
  }
}

// Scheduler hook: one report every usageReportMin during working hours. The first tick inside
// working hours reports right away when the last report is older than the interval.
export function tick() {
  const every = (db.settings.usageReportMin || 0) * 60e3;
  if (!every || running || !inWorkHours()) return;
  const last = db.usageReports.at(-1)?.at || 0;
  if (Date.now() - last >= every) report().catch(() => {});
}
