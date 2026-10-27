// Token accounting. Every Claude run Ballast makes (agent turns, artifact syncs, limit
// probes) appends one record; summaries are computed from the log on demand.
import { appendJsonl, readJsonlTail, usageFile } from './store.mjs';
import { changed } from './bus.mjs';

let cache = null;

// `result` is the CLI's final stream-json message. modelUsage is cumulative for the run
// (subagents included), so prefer it over the top-level usage block.
export function recordUsage({ account, gameId = null, agentId = null, kind, result }) {
  if (!result) return;
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const models = Object.entries(result.modelUsage || {});
  if (models.length) {
    for (const [, m] of models) {
      t.input += m.inputTokens || 0;
      t.output += m.outputTokens || 0;
      t.cacheRead += m.cacheReadInputTokens || 0;
      t.cacheWrite += m.cacheCreationInputTokens || 0;
    }
  } else if (result.usage) {
    const u = result.usage;
    Object.assign(t, { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 });
  }
  appendJsonl(usageFile, {
    ts: Date.now(),
    accountId: account.id,
    gameId,
    agentId,
    kind,
    ...t,
    cost: result.total_cost_usd || 0,
    models: models.map(([name]) => name),
  });
  cache = null;
  changed();
}

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function bucket() {
  return { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, runs: 0 };
}

function add(b, r) {
  b.input += r.input;
  b.output += r.output;
  b.cacheRead += r.cacheRead;
  b.cacheWrite += r.cacheWrite;
  b.tokens += r.input + r.output + r.cacheRead + r.cacheWrite;
  b.cost += r.cost;
  b.runs++;
}

// Today / 7-day / per-day totals by account, game and run kind.
export function usageSummary(days = 14) {
  if (cache && Date.now() - cache.at < 5000) return cache.value;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();
  const weekStart = Date.now() - 7 * 86400e3;
  const today = dayKey(Date.now());
  const records = readJsonlTail(usageFile, 500000, 128 * 1024 * 1024).filter((r) => r.ts >= start);

  const series = [];
  for (let i = 0; i < days; i++) series.push({ day: dayKey(start + i * 86400e3 + 3600e3), byAccount: {}, total: 0 });
  const seriesByDay = Object.fromEntries(series.map((s) => [s.day, s]));
  const accounts = {};
  const games = {};
  const kinds = {};
  const range = (map, key) => (map[key] ||= { today: bucket(), week: bucket(), range: bucket() });

  for (const r of records) {
    const day = dayKey(r.ts);
    const tokens = r.input + r.output + r.cacheRead + r.cacheWrite;
    const s = seriesByDay[day];
    if (s) {
      s.byAccount[r.accountId] = (s.byAccount[r.accountId] || 0) + tokens;
      s.total += tokens;
    }
    for (const [map, key] of [[accounts, r.accountId], [games, r.gameId || '_none'], [kinds, r.kind]]) {
      const b = range(map, key);
      add(b.range, r);
      if (r.ts >= weekStart) add(b.week, r);
      if (day === today) add(b.today, r);
    }
  }
  const value = { days, series, accounts, games, kinds };
  cache = { at: Date.now(), value };
  return value;
}
