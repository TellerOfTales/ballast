// Video review for playtest recordings attached in the Feed. Before the note reaches the team,
// Ballast pulls frames from the video (ffmpeg), transcribes the commentary (local Whisper), and has
// Claude watch the frames against what was said. The note then goes out with timestamped review
// notes and the key frames attached, so agents get something they can act on.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { db, attachmentsDir, uid } from './store.mjs';
import { bus } from './bus.mjs';
import * as claude from './claude.mjs';
import * as orch from './orchestrator.mjs';
import * as whisper from './whisper.mjs';
import { recordUsage } from './usage.mjs';
import { pickAccount, context } from './ask.mjs';
import * as review from './review.mjs';

export const isVideo = (name) => /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(name || '');
const MAX_FRAMES = 40;
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function run(cmd, args, timeout = 30 * 60e3) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(`${cmd} failed: ${String(stderr || err.message).trim().split('\n').slice(-2).join(' ')}`), { code: err.code }));
      else resolve(String(stdout));
    });
  });
}

async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], 60e3);
  const j = JSON.parse(out);
  return { duration: Number(j.format?.duration) || 0, audio: (j.streams || []).some((s) => s.codec_type === 'audio') };
}

const SCHEMA = {
  type: 'object',
  required: ['summary', 'items'],
  properties: {
    summary: { type: 'string', description: 'Two or three sentences: what this playtest shows and the main takeaways.' },
    items: {
      type: 'array',
      description: 'Each thing worth acting on, in the order it happens.',
      items: {
        type: 'object',
        required: ['t', 'title', 'detail', 'area', 'frame'],
        properties: {
          t: { type: 'number', description: 'Seconds into the video.' },
          title: { type: 'string', description: 'Short, specific.' },
          detail: { type: 'string', description: 'What happens on screen and what the director said, and what should change. Player-facing.' },
          area: { enum: review.DISCIPLINES.map((d) => d.id) },
          frame: { type: 'string', description: 'The frame file that shows it best, e.g. f012.jpg, or "" if none does.' },
        },
      },
    },
  },
};

const emit = (gameId, id, stage, extra = {}) => bus.emit('event', { type: 'video', gameId, id, stage, ...extra });

