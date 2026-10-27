#!/usr/bin/env node
// Claude Code hook for local agents' Task/Agent calls. "pre" asks Ballast whether the agent may
// start another subagent (Ballast enforces the per-agent limit); "post" reports it finished.
// If Ballast can't be reached, the hook steps aside rather than blocking the agent.
const phase = process.argv[2] === 'post' ? 'post' : 'pre';
const { BALLAST_URL, BALLAST_AGENT_ID, BALLAST_KEY } = process.env;

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', async () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { /* treat as empty */ }
  if (!BALLAST_URL || !BALLAST_AGENT_ID) process.exit(0);
  try {
    const res = await fetch(`${BALLAST_URL}/agent-api/subagent_hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ballast-key': BALLAST_KEY || '' },
      body: JSON.stringify({ agentId: BALLAST_AGENT_ID, args: { phase, tool_use_id: input.tool_use_id, tool_input: input.tool_input } }),
      signal: AbortSignal.timeout(5000),
    });
    const out = (await res.json())?.result;
    if (phase === 'pre' && out && out.allow === false) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: out.reason },
      }));
    }
  } catch { /* Ballast unreachable: don't block the agent */ }
  process.exit(0);
});
