# Ballast

A lightweight local app that leashes several Claude Code accounts into one game-dev team.

Each Claude account you add becomes an **agent**. Point a **game** at a repo, send it notes (gameplay review, art notes, direction) and every agent working in that repo picks them up. One agent splits each note into tasks on a shared **board**, the agents claim tasks and work them in parallel (each can also spin up its own subagents), and Ballast keeps them going until the board is empty. Run as many games side by side as you like.

No dependencies: Node's standard library and the `claude` CLI you already have.

## Run it

Requirements: Node 20+, git, and Claude Code (`claude --version`).

```bash
node src/server.mjs
```

Or double-click `start-ballast.cmd`. It opens <http://127.0.0.1:4477>. Use a different port with `node src/server.mjs 4500`, or skip opening the browser with `--no-open`.

## Setup in four steps

1. **Add accounts** (sidebar, `+`). Tick *Use the Claude login already on this computer* for your normal login. Every other account gets its own Claude profile in `~/.ballast/accounts/<name>`. Ballast opens a terminal running `claude auth login` for it and notices on its own when you're done.
2. **Create a game**: give it a name and a folder. An existing git repo works, and so does a new or empty folder (Ballast runs `git init` for you). Tick which accounts should work on it.
3. **Write a game brief** (Settings tab). Every agent reads it.
4. **Send a note** from the Feed.

## How a note becomes work

```
you ──note──▶ lead agent triages it into board tasks (no coding)
                      │
                      ▼
        every agent on the game gets the note + task numbers
                      │
        each one: board_claim → work → land on integration → board_done
                      │
        autopilot: an idle agent with open tasks left gets "claim the next one"
```

- **All agents vs one agent.** The composer sends to *All agents* by default (the triage flow above). Pick *Only <name>* to talk to a single agent directly; the Agents tab shows each agent's full transcript and has its own composer.
- **Board.** Agents use Ballast's MCP tools (`board_list`, `board_add`, `board_claim`, `board_done`, `board_block`, `post_update`, `publish_artifact`, `read_notes`). Agents can add tasks for each other. When they do, idle agents get woken to pick them up. You can add, edit, reopen and delete tasks too.
- **Autopilot** (header switch) keeps idle agents claiming open tasks. It's capped at a daily number of automatic turns per game (global Settings). **Wake idle** hands out open tasks immediately.
- **Stop** kills an agent's turn, puts its task back on the board, and pauses it: autopilot leaves it alone until you message it or press Wake.
- **Usage limits.** When an account runs out of usage, its claimed tasks go back on the board for the other accounts. Its agents resume when the limit resets. The sidebar shows each account's 5-hour and 7-day usage.
- **Stuck turns.** If an agent ends a turn still holding a task, it gets one nudge. If it ends the next turn still holding it, the task is marked blocked so you see it.

## Git: worktrees vs shared tree

**Worktrees (default for git repos).** Each agent gets its own worktree at `<repo>.ballast/<agent>` on branch `ballast/<agent>`. Finished work is rebased and fast-forwarded onto `ballast/integration` (`git push . HEAD:ballast/integration`), which nothing has checked out. Agents never step on each other's files. Bring the team's work into your branch whenever you like:

```bash
git merge ballast/integration
```

Unity note: each worktree imports its own `Library` the first time it opens, which is slow once and then fine.

**Shared tree.** All agents edit the repo folder directly. Agents are told to stage only their own files and to never stash, reset or clean. It's simpler, but agents can collide.

## Builds and daily check-ins

In a game's Settings:

- **Check-in times**, e.g. `09:00, 13:00, 17:30`. At each one Ballast builds and posts a check-in to the feed: commits since the last build plus the board tasks finished. A missed slot still fires if Ballast starts within 90 minutes of it.
- **Build command** runs in a dedicated `_build` worktree checked out at `ballast/integration` (or in the repo, in shared mode). It gets `BALLAST_OUTPUT_DIR`, `BALLAST_BUILD_ID`, `BALLAST_COMMIT` and `BALLAST_GAME` in its environment. Example for Unity:
  ```
  "C:\Program Files\Unity\Hub\Editor\6000.0.40f1\Editor\Unity.exe" -batchmode -quit -projectPath . -executeMethod Builds.Quest -logFile -
  ```
  Don't have a build method yet? Send a note: *"add a batchmode build method Builds.Quest that writes the APK to BALLAST_OUTPUT_DIR"*.
- **Output to collect**: a path relative to the repo, copied into the build record. You can skip it if your build writes to `BALLAST_OUTPUT_DIR`.
- **Share folder**: successful builds get copied here (a Google Drive, OneDrive or network folder is the easy way to share them).
- **Webhook**: a Slack or Discord incoming webhook gets the check-in summary.
- **Written check-in report**: optionally the lead agent writes a short "what's playable, what changed, what's next" report after each check-in.

**Build now** on the Builds tab runs one immediately.

## Artifacts

Agents publish anything you should look at with `publish_artifact`: HTML prototypes (a folder with `index.html` works), mockups, design docs, screenshots, videos. They land on the game's Artifacts tab and in the feed. HTML artifacts are served sandboxed. Ask for them in notes: *"make an HTML mock of the new HUD and publish it"*.

## Taking over a session

Agent → **Terminal** opens that agent's Claude session (`claude --resume <id>`) in a terminal, under the right account, in its worktree. Stop the agent first.

## Safety

- Games default to `bypassPermissions` so agents can work unattended: **they run any command without asking**. Only point Ballast at repos and machines you're comfortable with that. You can switch a game to `auto` or `acceptEdits` in Settings, but agents may then stall on actions that need approval.
- The server listens on `127.0.0.1` only. The UI uses an HttpOnly, SameSite=Strict cookie and rejects cross-origin writes and foreign `Host` headers, so a web page can't drive your agents. Agents call back with a separate key.
- Ballast strips `ANTHROPIC_API_KEY` from agent environments so one key can't silently bill every account.
- Check that running several Claude plans side by side fits the terms of those plans.

## Data

Everything lives in `~/.ballast` (set `BALLAST_HOME` to move it):

```
state.json            accounts, games, agents, board, builds, artifacts index
accounts/<name>/      Claude profile per account (CLAUDE_CONFIG_DIR)
games/<id>/feed.jsonl game feed; attachments/ holds pasted images
agents/<id>/          transcript.jsonl, system prompt and MCP config
artifacts/<game>/     published artifacts
builds/<game>/<id>/   build.log + output/
```

## Code map

| File | What |
|---|---|
| `src/server.mjs` | HTTP API, SSE, static files, auth |
| `src/orchestrator.mjs` | accounts, games, agents, board, dispatch, autopilot, usage limits |
| `src/claude.mjs` | runs `claude -p --output-format stream-json` per turn, logins, terminals |
| `src/prompts.mjs` | every piece of text sent to agents (tune the team protocol here) |
| `src/mcp-server.mjs` | the stdio MCP server each agent loads (board, feed, artifacts) |
| `src/scheduler.mjs` | check-in schedule and builds |
| `src/git.mjs` | worktree and integration-branch helpers |
| `public/` | the UI (vanilla JS, no build step) |
