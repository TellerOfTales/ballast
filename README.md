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

## Delegate chats: fanning work out

An agent on this PC can open **delegate chats** with `open_delegate`. A delegate chat is a new, fully capable Claude chat: its own session, every tool, the board, and its own branch starting from the parent's work. It works on part of the parent's job at the same time as the parent. Delegates can open their own delegates, so the work spreads out like a web.

- **Brief and handover.** The parent writes a self-contained brief and can hand over board tasks (`task_ids`). The delegate opens on whichever logged-in account has the most room right now.
- **Reporting back.** The delegate finishes with `delegate_done` and a summary. The parent gets a message to merge the delegate's branch and land it, and handed-over tasks return to the parent. If a delegate ends without reporting, it gets one nudge, and then its last message is sent back as the report. A delegate whose parent has closed reports to the nearest open chat above it.
- **Managing.** The parent uses `list_delegates` and `message_delegate`. In the Agents tab, delegates are nested under their parent with their brief, status and report. The Studio header counts open delegate chats.
- **Limits (Settings).** *Delegate chats per agent* (default 3, open at once) and *delegate depth* (default 2 levels). Games can override the per-agent limit. Account limits still apply, so delegates queue rather than overload an account.

**Subagents** are different: short-lived helpers inside a single chat (Claude Code's Task/Agent tool). Ballast tracks them per agent and enforces *subagents per agent* (default 4 at once) with a hook that asks Ballast before each one starts.

**Cloud games:** cloud agents can't call Ballast, and Claude only creates cloud sessions from a terminal, so they can't open delegate chats. To fan a cloud game out, add more agents per account and connect them all with **Connect cloud sessions**.

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
- **Usage reports.** During your **working hours** (Settings: default 09:00 to 18:00, Monday to Friday), every account reports its session and weekly limit, time to reset and today's tokens **every 90 minutes**. Stale numbers are refreshed first. Reports show on the Studio page with their history, **Report now** runs one immediately, and an optional Slack or Discord webhook gets each one. Background limit checks only run during working hours.
- **Limit-aware routing.** Work goes to the agents whose accounts have the most headroom. Autopilot stops handing work to an account above 95% of either limit (configurable). Your own messages still go through.
- **Games.** Every game's agents, board counts, last build and next check-in. You can **Pause** a game, which frees its accounts for other games, and set its **priority**, which decides who gets account time first when accounts are busy.
- **Note to several games.** One note, triaged separately onto each ticked game's board.

## Department tabs and review

Every game has a **Gameplay**, **Art**, **Audio** and **Backend** tab. Tasks are filed by their tag: `[ui]` and `[qa]` count as Gameplay, and `[tech]`, `[build]` and `[docs]` count as Backend. Each tab shows:
- work waiting for your review
- open questions
- what's in progress and up next
- a gallery of captures: screenshots, GIFs, video and audio clips agents attached
- that department's claude.ai artifacts

**Review never holds the team up.** For each department you choose how involved you are. Set the studio default in Settings, or override it per game in the tab:

| Mode | What agents do | What you see |
|---|---|---|
| **Not my field** | merge and keep going | nothing queued; finished work listed for reference |
| **Review after** (default) | merge and keep going | finished work queues for you; *Request changes* creates a follow-up task for the same agent |
| **Approve first** | leave the change unmerged and **move straight on to other work** | *Approve & merge* lands it; anything left unreviewed is auto-approved after 24h (configurable) |

Backend defaults to *Not my field*. *Approve first* needs per-agent worktrees or a cloud game. With a shared working tree it acts like *Review after*.

**Captures.** Local agents publish captures with `publish_artifact`. Cloud agents commit them to `.ballast/media/t<task>/` on their branch, and Ballast pulls them in when the task reports.

## Quality targets

Each department tab has a **Quality targets** section for reference images (or clips) that set the bar: concept art, a screenshot from a game you admire, a lighting look, a texture with the right wear. Drop files on it or use **Add targets**. Give each a title, the **subjects** it covers (e.g. `barrels, crates, dock props`) and **what to match** (e.g. "this level of grime, warm lantern light").

- **On every task:** an agent claiming a task in that department gets the matching targets with it, matched on shared words between the subjects and the task. With no match, it gets the department's whole set. Local agents open the files directly and can look them up with `reference_targets`.
- **Cloud games:** Ballast pushes the targets and an index to a separate `ballast/targets` branch of the game's GitHub repo (never `main`), and cloud agents read them from there.
- **Agents' captures:** agents are told to meet the bar without copying, frame their captures like the closest target, and say how close they got.
- **In review:** review cards show the matching **target** next to the agent's **result**.

**Tagging assets.** In the target dialog, pick a **category** (Characters, Level design, Props, Vehicles, UI, VFX, Animation, Audio, Materials & textures), then search the game's assets and tick the ones the target applies to. Agents get the asset names and their defining files with the target, and tasks that mention a tagged asset get that target.

The asset list comes from two places:
- **Asset files** found by scanning the repo (models, textures, prefabs, scenes, audio). This is instant.
- **An asset catalog** Claude builds by reading the game: what's in it, named the way a player would name it, with the files that define it. This is what makes code-built games searchable. It's built the first time you search, and again whenever you press **Scan the game**.

## Department notes

Each department tab has a **Leave a note** box for feedback aimed at the whole department, like "everything looks too clean" in Art. A note goes through four stages:

1. **NEW:** the note waits for an agent in that department.
2. **Picked up:** the next agent that claims a task in that department gets the note. A local agent breaks it into board tasks with `task_dept_note` before starting its own work. A cloud agent lists the tasks in its report, and Ballast adds them to the board.
3. **TASKED:** the note links to each task it produced, showing each task's live status.
4. **ARCHIVED:** once every one of those tasks is done, the note moves to the department's archive.

Notes never stall. If nobody picks a note up within 15 minutes (*Settings*), or whoever picked it up doesn't break it down, Ballast breaks it down itself. **Break down now** does that immediately.

## Director Review (voice)

Press **Director Review** in a game's Feed, play, and talk:
- **While you play:** the browser transcribes as you speak (Chrome or Edge; allow the microphone once). Lines are timestamped, and speech within 10 seconds of the last line joins it. Say **"mark that"**, or press **★ Mark moment**, to flag a spot. You can paste screenshots into the box below at any time. Words caught mid-sentence when the browser restarts recognition are kept. The recording keeps going if you switch tabs, and an unsent review survives a page reload.
- **Fixing it as you go:** click any line to correct a word (Enter or clicking away keeps it; corrected lines show in amber). Press **✕** on a line to leave it out of what gets sent, and **↺** to put it back. Type into the box under the transcript to write a line in at the current time. New speech never merges into a line you've corrected, typed or left out. Set the **accent** picker beside that box to yours (e.g. English (UK) or English (Canada)); the browser's recognizer is noticeably more accurate when it matches.
- **When you're done:** press **Tidy up with Claude** to fix misheard words using the game's own vocabulary and drop filler, keeping timestamps, markers and your meaning. You can undo it. Then **Send to all agents**. It goes out as a Director Review note. Only feedback about the game becomes tasks; remarks about Ballast or testing a feature are ignored.
- **Coordination:** the agent with the **most usage headroom** coordinates it. It reads through the rambling and recognition errors, merges repeated points, and splits the feedback into department-tagged tasks. If the game has a **Coordinator file** (Settings, e.g. `games/looknormal/coordinator.md`), the feedback and breakdown are recorded there first.
- **Claiming:** every agent then claims its next tasks, **2 at a time** by default (*Tasks per claim* in Settings). It works through them in order, and each task closes as soon as it's done.

## Director's Inbox

One place (sidebar) for every question from every agent, on every game and account. An agent asks with `ask_director`, or adds a `## Questions` section to a cloud report. It writes down the assumption it's going with and keeps working. **It never waits.** Your answer goes back to that agent as a message, and it adjusts if your answer differs. *Assumption is fine* closes a question without a reply.

## GDD and delivery schedule

- **GDD.** Track the game design document on claude.ai with the **GDD** role. Every agent treats it as the source of truth. When it changes, the change becomes a note for the team, and triage adds a task to update the GDD when a note changes the design.
- **Delivery.** Set check-ins (e.g. `07:00, 12:00, 17:00`). Every task hand-off tells the agent when the next build is cut. Close to a build, agents land only finished work. The feed gets a heads-up 45 minutes before each one.

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
| `src/review.mjs` | departments, review modes, approve / request changes, auto-approve |
| `src/inbox.mjs` | Director's Inbox |
| `src/git.mjs` | worktree and integration-branch helpers |
| `public/` | the UI (vanilla JS, no build step) |
