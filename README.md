# Ballast

Home base for **author developers**: solo developers making games entirely with AI. Ballast leashes several Claude Code accounts into one game-dev team, and keeps every game you're making, its output, its costs and its audience in one place.

Each Claude account you add becomes an **agent**. Point a **game** at a repo, send it notes (gameplay review, art notes, direction) and every agent working in that repo picks them up. One agent splits each note into tasks on a shared **board**, the agents claim tasks and work them in parallel (each can also spin up its own subagents), and Ballast keeps them going until the board is empty. Run as many games side by side as you like.

No dependencies: Node's standard library and the `claude` CLI you already have.

## Run it

Requirements: Node 20+, git, and Claude Code (`claude --version`).

```bash
node src/server.mjs
```

Or double-click `start-ballast.cmd`. It opens <http://127.0.0.1:4477>. Use a different port with `node src/server.mjs 4500`, or skip opening the browser with `--no-open`.

### Windows installer

Download `BallastSetup.exe` and run it. It installs Ballast for your Windows account only (no admin needed) into `%LOCALAPPDATA%\Programs\Ballast` and adds **Ballast** to the Start menu and desktop.

- It checks for Node.js 20+, Claude Code and git, and offers to install any that are missing (Node and git with `winget`, Claude Code with its official installer). Each one asks first.
- **Ballast** starts it in the background (no console window) and opens your browser. If it's already running, it just opens the browser. **Stop Ballast** closes it.
- Running a newer `BallastSetup.exe` updates Ballast in place. Your data in `~/.ballast` is never touched.
- **Uninstall Ballast** (Start menu, or Settings > Apps) removes the app and shortcuts and keeps your data unless you choose to delete it too.
- The installer isn't code-signed, so Windows SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**.

Build it yourself with `powershell -ExecutionPolicy Bypass -File installer\build.ps1`. It uses Windows' built-in IExpress and writes `installer\dist\BallastSetup.exe`. `installer\test-install.ps1 -TestPort 4491` checks it end to end against temp folders and a throwaway registry key.

## Setup in four steps

A fresh install opens on the **setup guide**, which walks through all of this: it checks this PC (Node, Claude Code, git, the GitHub CLI, Whisper) and shows the command for anything missing, then asks your name and working hours, your Claude accounts and what each plan costs, how you want to review each kind of work, whether new games start with the usage starter rules, phone access, and your first game. Open it again any time from Settings.

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

The **Studio** page (top of the sidebar) is the author developer's home: every game, what it's producing, what it costs, and who it's for.

