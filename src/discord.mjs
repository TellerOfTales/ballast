// Playtesters on Discord: a bot you create reads each game's playtest channels, and every batch
// of new messages becomes a note on that game's board (agents triage it like your own notes).
// It polls Discord's REST API from this PC, so there's nothing to host.
import { db, save } from './store.mjs';
import { changed } from './bus.mjs';
import * as orch from './orchestrator.mjs';

const API = 'https://discord.com/api/v10';
const POLL_MS = 60e3;
const BATCH_MAX = 25;
const state = { bot: null, error: null };
// Messages waiting to be sent as one note live on the game (game.playtest.pending), so a
// restart between reading them and sending them loses nothing.

const token = () => db.secrets.discordToken || '';

async function call(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { authorization: `Bot ${token()}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  if (res.status === 429) {
    const wait = Number((await res.json().catch(() => ({}))).retry_after || 2) * 1000;
    await new Promise((r) => setTimeout(r, Math.min(wait, 30e3)));
    return call(path, init);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.message ? `Discord: ${body.message}` : `Discord ${res.status}`), { status: res.status === 401 ? 400 : res.status });
  }
  return res.status === 204 ? null : res.json();
}

// The bot's permissions: view channels, read history, add reactions (the ✅ on ingested messages).
const PERMISSIONS = 1024 + 65536 + 64;

export function info() {
  return {
    connected: !!(token() && state.bot),
    bot: state.bot,
    error: state.error,
    invite: state.bot ? `https://discord.com/oauth2/authorize?client_id=${state.bot.id}&scope=bot&permissions=${PERMISSIONS}` : null,
  };
}

export async function connect({ token: t }) {
  const value = String(t || '').trim();
  if (!value) {
    delete db.secrets.discordToken;
    state.bot = null;
    save();
    changed();
    return info();
  }
  db.secrets.discordToken = value;
  try {
    const me = await call('/users/@me');
    state.bot = { id: me.id, name: me.username };
    state.error = null;
  } catch (err) {
    delete db.secrets.discordToken;
    state.bot = null;
    throw err;
  }
  save();
  changed();
  return info();
}

// Text channels the bot can see, grouped by server, for the per-game picker.
export async function channels() {
  if (!token()) throw Object.assign(new Error('Connect a Discord bot first (Settings → Discord).'), { status: 400 });
  const guilds = await call('/users/@me/guilds');
  const out = [];
  for (const g of guilds) {
    const list = await call(`/guilds/${g.id}/channels`).catch(() => []);
    for (const c of list) if (c.type === 0 || c.type === 5) out.push({ id: c.id, name: c.name, guild: g.name, guildId: g.id }); // text and announcement channels
  }
  return out;
}

// game.playtest = { channels: [{ id, name, guild, guildId, lastId }], batchMin }
export async function setChannels(gameId, { channels: list = [], batchMin } = {}) {
  const game = orch.getGame(gameId);
  if (!game) throw Object.assign(new Error('Unknown game'), { status: 400 });
  const before = new Map((game.playtest?.channels || []).map((c) => [c.id, c]));
  const next = [];
  for (const c of list) {
    const kept = before.get(c.id);
    // New channels start from their latest message: old chatter isn't fed to the agents.
    let lastId = kept?.lastId;
    if (!lastId) lastId = (await call(`/channels/${c.id}/messages?limit=1`).catch(() => []))[0]?.id || '0';
    next.push({ id: c.id, name: c.name, guild: c.guild, guildId: c.guildId, lastId });
  }
  game.playtest = { channels: next, batchMin: Math.max(1, Math.min(240, Number(batchMin ?? game.playtest?.batchMin ?? 15))), pending: game.playtest?.pending || [] };
  save();
  changed();
  if (next.length) orch.feedPost(gameId, { kind: 'system', text: `Playtester feedback from Discord: ${next.map((c) => `#${c.name}`).join(', ')}. New messages are gathered for ${game.playtest.batchMin} min, then sent to the team as one note.` });
  return game.playtest;
}

function format(game, batch) {
  const byChannel = new Map();
  for (const m of batch) (byChannel.get(m.channel) || byChannel.set(m.channel, []).get(m.channel)).push(m);
  const parts = [...byChannel].map(([ch, msgs]) => `From #${ch}:\n${msgs.map((m) => `- ${m.author}: ${m.text}${m.files.length ? ` [${m.files.join(' ')}]` : ''}`).join('\n')}`);
  return `Playtester feedback from Discord (${batch.length} message${batch.length > 1 ? 's' : ''}). These are players, not the director: weigh issues several people raise, treat single opinions as signals, and ignore chatter that isn't about the game.\n\n${parts.join('\n\n')}`;
}

function flush(game) {
  const batch = game.playtest?.pending;
  if (!batch?.length) return;
  game.playtest.pending = [];
  save();
  try {
    orch.postNote(game.id, { text: format(game, batch).slice(0, 12000), from: 'Playtesters (Discord)', source: 'playtest' });
  } catch (err) {
    orch.feedPost(game.id, { kind: 'error', text: `Couldn't send playtester feedback: ${err.message}` });
  }
}

async function poll() {
  if (!token()) return;
  if (!state.bot) {
    try { const me = await call('/users/@me'); state.bot = { id: me.id, name: me.username }; state.error = null; } catch (err) { state.error = err.message; return; }
  }
  for (const game of db.games) {
    const chans = game.playtest?.channels || [];
    if (!chans.length || (game.status || 'active') === 'archived') continue;
    for (const c of chans) {
      try {
        const msgs = (await call(`/channels/${c.id}/messages?after=${c.lastId || '0'}&limit=50`)).reverse(); // oldest first
        for (const m of msgs) {
          c.lastId = m.id;
          if (m.author?.bot) continue;
          const text = (m.content || '').trim();
          const files = (m.attachments || []).map((a) => a.url);
          if (!text && !files.length) continue;
          (game.playtest.pending ||= []).push({ channel: c.name, author: m.author?.global_name || m.author?.username || 'player', text: text.replace(/\s+/g, ' ').slice(0, 1500), files, at: Date.parse(m.timestamp) || Date.now() });
          call(`/channels/${c.id}/messages/${m.id}/reactions/%E2%9C%85/@me`, { method: 'PUT' }).catch(() => {}); // "seen" for the player
        }
        if (msgs.length) save();
        c.error = null;
      } catch (err) {
        c.error = err.message;
      }
    }
    const list = game.playtest.pending;
    if (list?.length && (list.length >= BATCH_MAX || Date.now() - list[0].at >= (game.playtest.batchMin || 15) * 60e3)) flush(game);
  }
  changed();
}

// "Send now" from the game's settings.
export function flushNow(gameId) {
  const game = orch.getGame(gameId);
  if (game) flush(game);
  return { ok: true };
}

export function init() {
  setInterval(() => poll().catch(() => {}), POLL_MS).unref();
  setTimeout(() => poll().catch(() => {}), 5000);
}