export async function reviewOne(game, att, note, id) {
  const dir = path.join(attachmentsDir(game.id), `${path.basename(att.path).replace(/\.[^.]+$/, '')}-review`);
  fs.mkdirSync(dir, { recursive: true });
  const urlBase = `/files/attachments/${game.id}/${encodeURIComponent(path.basename(dir))}`;
  const { duration, audio } = await probe(att.path);
  if (!duration) throw new Error('Couldn\'t read the video (is it a finished recording?).');

  emit(game.id, id, `Pulling frames from ${mmss(duration)} of video…`);
  const every = Math.max(2, Math.ceil(duration / MAX_FRAMES));
  for (const f of fs.readdirSync(dir)) if (/^f\d+\.jpg$/.test(f)) fs.rmSync(path.join(dir, f));
  await run('ffmpeg', ['-v', 'error', '-y', '-i', att.path, '-vf', `fps=1/${every},scale=960:-2`, '-q:v', '4', path.join(dir, 'f%03d.jpg')]);
  const frames = fs.readdirSync(dir).filter((f) => /^f\d+\.jpg$/.test(f)).sort()
    .map((f, i) => ({ file: f, t: Math.min(duration, i * every + every / 2), path: path.join(dir, f), url: `${urlBase}/${f}` }));

  let transcript = [];
  let heard = '';
  if (audio && whisper.info().installed) {
    emit(game.id, id, 'Transcribing your commentary…');
    const wav = path.join(dir, 'audio.wav');
    await run('ffmpeg', ['-v', 'error', '-y', '-i', att.path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    try { transcript = await whisper.transcribeFile(wav, { prompt: `${game.name} playtest commentary.` }); } catch (err) { heard = `(Couldn't transcribe the audio: ${err.message})`; }
    fs.rmSync(wav, { force: true });
  } else heard = audio ? '(Local Whisper isn\'t set up, so the commentary wasn\'t transcribed.)' : '(The video has no audio.)';

  emit(game.id, id, `Claude is watching ${frames.length} frames${transcript.length ? ' against your commentary' : ''}…`);
  const acct = pickAccount();
  if (!acct) throw new Error('No logged-in account has usage free right now.');
  const { result } = await claude.runQuick({
    account: acct,
    args: ['--model', db.settings.videoModel || 'sonnet', '--tools', 'Read', '--permission-mode', 'dontAsk', '--allowedTools', 'Read', '--add-dir', dir, '--json-schema', JSON.stringify(SCHEMA)],
    prompt: `Review a playtest recording of "${game.name}" for its solo developer, who recorded it while playing${transcript.length ? ' and talking' : ''}. Your notes go to the AI agents building the game, so they need to be specific and actionable.

The developer's note with it:
${note || '(none)'}

Frames, one every ${every} seconds (open each with Read; they're in ${dir}):
${frames.map((f) => `- ${f.file} at ${mmss(f.t)}`).join('\n')}

${transcript.length ? `What the developer said:\n${transcript.map((s) => `[${mmss(s.start)}] ${s.text}`).join('\n')}` : heard}

Look at every frame. Report what the developer pointed out (their words carry the most weight), plus anything clearly wrong you can see yourself: bugs, visual glitches, unreadable UI, things that look off against the game's direction. Don't invent problems; skip frames where nothing stands out. Give each item the time it happens and the frame that shows it.

The game:
${context(game)}`,
  });
  if (result) recordUsage({ account: acct, gameId: game.id, kind: 'video', result });
  const out = result?.structured_output;
  if (!out?.items) throw new Error(result?.result?.slice(0, 200) || 'Claude returned no review.');
  return { duration, frames, transcript, heard, out, account: acct.name };
}

// Called instead of postNote when a note carries videos: the video shows in the feed right away,
// the note follows once it's been reviewed.
export function postWithReview(gameId, body) {
  const game = orch.getGame(gameId);
  if (!game) throw Object.assign(new Error('Unknown game'), { status: 400 });
  const videos = (body.attachments || []).filter((a) => isVideo(a.name) && a.path && fs.existsSync(a.path));
  const id = uid('vid');
  orch.feedPost(gameId, { kind: 'video', videoId: id, from: orch.directorName(), text: body.text || '', attachments: videos, stage: 'Reviewing…' });
  (async () => {
    const sections = [];
    const frames = [];
    for (const v of videos) {
      try {
        const r = await reviewOne(game, v, body.text, id);
        sections.push(`🎬 Video review of ${v.name} (${mmss(r.duration)}; Claude watched ${r.frames.length} frames${r.transcript.length ? ' against my commentary' : ''}):\n${r.out.summary}\n\n${r.out.items.map((i) => `- [${mmss(i.t)}] [${i.area}] ${i.title}: ${i.detail}${i.frame ? ` (frame ${i.frame})` : ''}`).join('\n') || '- Nothing specific to act on.'}${r.transcript.length ? `\n\nWhat I said while playing:\n${r.transcript.map((s) => `[${mmss(s.start)}] ${s.text}`).join('\n').slice(0, 6000)}` : ''}`);
        for (const i of r.out.items) {
          const f = r.frames.find((x) => x.file === i.frame);
          if (f && !frames.some((x) => x.path === f.path)) frames.push({ name: `${v.name.replace(/\.[^.]+$/, '')}-${mmss(i.t).replace(':', 'm')}s.jpg`, path: f.path, url: f.url });
        }
        emit(gameId, id, 'done', { items: r.out.items.length });
      } catch (err) {
        sections.push(`🎬 ${v.name}: couldn't review it automatically (${err.message}). The video is attached.`);
        emit(gameId, id, 'error', { error: err.message });
      }
    }
    const text = [body.text, ...sections].filter(Boolean).join('\n\n');
    try {
      orch.postNote(gameId, { ...body, text, attachments: [...(body.attachments || []), ...frames.slice(0, 20)] });
    } catch (err) {
      orch.feedPost(gameId, { kind: 'error', text: `Couldn't send the reviewed note: ${err.message}` });
    }
  })();
  return { reviewing: videos.length };
}
