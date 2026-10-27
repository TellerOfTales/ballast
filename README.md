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
2. **Create a game** and choose where its agents run:
   - **This PC:** give it a folder. An existing git repo works, and so does a new or empty folder (Ballast runs `git init` for you).
   - **Claude cloud, on a GitHub repo:** give it `owner/name`. See [Cloud games](#cloud-games).

   Tick which accounts should work on it. If the repo already has work in it, the lead agent surveys it first.
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

## Studio: all games and accounts at once

The **Studio** page (top of the sidebar) is the cross-game view:

- **Accounts and limits.** Each account shows its **Session** (5-hour) and **Weekly** (7-day) limit, plus any per-model weekly limit, as a percentage with time to reset. The numbers come from Claude's own rate-limit reports, which arrive with every run. Idle accounts get a one-word probe on a small model every 30 minutes (about a fifth of a cent) so the numbers stay current. **Refresh** checks one now.
- **Token usage.** Tokens and cost per account, per game and per day, for every run Ballast makes: agent turns, triage, artifact syncs, limit probes. Usage outside Ballast (claude.ai chats, your own terminal sessions) counts toward the limits above but not toward these totals. So do cloud sessions: their tokens aren't reported back.
- **Limit-aware routing.** Work goes to the agents whose accounts have the most headroom. Autopilot stops handing work to an account above 95% of either limit (configurable). Your own messages still go through.
- **Games.** Every game's agents, board counts, last build and next check-in. You can **Pause** a game, which frees its accounts for other games, and set its **priority**, which decides who gets account time first when accounts are busy.
- **Note to several games.** One note, triaged separately onto each ticked game's board.

## Existing games

- **Survey.** Linking a repo that already has work (or pressing *Survey project* in Settings) has the lead agent read the code and history, suggest a brief (accept it in Settings), and put the next tasks on the board.
- **Adopt old sessions.** Agent → **Sessions** lists the Claude Code conversations that account already has in that repo. Adopting one continues it as a fork, so the agent keeps everything that conversation knew and the original stays as it was.

## claude.ai artifacts and director reviews

Ballast mirrors the artifacts your accounts have on claude.ai: design docs, review pages, trackers.

- **Sync.** Every 10 minutes, each account runs a short read-only Claude turn. It lists the account's artifacts, reads the tracked ones (content, live database data, comment threads) and reports back. Pages edited today are re-read at most hourly. Untracked artifacts show up under *Found on your accounts* in Studio. **Track** links one to a game.
- **Roles.**
  - *Review*: when the page changes, the update becomes a director note to the team.
  - *Reference*: agents read it on demand.
  - *Output*: something an agent published.

  New comments on any tracked artifact become notes for that game. Set **Reviewers** in Settings to only route comments from certain people.
- **Cross-account.** Agents call `claude_artifacts` / `read_claude_artifact` to read Ballast's latest copy. That includes artifacts owned by a different account than their own.
- **Freshness.** This is polling, not push. Headless Claude runs can't hold a live watch on an artifact, so changes arrive within one sync interval.
- **Unofficial dependency.** Claude Code only loads its Artifact tools when it believes the Claude desktop app launched it. Ballast sets `CLAUDE_CODE_ENTRYPOINT=claude-desktop` for these read-only sync runs. A Claude Code update could change this. If syncing stops working, Studio shows the error. The switch is in Settings.

## Cloud games

A cloud game's agents run as **Claude Code cloud sessions** (claude.ai/code) on its GitHub repo, so your PC doesn't do the work.

- **Notes.** Cloud sessions can't reach Ballast, so Ballast splits each note into tasks itself, with a quick local run.
- **Connect once per agent.** Claude Code only creates a cloud session from an interactive terminal, so each cloud agent gets one session that it keeps. Agent → **Connect cloud session** opens a terminal running `claude --cloud` under that agent's account; paste the link it prints (`https://claude.ai/code/session_…`) back into Ballast. A session you start yourself on claude.ai/code for the repo works too.
- **Dispatch.** Ballast sends each task to the agent's session as a message (`claude -p --cloud <session>`, which works headless). The message carries the brief, recent notes, what others are working on, and the tracked artifact summaries. One task at a time per agent.
- **Folder links.** A link like `github.com/owner/name/tree/main/game` keeps agents inside `game/`, and their reports go in `game/.ballast/reports/`.
- **Delivery.** The agent works on its own branch, opens a pull request into the base branch, and commits `.ballast/reports/t<task>.md`. Its first line is `STATUS: DONE` or `STATUS: BLOCKED`.
- **Completion.** Ballast checks GitHub every 90 seconds for that report, closes or blocks the task with the PR link, and hands the agent the next task.
- **Messages.** A message to a cloud agent goes straight to its session.
- **Builds.** Builds run in Ballast's own clone (`~/.ballast/clones/<game>`) at the latest base branch, so check-ins show merged PRs.

Requirements:
- Every account needs GitHub connected on claude.ai/code: run `/web-setup` once in Claude Code, or install the Claude GitHub app.
- Your git on this PC must be able to read the repo.
- Model and permissions for cloud sessions are set on claude.ai/code. Attachments in notes stay on this PC.

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
usage.jsonl           one line per Claude run: account, game, tokens, cost
accounts/<name>/      Claude profile per account (CLAUDE_CONFIG_DIR)
cloud/<id>/           last copy of each tracked claude.ai artifact
clones/<game>/        Ballast's clone of each cloud game's GitHub repo
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
| `src/mcp-server.mjs` | the stdio MCP server each local agent loads (board, feed, artifacts, claude.ai mirror) |
| `src/scheduler.mjs` | check-in schedule, builds, limit probes, artifact syncs, cloud polling |
| `src/usage.mjs` | token accounting and summaries |
| `src/cloud.mjs` | claude.ai artifact sync and review routing |
| `src/remote.mjs` | cloud games: triage, cloud sessions, GitHub report polling |
| `src/git.mjs` | worktree and integration-branch helpers |
| `public/` | the UI (vanilla JS, no build step) |
