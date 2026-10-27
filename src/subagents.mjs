// Subagents: the short-lived helpers a local agent spins up inside its own chat with Claude
// Code's Task/Agent tool. Ballast tracks them from the agent's output stream and enforces a
// per-agent cap through a PreToolUse hook that asks Ballast before each one starts. (Full
// delegate chats, separate sessions an agent opens, live in delegates.mjs.)
import { db, uid } from './store.mjs';
import { changed } from './bus.mjs';

export const TOOL_RE = /^(Task|Agent)$/;
const registry = new Map(); // agentId -> Map(subagentId -> subagent)
const history = new Map(); // agentId -> recently finished subagents (newest last)

const forAgent = (agentId) => {
  if (!registry.has(agentId)) registry.set(agentId, new Map());
  return registry.get(agentId);
};

export const active = (agentId) => [...forAgent(agentId).values()].filter((d) => !d.endedAt);

export function limitFor(game) {
  const n = game?.subagentLimit ?? db.settings.subagentLimit ?? 4;
  return Math.max(0, Number(n) || 0);
}

function describeInput(input = {}) {
  return {
    description: String(input.description || input.prompt || 'subagent').replace(/\s+/g, ' ').slice(0, 120),
    type: String(input.subagent_type || 'general-purpose'),
    background: !!input.run_in_background,
  };
}

// The same subagent is reported twice, by the hook (before it starts) and by the stream (the
// tool call itself). Both carry the tool_use_id when the CLI provides it; otherwise a pending
// hook entry is matched to the stream entry by its description.
function upsert(agentId, id, input) {
  const map = forAgent(agentId);
  const info = describeInput(input);
  let d = id && map.get(id);
  if (!d) {
    d = [...map.values()].find((x) => !x.endedAt && !x.streamed && x.description === info.description);
    if (d && id && d.id !== id) {
      map.delete(d.id);
      d.id = id;
      map.set(id, d);
    }
  }
  if (!d) {
    d = { id: id || uid('dg'), agentId, ...info, startedAt: Date.now() };
    map.set(d.id, d);
  }
  return d;
}

// Hook: called before a subagent starts. Returns { allow, reason }.
export function requestStart(agent, game, { tool_use_id, tool_input }) {
  const limit = limitFor(game);
  const running = active(agent.id);
  const info = describeInput(tool_input);
  if (limit > 0 && running.length >= limit) {
    const a = db.agents.find((x) => x.id === agent.id);
    if (a) a.subagentsDenied = (a.subagentsDenied || 0) + 1;
    changed();
    return {
      allow: false,
      reason: `Subagent limit reached: ${running.length} of ${limit} already running (${running.map((d) => d.description).join('; ')}). Wait for one to finish, or do this part yourself.`,
    };
  }
  const d = upsert(agent.id, tool_use_id, tool_input);
  Object.assign(d, info);
  changed();
  return { allow: true };
}

// Stream: the tool call and its result as they happen.
export function onToolUse(agentId, block) {
  const d = upsert(agentId, block.id, block.input);
  d.streamed = true;
  changed();
}

export function onToolResult(agentId, toolUseId, ok) {
  const d = forAgent(agentId).get(toolUseId);
  // A background subagent's tool result only means "started"; it keeps running past it.
  if (!d || d.background || d.endedAt) return;
  finish(agentId, d, ok);
}

export function onHookEnd(agentId, { tool_use_id }) {
  const d = tool_use_id && forAgent(agentId).get(tool_use_id);
  if (d && !d.background && !d.endedAt) finish(agentId, d, true);
}

function finish(agentId, d, ok) {
  Object.assign(d, { endedAt: Date.now(), ok });
  const a = db.agents.find((x) => x.id === agentId);
  if (a) a.subagentsRun = (a.subagentsRun || 0) + 1;
  const h = history.get(agentId) || [];
  h.push(d);
  history.set(agentId, h.slice(-20));
  forAgent(agentId).delete(d.id);
  changed();
}

// When the agent's turn ends, anything it started has ended with it.
export function endTurn(agentId) {
  for (const d of active(agentId)) finish(agentId, d, true);
}

export function publicFor(agentId) {
  return {
    active: active(agentId).map(({ id, description, type, background, startedAt }) => ({ id, description, type, background, startedAt })),
    recent: (history.get(agentId) || []).slice(-8).reverse().map(({ description, type, startedAt, endedAt, ok }) => ({ description, type, startedAt, endedAt, ok })),
  };
}
