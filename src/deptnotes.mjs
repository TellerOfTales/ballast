// Department notes: a note the director leaves for a whole department (Art, Audio, ...).
// NEW -> picked up by an agent working a task in that department -> broken into board tasks
// (TASKED, linked to them) -> ARCHIVED once every linked task is done.
// Nothing waits on a person: a note nobody picks up, or that's picked up but never broken
// down, is broken down by Ballast itself after a while.
import { db, save, uid } from './store.mjs';
import { changed } from './bus.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import { recordUsage } from './usage.mjs';
import { DISCIPLINES } from './review.mjs';

db.deptNotes ||= [];

const PICK_TTL = 45 * 60e3; // a picked-up note not broken down by then goes back to waiting
export const label = (d) => DISCIPLINES.find((x) => x.id === d)?.label || 'Other';
const tagFor = (d) => ({ gameplay: 'gameplay', art: 'art', audio: 'audio', backend: 'backend' })[d] || 'tech';
export const ref = (n) => `D${n.num}`;

function must(value, message) {
  if (!value) throw Object.assign(new Error(message), { status: 400 });
  return value;
}

export function add(gameId, { discipline, text = '', attachments = [] }) {
  const game = must(orch.getGame(gameId), 'Unknown game');
  must(DISCIPLINES.some((d) => d.id === discipline) || discipline === 'other', 'Pick a department.');
  must(String(text).trim(), 'Write the note first.');
  game.deptNoteSeq = (game.deptNoteSeq || 0) + 1;
  const note = {
    id: uid('dn'),
    gameId,
    discipline,
    num: game.deptNoteSeq,
    text: String(text).trim(),
    attachments,
    status: 'new',
    taskIds: [],
    createdAt: Date.now(),
  };
  db.deptNotes.push(note);
  orch.feedPost(gameId, { kind: 'deptnote', from: orch.directorName(), deptNoteId: note.id, discipline, text: `${label(discipline)} note ${ref(note)}\n${note.text}`, attachments });
  save();
  changed();
  return note;
}

const waiting = (n) => n.status === 'new' && (!n.pickedBy || Date.now() - n.pickedAt > PICK_TTL);

// Called when an agent takes work in a department: hands it the oldest waiting note there.
export function pickFor(agent, game, discipline) {
  const note = db.deptNotes.find((n) => n.gameId === game.id && n.discipline === discipline && waiting(n));
  if (!note) return null;
  Object.assign(note, { pickedBy: agent.id, pickedByName: agent.name, pickedAt: Date.now() });
  orch.feedPost(game.id, { kind: 'system', text: `${agent.name} picked up ${label(discipline)} note ${ref(note)} and is breaking it into tasks.` });
  save();
  changed();
  return note;
}

export function find(game, noteRef) {
  const s = String(noteRef || '').trim();
  return db.deptNotes.find((n) => n.gameId === game.id && (n.id === s || `D${n.num}`.toLowerCase() === s.toLowerCase() || String(n.num) === s));
}

// Turns a note into board tasks and marks it TASKED with links to them.
export function taskNote(note, tasks, by) {
  must(note, 'No such department note on this game.');
  must(note.status !== 'archived', `${ref(note)} is already archived.`);
  const list = (Array.isArray(tasks) ? tasks : []).filter((t) => String(t?.title || '').trim()).slice(0, 12);
  must(list.length, 'Give at least one task.');
  const created = list.map((t) => {
    const title = /^\s*\[/.test(t.title) ? t.title.trim() : `[${tagFor(note.discipline)}] ${t.title.trim()}`;
    const task = orch.addTask(note.gameId, {
      title,
      detail: `${String(t.detail || '').trim()}\n\nFrom ${label(note.discipline)} note ${ref(note)} (director): ${note.text.slice(0, 800)}`.trim(),
      createdBy: by,
    });
    task.deptNoteId = note.id;
    return task;
  });
  note.taskIds.push(...created.map((t) => t.id));
  Object.assign(note, { status: 'tasked', taskedAt: Date.now(), taskedBy: by });
  orch.feedPost(note.gameId, { kind: 'system', text: `${label(note.discipline)} note ${ref(note)} is TASKED: ${created.map((t) => `#${t.num}`).join(', ')} (by ${by}).` });
  save();
  changed();
  return created;
}

// Fallback: Ballast breaks the note down itself with a small structured run.
const SCHEMA = {
  type: 'object',
  properties: { tasks: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' } }, required: ['title'] } } },
  required: ['tasks'],
};
const breaking = new Set();

async function breakDown(note) {
  const game = orch.getGame(note.gameId);
  const acct = db.accounts.filter((a) => a.loggedIn && !(a.limitedUntil > Date.now())).sort((a, b) => orch.utilization(a) - orch.utilization(b))[0];
  if (!game || !acct) return;
  breaking.add(note.id);
  try {
    const open = db.tasks.filter((t) => t.gameId === game.id && t.status !== 'done').map((t) => `- #${t.num} ${t.title}`).join('\n') || '(nothing)';
    const { result } = await claude.runQuick({
      account: acct,
      args: ['--model', db.settings.triageModel || 'sonnet', '--tools', 'Read', '--json-schema', JSON.stringify(SCHEMA)],
      prompt: `Break a game director's ${label(note.discipline)} department note into board tasks for autonomous agents on "${game.name}".
Game brief: ${game.brief?.trim() || '(none)'}
Already on the board (don't duplicate):
${open}

${label(note.discipline)} note:
${note.text}

One task per concrete change, each doable by one agent with a clear done-condition, keeping the director's wording where it matters. Start every title with [${tagFor(note.discipline)}].`,
    });
    if (result) recordUsage({ account: acct, gameId: game.id, kind: 'triage', result });
    const tasks = result?.structured_output?.tasks;
    if (note.status === 'new' && tasks?.length) taskNote(note, tasks, 'Ballast');
  } finally {
    breaking.delete(note.id);
  }
}

// Scheduler hook: archive finished notes, and break down notes nobody got to.
export async function tick() {
  const fallback = (db.settings.deptNoteFallbackMin ?? 15) * 60e3;
  for (const note of db.deptNotes) {
    if (note.status === 'tasked') {
      const tasks = note.taskIds.map((id) => db.tasks.find((t) => t.id === id));
      // A task deleted from the board no longer holds the note open.
      if (tasks.every((t) => !t || t.status === 'done')) {
        Object.assign(note, { status: 'archived', archivedAt: Date.now() });
        orch.feedPost(note.gameId, { kind: 'system', text: `${label(note.discipline)} note ${ref(note)} archived: all its tasks are done.` });
        save();
        changed();
      }
    } else if (note.status === 'new' && !breaking.has(note.id)) {
      const unpicked = !note.pickedBy && Date.now() - note.createdAt > fallback;
      const stalled = note.pickedBy && Date.now() - note.pickedAt > PICK_TTL;
      if (fallback > 0 && (unpicked || stalled)) await breakDown(note).catch(() => {});
    }
  }
}

export function remove(id) {
  db.deptNotes = db.deptNotes.filter((n) => n.id !== id);
  save();
  changed();
}

// Director can also re-open a note's pickup or break it down right now.
export async function breakDownNow(id) {
  const note = must(db.deptNotes.find((n) => n.id === id), 'Unknown note');
  must(note.status === 'new', 'That note is already tasked.');
  await breakDown(note);
  return note;
}
