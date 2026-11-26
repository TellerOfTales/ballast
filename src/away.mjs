// Away mode: the director is sick or on vacation for set dates. While away, agents don't pick up work
// that waits on the director (gated reviews, playtests, decisions, sign-offs): it stays on the board.
// They hear that the director is away, and Ballast tops up each game's board with review-free
// improvement work (see daily.mjs): engine updates, asset quality within the current style, QA checks,
// headset simulations, performance and robustness.
import { db } from './store.mjs';
import * as review from './review.mjs';

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const REASONS = { sick: 'off sick', vacation: 'on vacation', away: 'away' };

// The away period in force today, if any ({ reason, from, to, note }; dates are YYYY-MM-DD, inclusive).
export function current(d = new Date()) {
  const a = db.settings.away;
  if (!a?.from || !a?.to) return null;
  const today = dayKey(d);
  return today >= a.from && today <= a.to ? a : null;
}
export const isAway = () => !!current();

const untilText = (a) => new Date(`${a.to}T12:00`).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

// Work that waits on the director: a gated review in its discipline, or a ticket that asks for their
// playtest, decision, approval or sign-off. While they're away it stays on the board for their return.
const DIRECTOR_WORDS = /\b(director|playtest|play-?test|sign[- ]?off|approv\w*|decid\w*|decision|your call|walkthrough|in the headset with)\b/i;
export function needsDirector(game, t) {
  const discipline = t.discipline || review.disciplineOf(t.title);
  return review.policyFor(game, discipline) === 'gate' || DIRECTOR_WORDS.test(t.title);
}

// What agents are told while the director is away (added to every hand-off).
export function note() {
  const a = current();
  if (!a) return '';
  return `[The director is ${REASONS[a.reason] || 'away'} until ${untilText(a)}${a.note ? ` (${a.note})` : ''}. They won't review, playtest or answer questions until then. Pick work you can finish and verify yourself: tests, QA and robot checks, headset and bot simulations, performance, asset quality within the current approved style, engine updates, robustness. Don't start anything that needs their decision, approval or a new creative direction; if a task turns out to need that, leave it with your assumption written down and move on. Keep asking questions in your report as usual, never wait for answers.]\n\n`;
}

export const describe = (a = db.settings.away) => (a?.from ? `${REASONS[a.reason] || 'away'} ${new Date(`${a.from}T12:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })} to ${new Date(`${a.to}T12:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : '');
export { dayKey };
