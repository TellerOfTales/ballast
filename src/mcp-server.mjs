#!/usr/bin/env node
// Stdio MCP server that each agent's Claude Code session launches. It exposes the
// shared board and director feed as tools and forwards every call to Ballast.
import readline from 'node:readline';

const { BALLAST_URL, BALLAST_AGENT_ID, BALLAST_KEY } = process.env;

const task = { type: 'integer', description: 'Task number, e.g. 12 for #12' };
const TOOLS = [
  {
    name: 'board_list',
    description: 'List the shared task board for this game. Default shows open, claimed and blocked tasks plus the most recent done ones.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['active', 'open', 'claimed', 'blocked', 'done', 'all'] } },
    },
  },
  {
    name: 'board_add',
    description: 'Add a task to the shared board so any agent (including you) can claim it. One concrete, verifiable outcome per task. Tag the title, e.g. "[gameplay] Double jump".',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        detail: { type: 'string', description: 'What done looks like, relevant files, the director wording that matters.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'board_claim',
    description: 'Claim an open task before working on it. You can hold one task at a time.',
    inputSchema: { type: 'object', properties: { task_id: task }, required: ['task_id'] },
  },
  {
    name: 'board_done',
    description: 'Mark your task done once the work has landed. The summary goes to the director feed.',
    inputSchema: {
      type: 'object',
      properties: { task_id: task, summary: { type: 'string', description: 'What changed and how to see it in game.' } },
      required: ['task_id', 'summary'],
    },
  },
  {
    name: 'board_block',
    description: 'Give a task back as blocked, with the reason and what you need.',
    inputSchema: {
      type: 'object',
      properties: { task_id: task, reason: { type: 'string' } },
      required: ['task_id', 'reason'],
    },
  },
  {
    name: 'post_update',
    description: "Post a short update to the director's feed: a milestone, a decision you made, an assumption.",
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'publish_artifact',
    description: "Put something on the director's artifact shelf for review: HTML prototypes, mockups, design docs, screenshots, videos, reports. Pass `path` to an existing file or folder (a folder with index.html is shown as a web page), `content` plus `filename` to write a new file, or `url` with a claude.ai artifact link you published so Ballast tracks it and its comments.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        url: { type: 'string', description: 'A claude.ai artifact link (https://claude.ai/artifact/...).' },
        path: { type: 'string', description: 'File or folder, absolute or relative to your working directory.' },
        content: { type: 'string' },
        filename: { type: 'string', description: 'With content, e.g. "combat-pass-notes.md" or "hud-mock.html".' },
        description: { type: 'string', description: 'One or two lines on what to look at.' },
        discipline: { type: 'string', enum: ['gameplay', 'art', 'audio', 'backend'], description: "Which department review it belongs to. Defaults to your current task's." },
      },
      required: ['title'],
    },
  },
  {
    name: 'claude_artifacts',
    description: "List this game's tracked claude.ai artifacts (design docs, director review pages, trackers) with Ballast's latest summary of each and its open comment threads.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_claude_artifact',
    description: "Read Ballast's latest copy of a tracked claude.ai artifact: summary, live data, comment threads, and the page text when available. Works for artifacts owned by any of the team's accounts.",
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'suggest_brief',
    description: 'Propose a game brief (pillars, platform, art direction, current state, next playable). The director accepts or ignores it.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'task_dept_note',
    description: "Break a department note from the director (e.g. \"D3\") into board tasks. Creates the tasks for the whole team, links them to the note and marks the note TASKED; it's archived automatically once they're all done.",
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: 'The note reference, e.g. "D3".' },
        tasks: {
          type: 'array',
          items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string', description: 'What done looks like.' } }, required: ['title'] },
        },
      },
      required: ['note_id', 'tasks'],
    },
  },
  {
    name: 'ask_director',
    description: "Put a question in the Director's Inbox. It never blocks: say what you're assuming, carry on with that assumption, and move to the next task when this one is done. The answer arrives later as a message.\n\nThe director judges look and feel, not code. They don't know file names, systems or task numbers, and they read the Inbox cold, between play sessions. Every field must stand on its own in player-facing words: where in the game, what the player sees, hears or feels, and what changes with each option. Never mention files, functions, variables or code. Attach a screenshot or short clip whenever the question is about something visible or audible.",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The decision in one plain sentence, e.g. "Should the ghost screen stay dark, or lighten so names are readable?"' },
        context: { type: 'string', description: "Where this is in the game and what the player experiences right now (2 to 5 sentences). How you got here, and why it matters for feel. No file names or code." },
        options: { type: 'array', items: { type: 'string' }, description: 'The 2 to 4 realistic choices, each with what the player would notice, e.g. "Lighten the overlay: names readable, but the death moment feels less heavy".' },
        assumption: { type: 'string', description: "Which option you're going with until you hear back, and why, in one or two sentences." },
        screenshot: { type: 'string', description: 'Optional path to a screenshot, GIF, video or audio clip that shows what the question is about.' },
      },
      required: ['question', 'context', 'assumption'],
    },
  },
  {
    name: 'read_notes',
    description: 'Read the most recent director notes for this game.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 30 } } },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function callBallast(name, args) {
  const res = await fetch(`${BALLAST_URL}/agent-api/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ballast-key': BALLAST_KEY },
    body: JSON.stringify({ agentId: BALLAST_AGENT_ID, args }),
  });
  const body = await res.json().catch(() => ({ error: `Ballast returned HTTP ${res.status}` }));
  if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
  return body.result;
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications need no reply
  try {
    switch (method) {
      case 'initialize':
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'ballast', version: '0.1.0' },
          },
        });
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        try {
          const text = await callBallast(params.name, params.arguments || {});
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }] } });
        } catch (err) {
          const reason = err.cause?.code === 'ECONNREFUSED' ? 'Ballast is not running.' : err.message;
          return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: reason }], isError: true } });
        }
      }
      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg);
});