- **Your output.** Tasks finished this week (against the week before), a 14-day chart with your streak of days with finished work, builds and captures this week, how many games are in development, shipped and archived, and weekly headroom across accounts.
- **Costs.** What your plans cost a month (set each account's price with ✎ on the account; until then Ballast guesses from the plan: Pro $20, Max $100, Team $30), **cost per finished task** over the last 30 days, and the **API value** of Ballast's own runs: what they'd have cost on the API. Cloud sessions aren't metered, so cloud games show no API value.
- **Games.** A card per live game plus a table of every game: status, age (or time to ship), tasks done this week and in total, open tasks, last activity, its **share of your output** over 30 days, its **share of your plan cost** (plans split by share of finished tasks, which is fair to cloud games too), API value, and its top audience from the latest Bartle Audit.
- **Ship, archive, restore.** **Ship** records a release (version, platforms, store page, notes) and marks the game shipped: autopilot and check-in builds stop, but your notes still reach the agents for patches. **+ Release** records each update after that, and **Back to development** turns autopilot on again. **Archive** clears queued work and stops everything; archived games fold away at the bottom of the sidebar, keep their board, feed and stats, and come back with **Restore**.
- **Audiences: Bartle Audit.** Tick the games to audit. Claude reads each one (repo, brief, board) and ranks Bartle's eight player subtypes by how well the game serves them: Planner and Opportunist (Achievers), Scientist and Hacker (Explorers), Networker and Friend (Socialisers), Politician and Griefer (Killers). For the top four you get the evidence in the game, what they'd want more of, a pitch, where to find them, content that lands, and what to say and avoid. Plus a positioning line, a store page draft, comparable games, a launch plan and audience risks. **Copy as Markdown** takes it anywhere. Opus by default, or Sonnet to go lighter on usage. It takes a few minutes per game and runs on the account with the most headroom.

- **Accounts and limits.** Each account shows its **Session** (5-hour) and **Weekly** (7-day) limit, plus any per-model weekly limit, as a percentage with time to reset. The numbers come from Claude's own rate-limit reports, which arrive with every run. Idle accounts get a one-word probe on a small model every 30 minutes (about a fifth of a cent) so the numbers stay current. **Refresh** checks one now.
- **Token usage.** Tokens and cost per account, per game and per day, for every run Ballast makes: agent turns, triage, artifact syncs, limit probes. Usage outside Ballast (claude.ai chats, your own terminal sessions) counts toward the limits above but not toward these totals. So do cloud sessions: their tokens aren't reported back.
- **Usage reports.** During your **working hours** (Settings: default 09:00 to 18:00, Monday to Friday), every account reports its session and weekly limit, time to reset and today's tokens **every 90 minutes**. Stale numbers are refreshed first. Reports show on the Studio page with their history, **Report now** runs one immediately, and an optional Slack or Discord webhook gets each one. Background limit checks only run during working hours.
- **Limit-aware routing.** Work goes to the agents whose accounts have the most headroom. Autopilot stops handing work to an account above 95% of either limit (configurable). Your own messages still go through.
- **Game cards.** Every game's agents, board counts, last build and next check-in. You can **Pause** a game, which frees its accounts for other games, and set its **priority**, which decides who gets account time first when accounts are busy.
- **Note to several games.** One note, triaged separately onto each ticked game's board.

### Daily digest and weekly report

- **Daily digest**, at the start of your working day (or **Digest now**): per game, what finished since the last one, what's blocked and why, what's waiting for you (reviews, Inbox questions), builds, and each account's session and weekly usage. No Claude run; it's just your numbers.
- **Weekly report**, every Friday at 16:00 by default (Settings) or **Write this week's report**: for each game with finished work, Claude writes a devlog for players, 3-5 social posts for named channels, clips worth capturing, and what's coming next. Posts are aimed at the audiences and channels from the game's Bartle Audit. Copy one post or the whole report.
- Both appear on the Studio page and go to the report webhook if you set one. A Discord channel webhook is the easy way to get them as phone notifications.

### Playtesters on Discord

Players' feedback in your Discord becomes notes for the game's team. Settings → **Discord**: create a bot in the Discord Developer Portal, turn on its *Message Content Intent*, paste its token (stored on this PC only), and add it to your server with the link Ballast gives you. Then in each game's Settings → **Playtesters**, pick its channels. Ballast reads them every minute and reacts ✅ to each message it picks up. It gathers new messages for 15 minutes (or 25 messages) and sends them as one note labelled as playtester feedback, so agents weigh issues several players raise over one-off opinions. It starts from the newest message, so old chatter isn't fed in. Nothing is hosted: Ballast polls Discord from this PC.

### Ballast on your phone

Settings → **Phone** (or the setup guide). Ballast keeps running on this PC and your phone opens it, with no server and no cloud bill:

- **On my home Wi-Fi**: Ballast also listens on this PC's home-network address (port 4479).
- **Anywhere, through Tailscale**: install [Tailscale](https://tailscale.com/download) (free) on the PC and phone. Ballast listens on its private address, encrypted end to end.
- Open the address it shows on your phone and type the 6-digit **pairing code** (good for one phone, 15 minutes, 5 tries). Each paired phone gets its own key you can remove. Agent endpoints never leave this PC. Windows may ask once whether Node.js can use private networks; allow it.
- The layout fits a phone (the sidebar becomes a ☰ drawer), and *Add to Home Screen* installs it like an app.

### Per-game usage cap and rules

Your games share the same few accounts, so each game decides how far into them it may go (game **Settings → Usage limits & rules**):

- **Stop at** caps the game at a percentage of an account's session or weekly limit. Past it, the game's agents on that account stop taking work and show **held by usage rules**. Messages you send to one agent still go through. Work picks up again when the limit resets.
- **Rules** change how agents work as an account fills up: *when session / weekly / either is over N%*, then one of: claim one task at a time, no delegate chats or subagents, switch to Sonnet or Haiku, lower effort, finish claimed tasks and claim nothing new, tell the agents something in your own words, tell me (feed and report webhook), or stop. **Add a prefilled rule** offers ready-made ones, and **Add the starter set** adds six that stretch an account across the week (one task at a time over 60% session, Sonnet over 70% weekly, a "keep it small" instruction over 75% weekly, no fan-out over 80% session, no new claims over 85% weekly, tell me over 90%).
- Rules are checked before every turn against that agent's own account; the feed notes each time the set in force changes. Model and effort rules apply to agents on this PC (cloud sessions choose their own model); the rest apply to cloud agents too.

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

## Task priority

Every task is **Urgent**, **High**, **Normal** (the default) or **Low**. On the Board, **▲ / ▼** on a card promotes or demotes it one step (or set it in Edit), and each column lists the highest priority first.

Priority decides what gets picked up next. Cloud agents are handed tasks by Ballast, highest priority first, ahead of role fit; tasks assigned to an agent still come first for that agent. Agents on this PC see the board sorted by priority with URGENT, high and low tags, and are told to take urgent work first and low only when nothing else fits. Promoting a task to Urgent wakes idle agents straight away.

## Blocked tickets triage themselves

When a ticket blocks (an agent gives it back, a cloud session reports BLOCKED or goes quiet), Claude triages it within a minute on the account with the most weekly room. It reads the ticket and the code it touches, and decides:

- **Retry**: an agent can still do it another way (a workaround, a simulation, a smaller version). The ticket is rewritten with that approach and goes back on the board. A ticket can retry itself twice; after that it has to go to a person.
- **Split**: part of it can go ahead now. This ticket becomes that part and goes back on the board; the rest becomes its own ticket waiting on a person.
- **Human**: only a person can unblock it: a device, an account or sign-in, a service or environment setting, a payment, your voice, or your call. It gets a **🙋 NEEDS YOU** tag and a Human Intervention request at the top of the Director's Inbox, with:
  - exactly what to do, as numbered steps with real names, URLs and values, how long it takes, and how you'll know it worked;
  - who can do it: only you, or **you or a Cowork Claude**. For the second, it lists exactly what the Cowork Claude needs your authorization to do (which site, which account, which setting, read or write), and **Copy the Cowork brief** gives you a paste-ready brief for it;
  - which tickets it's holding. One request can hold several tickets (one network allowlist, one headset); triage attaches new blocks to an open request when they need the same thing.
- **Obsolete**: it looks like it's no longer needed. You're asked to confirm closing it.

Press **Done** when you (or the Cowork Claude) have done it, with an optional note for the agent: every ticket waiting on it goes back on the board with your note. **Dismiss** leaves them blocked and stops asking. Open requests count toward the Inbox badge and appear in the daily digest. Blocked tickets also have a **Triage** button to run it again, and you can turn self-triage off in Settings.

## Talking a ticket through

Any ticket on the Board can carry its own conversation with Claude. Blocked tickets get a **Work it out with Claude** button (it starts you off with the agent's reason for blocking); every other ticket has **💬 Discuss**, and the button shows how many messages a ticket's conversation has.

- Each message is answered by the account with the most weekly room. It sees the ticket (detail, block reason, what the agent reported), the game's brief, board and roadmap, and reads the repo before suggesting anything. It lays out the options with their tradeoffs, recommends one, and asks you only about things that are your call. It changes nothing.
- When you've decided, press **Update the ticket**. Claude drafts the rewritten ticket from the conversation: a new title and a self-contained detail with the approach you agreed on, a priority, and what happens next: back on the board for an agent, keep it as it is, or close it as no longer needed. If you didn't reach a decision, the draft says so.
- Edit anything and **Apply**. The ticket is updated, the decision is noted on it and in the feed, and a blocked ticket going back on the board is unblocked. If an agent is working on it right now, Ballast can tell that agent straight away, since it won't reread the ticket mid-task.
- The conversation stays with the ticket, so you can come back to it.

## Asking Claude (conversation mode)

Sometimes you just need an answer. Press **💬 Ask Claude** in a game's Feed composer to switch it to conversation mode: what you type goes to Claude as a question instead of to the agents as a note.

- Each question goes to the logged-in account with the most **weekly** room right now (the session limit breaks ties). The composer shows which one, and how much of its week is left.
- It reads the game's files and can search the web, but changes nothing. It also knows the game's brief, board, roadmap progress and your latest notes, so you can ask "why does the mob trigger here?" or "what's left for the first playable?".
- Follow-ups work: your recent questions and answers go along with each new one, whichever account answers. **New conversation** starts fresh.
- Answers stream into the feed. Agents never see them. **Send to team** turns one into a note for every agent, which you can edit first. Screenshots you paste go along with the question.
- Toggle it off to go back to sending notes. Ballast remembers the mode.

## Director Review (voice)

Press **Director Review** in a game's Feed, play, and talk:
- **While you play:** the browser transcribes as you speak (Chrome or Edge; allow the microphone once). Lines are timestamped, and speech within 10 seconds of the last line joins it. Say **"mark that"**, or press **★ Mark moment**, to flag a spot. You can paste screenshots into the box below at any time. Words caught mid-sentence when the browser restarts recognition are kept. The recording keeps going if you switch tabs, and an unsent review survives a page reload.
- **Whisper (on this PC):** when local Whisper is installed, it writes the transcript instead of the browser. Ballast records the mic, cuts it into phrases at pauses and has [whisper.cpp](https://github.com/ggml-org/whisper.cpp) transcribe each one on your GPU. Each phrase is primed with the game's name, recent board task titles and the line before, so names come out right. Lines land a moment after you finish a phrase; the grey words while you talk are Chrome's live preview. Audio never leaves the PC. Ballast starts `whisper-server` (port 4478) when a review starts and stops it after 15 idle minutes to free GPU memory. Switch to **Chrome** in the engine picker under the transcript if you need to.
  Install: put a whisper.cpp Windows build in `~/.ballast/whisper/bin/` (the `cuda-12.4.0` one for NVIDIA GPUs; the CUDA 11.8 build lacks cuBLAS and falls back to the CPU) and one `ggml-*.bin` model in `~/.ballast/whisper/models/` (`ggml-large-v3-turbo-q8_0.bin` is the default). The server log is `~/.ballast/whisper/server.log`.
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
- **Connect once per agent.** Claude Code only creates a cloud session from an interactive terminal, so each cloud agent gets one session that it keeps. Agent → **Connect cloud session** opens a terminal running `claude --cloud` under each agent's account, one after another. On Windows the terminal reads each session link (`https://claude.ai/code/session_…`) off its own screen and hands it to Ballast, so there's nothing to paste; it only asks you to paste if it can't find one. On macOS and Linux you paste each link into the terminal. A session you start yourself on claude.ai/code for the repo works too.
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

### Playing a build

Every build offers what its output supports, and the game header has **▶ Play latest**:

- **Web builds** (an `index.html` anywhere in the output) open from a local play server at `http://localhost:4480`. It's a separate origin from Ballast, sends the cross-origin isolation headers threaded Godot and Unity web exports need, serves Unity's pre-compressed `.gz`/`.br` files, and counts as secure, so WebXR works in a desktop browser.
- **Windows builds** (`.exe`) start with **▶ Run**.
- **Android builds** (`.apk`) go to a Quest plugged in by USB with **Install on Quest**. Needs `adb`, which comes with Meta Quest Developer Hub (or set its path as `adbPath`). Ballast tells you if no headset is found or USB debugging hasn't been accepted in the headset.
- **Upload to itch.io** pushes the build with [butler](https://itch.io/docs/butler/) to the itch.io page set in the game's Settings (`yourname/your-game`): web builds to the `html5` channel, `.exe` to `windows`, `.apk` to `android`. Install butler and run `butler login` once.

## Roadmap: GDD features, L0-L3 quality levels, milestones

The **Roadmap** tab turns the GDD into a plan. **Break down the GDD** has Claude read the design docs in the repo (and a claude.ai GDD you track) plus the board, and split the game into features. Each feature gets four quality levels, with what "done" means at each and the tasks to get there:

| Level | Means |
|---|---|
| **L0 Greybox** | Placeholder art and logic that proves the idea is fun. |
| **L1 Functional** | Works end to end with real rules; rough edges and placeholder content are fine. |
| **L2 Polished** | Feels good: tuned, juicy, target-quality art and audio. |
| **L3 Ship** | Performance, edge cases, accessibility and final content: ready for players. |

- **Milestones** are features at a level: *First playable* (core features at L1, the rest at L0), *Vertical slice* (core L2, rest L1), *Content complete* (all L2) and *Launch* (all L3). Change the levels per milestone, mark which features are core, or add your own milestones (a festival demo, say).
- **Automatic backlog.** For the current milestone, Ballast puts the next level's tasks for each feature on the board, one level at a time. When all of a feature's tasks for a level are done, it reaches that level and the next level's tasks go up. When every feature reaches the milestone's targets, the milestone closes and the next one starts.
- **Forecast.** Each milestone shows progress, features already there, tasks left (open ones plus planned ones for levels not on the board yet) and a date at the game's own pace over the last 14 days (30 if it's been quiet).
- Re-running the breakdown keeps your core flags and reached levels. If it misjudged how far a feature is, set its level in the feature's details.

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
| `src/policy.mjs` | per-game usage cap and rules, and their presets |
| `src/audits.mjs` | Bartle Audit: audience ranking and marketing plan per game |
| `src/whisper.mjs` | local Whisper server for Director Review |
| `src/roadmap.mjs` | GDD breakdown, L0-L3 levels, milestones, backlog, forecasts |
| `src/play.mjs` | play server for web builds, run/Quest install/itch.io upload |
| `src/digest.mjs` | daily digest and weekly devlog report |
| `src/discord.mjs` | Discord playtest channels to game notes |
| `src/phone.mjs` | phone access: home network / Tailscale listener and pairing |
| `src/setup.mjs` | setup guide checks |
| `src/ask.mjs` | conversation mode: questions answered by the account with the most weekly room |
| `src/threads.mjs` | ticket conversations, and rewriting a ticket from what was decided |
| `src/unblock.mjs` | blocked-ticket self-triage and Human Intervention requests |
| `installer/` | Windows installer (IExpress): build, install, launch, uninstall, tests |
| `src/cloud.mjs` | claude.ai artifact sync and review routing |
| `src/remote.mjs` | cloud games: triage, cloud sessions, GitHub report polling |
| `src/review.mjs` | departments, review modes, approve / request changes, auto-approve |
| `src/inbox.mjs` | Director's Inbox |
| `src/git.mjs` | worktree and integration-branch helpers |
| `public/` | the UI (vanilla JS, no build step) |
